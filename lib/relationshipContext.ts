import type { WikiConnectionContext, WikiRelationship } from '@/types/graph';

interface ContextSection {
  title: string;
  content: string;
  isLead: boolean;
}

const NON_ARTICLE_SECTIONS = /^(?:references|notes|further reading|external links|bibliography|sources|citations|works cited|notes and references)$/i;
const MAX_EVIDENCE_LENGTH = 480;

function normalizeTitle(title: string): string {
  return title.replace(/_/g, ' ').split('#')[0].trim().toLocaleLowerCase();
}

function removeTemplates(text: string): string {
  let output = '';
  let depth = 0;

  for (let index = 0; index < text.length; index += 1) {
    if (text.startsWith('{{', index)) {
      depth += 1;
      index += 1;
    } else if (text.startsWith('}}', index) && depth > 0) {
      depth -= 1;
      index += 1;
    } else if (depth === 0) {
      output += text[index];
    }
  }

  return output;
}

function removeNonProse(wikitext: string): string {
  return removeTemplates(wikitext
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<ref\b[^>]*\/\s*>|<ref\b[^>]*>[\s\S]*?<\/ref\s*>/gi, ' '));
}

function plainText(wikitext: string): string {
  return removeNonProse(wikitext)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\[\[([^[\]]+)\]\]/g, (_match, link: string) => {
      const [target, label] = link.split('|', 2);
      return (label ?? target).split('#')[0].replace(/_/g, ' ');
    })
    .replace(/\[(?:https?:\/\/\S+)\s+([^\]]+)\]/gi, '$1')
    .replace(/'{2,5}/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function getSections(wikitext: string): ContextSection[] {
  const sections: ContextSection[] = [];
  let title = 'Introduction';
  let content = '';
  let isLead = true;

  const saveSection = () => {
    if (content.trim()) sections.push({ title, content, isLead });
    content = '';
  };

  for (const line of wikitext.split(/\r?\n/)) {
    const heading = line.match(/^(={2,6})\s*(.*?)\s*\1\s*$/);
    if (heading) {
      saveSection();
      title = plainText(heading[2]) || 'Article';
      isLead = false;
    } else {
      content += `${line}\n`;
    }
  }

  saveSection();
  return sections;
}

function getConnectionContext(section: ContextSection): WikiConnectionContext | null {
  if (section.isLead) return 'lead';
  if (/^see also$/i.test(section.title.trim())) return 'see_also';
  if (NON_ARTICLE_SECTIONS.test(section.title)) return null;
  return 'article';
}

function findEvidence(
  wikitext: string,
  target: string,
): {
  evidence: string | null;
  section: string;
  targetLabel: string;
  context: WikiConnectionContext;
} | null {
  const normalizedTarget = normalizeTitle(target);
  let seeAlsoContext: ReturnType<typeof findEvidence> = null;

  for (const section of getSections(wikitext)) {
    const contextType = getConnectionContext(section);
    if (!contextType) continue;

    for (const paragraph of section.content.split(/\n\s*\n/)) {
      if (paragraph.includes('{|')) continue;
      const proseWikitext = removeNonProse(paragraph);
      const targetLinks = [...proseWikitext.matchAll(/\[\[([^[\]]+)\]\]/g)].filter((match) => {
        const [linkedTitle] = (match[1] ?? '').split('|', 1);
        return normalizeTitle(linkedTitle ?? '') === normalizedTarget;
      });
      if (targetLinks.length === 0) continue;

      const text = plainText(proseWikitext);
      const linkParts = (targetLinks[0]?.[1] ?? '').split('|', 2);
      const linkLabel = (linkParts[1] ?? linkParts[0] ?? '')
        .split('#')[0]
        .replace(/_/g, ' ');
      const mention = linkLabel ? text.toLocaleLowerCase().indexOf(linkLabel.toLocaleLowerCase()) : -1;
      let sentence = text;

      if (mention >= 0) {
        const sentenceBoundaries = [...text.matchAll(/[.!?](?=\s+[A-Z0-9"'(])/g)]
          .map((boundary) => boundary.index ?? -1)
          .filter((index) => index >= 0);
        const previousBoundary = sentenceBoundaries.filter((index) => index < mention).at(-1);
        const nextBoundary = sentenceBoundaries.find((index) => index >= mention);
        const sentenceStart = previousBoundary === undefined ? 0 : previousBoundary + 1;
        const sentenceEnd = nextBoundary === undefined ? text.length : nextBoundary + 1;
        sentence = text.slice(sentenceStart, sentenceEnd).trim();
      }

      if (sentence.length > MAX_EVIDENCE_LENGTH) {
        sentence = `${sentence.slice(0, MAX_EVIDENCE_LENGTH - 1).trimEnd()}…`;
      }
      if (!sentence) continue;

      if (contextType === 'see_also') {
        const relation = inferRelation(sentence, linkLabel);
        const evidence = relation === 'Related to' ? null : sentence;
        if (!seeAlsoContext || (!seeAlsoContext.evidence && evidence)) {
          seeAlsoContext = {
            evidence,
            section: section.title,
            targetLabel: linkLabel,
            context: contextType,
          };
        }
        continue;
      }

      return {
        evidence: sentence,
        section: contextType === 'lead' ? 'Lead' : section.title,
        targetLabel: linkLabel,
        context: contextType,
      };
    }
  }

  return seeAlsoContext;
}

const RELATION_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\b(?:was\s+)?born\s+in\b/i, label: 'was born in' },
  { pattern: /\bgraduat(?:ed|ing|es)\s+from\b/i, label: 'graduated from' },
  { pattern: /\bstud(?:ied|ies|ying)\s+at\b/i, label: 'studied at' },
  { pattern: /\bwork(?:ed|s|ing)\s+at\b/i, label: 'worked at' },
  { pattern: /\bwork(?:ed|s|ing)\s+with\b/i, label: 'worked with' },
  { pattern: /\bwork(?:ed|s|ing)\s+for\b/i, label: 'worked for' },
  { pattern: /\bmember\s+of\b/i, label: 'was a member of' },
  { pattern: /\bcapital\s+of\b/i, label: 'is the capital of' },
  { pattern: /\blocated\s+in\b/i, label: 'is located in' },
  { pattern: /\bbased\s+in\b/i, label: 'is based in' },
  { pattern: /\bbased\s+on\b/i, label: 'is based on' },
  { pattern: /\bknown\s+for\b/i, label: 'is known for' },
  { pattern: /\bnamed\s+after\b/i, label: 'was named after' },
  { pattern: /\bcollaborat(?:ed|es|ing)\s+with\b/i, label: 'collaborated with' },
  { pattern: /\binfluenc(?:ed|es|ing)\b/i, label: 'influenced' },
  { pattern: /\binspir(?:ed|es|ing)\b/i, label: 'inspired' },
  { pattern: /\bdevelop(?:ed|s|ing)\b/i, label: 'developed' },
  { pattern: /\bformulat(?:ed|es|ing)\b/i, label: 'formulated' },
  { pattern: /\bpropos(?:ed|es|ing)\b/i, label: 'proposed' },
  { pattern: /\bdiscover(?:ed|s|ing)\b/i, label: 'discovered' },
  { pattern: /\binvent(?:ed|s|ing)\b/i, label: 'invented' },
  { pattern: /\bfound(?:ed|s|ing)\b/i, label: 'founded' },
  { pattern: /\bestablish(?:ed|es|ing)\b/i, label: 'established' },
  { pattern: /\bcreat(?:ed|es|ing)\b/i, label: 'created' },
  { pattern: /\bdesign(?:ed|s|ing)\b/i, label: 'designed' },
  { pattern: /\bintroduc(?:ed|es|ing)\b/i, label: 'introduced' },
  { pattern: /\bdefin(?:ed|es|ing)\b/i, label: 'defined' },
  { pattern: /\bcompos(?:ed|es|ing)\b/i, label: 'composed' },
  { pattern: /\btranslat(?:ed|es|ing)\b/i, label: 'translated' },
  { pattern: /\bauthor(?:ed|s|ing)\b/i, label: 'authored' },
  { pattern: /\bwrot(?:e|es|ing)\b/i, label: 'wrote' },
];

function inferRelation(evidence: string, targetLabel: string): string {
  const targetIndex = evidence.toLocaleLowerCase().indexOf(targetLabel.toLocaleLowerCase());
  if (targetIndex < 0) return 'Related to';

  const candidates = RELATION_PATTERNS.flatMap(({ pattern, label }) => {
    const match = pattern.exec(evidence);
    if (!match || match.index === undefined) return [];
    const targetEnd = targetIndex + targetLabel.length;
    const isBeforeTarget = match.index <= targetIndex;
    const distance = isBeforeTarget ? targetIndex - match.index : match.index - targetEnd;
    const passiveClause = evidence.slice(targetEnd, match.index);
    const followsPassiveTarget = !isBeforeTarget
      && /\b(?:is|are|was|were|has been|have been|had been)\b(?:\s+\w+){0,3}\s*$/i.test(passiveClause);
    return distance <= 90 && (isBeforeTarget || followsPassiveTarget) ? [{ label, distance }] : [];
  }).sort((left, right) => left.distance - right.distance);

  return candidates[0]?.label ?? 'Related to';
}

export function interpretWikiLinkContext(
  source: string,
  target: string,
  wikitext: string,
): WikiRelationship {
  const context = findEvidence(wikitext, target);
  const relation = context?.evidence
    ? inferRelation(context.evidence, context.targetLabel)
    : 'Related to';
  const explanation = relation === 'Related to' && context?.context === 'see_also'
    ? 'Wikipedia lists this topic as a related topic.'
    : relation === 'Related to'
      ? `Wikipedia links ${source} to ${target}, but the surrounding context does not support a more specific relationship.`
    : `WikiCrawl interprets the passage as: ${source} ${relation} ${target}.`;

  return {
    source,
    target,
    relation,
    context: context?.context ?? null,
    explanation,
    evidence: context?.evidence ?? null,
    section: context?.section ?? null,
    sourceUrl: `https://en.wikipedia.org/wiki/${encodeURIComponent(source.replace(/ /g, '_'))}`,
    sourceContextFound: Boolean(context),
  };
}

import { describe, expect, it } from 'vitest';
import { interpretWikiLinkContext } from './relationshipContext';

describe('interpretWikiLinkContext', () => {
  it('uses the source passage to identify a specific relationship', () => {
    const result = interpretWikiLinkContext(
      'Albert Einstein',
      'Theory of relativity',
      `'''Albert Einstein''' was a physicist who developed the [[Theory of relativity]].

== Legacy ==
He received many awards.`,
    );

    expect(result.relation).toBe('developed');
    expect(result.evidence).toBe('Albert Einstein was a physicist who developed the Theory of relativity.');
    expect(result.section).toBe('Lead');
    expect(result.context).toBe('lead');
    expect(result.sourceContextFound).toBe(true);
    expect(result.explanation).toContain('WikiCrawl interprets');
  });

  it('keeps the relationship generic when the passage does not support a known relation', () => {
    const result = interpretWikiLinkContext(
      'Ada Lovelace',
      'Charles Babbage',
      'Ada Lovelace corresponded with [[Charles Babbage]] about the analytical engine.',
    );

    expect(result.relation).toBe('Related to');
    expect(result.explanation).toContain('does not support a more specific relationship');
    expect(result.evidence).toContain('corresponded with Charles Babbage');
  });

  it('recognizes a piped-link alias and passive relationship wording', () => {
    const result = interpretWikiLinkContext(
      'Albert Einstein',
      'Theory of relativity',
      'The [[Theory of relativity|scientific theory]] was developed by Albert Einstein.',
    );

    expect(result.relation).toBe('developed');
    expect(result.evidence).toBe('The scientific theory was developed by Albert Einstein.');
  });

  it('does not attribute a nearby later verb to an earlier link', () => {
    const result = interpretWikiLinkContext(
      'Example',
      'Target page',
      'The [[Target page]] was mentioned before she later developed a separate tool.',
    );

    expect(result.relation).toBe('Related to');
  });

  it('includes section context and skips reference-only links', () => {
    const result = interpretWikiLinkContext(
      'Example',
      'Target page',
      `== Work ==
She proposed [[Target page]] as a solution.

== References ==
* [[Target page]]`,
    );

    expect(result.section).toBe('Work');
    expect(result.context).toBe('article');
    expect(result.relation).toBe('proposed');
  });

  it('classifies a See also listing without inventing a detailed relationship', () => {
    const result = interpretWikiLinkContext(
      'Example',
      'Target page',
      '== See also ==\n* [[Target page]]',
    );

    expect(result.context).toBe('see_also');
    expect(result.section).toBe('See also');
    expect(result.relation).toBe('Related to');
    expect(result.explanation).toBe('Wikipedia lists this topic as a related topic.');
    expect(result.evidence).toBeNull();
  });

  it('prefers article prose when a link also appears in See also', () => {
    const result = interpretWikiLinkContext(
      'Example',
      'Target page',
      '== History ==\nThe page was founded by the [[Target page]].\n\n== See also ==\n* [[Target page]]',
    );

    expect(result.context).toBe('article');
    expect(result.relation).toBe('founded');
    expect(result.evidence).toContain('founded by the Target page');
  });

  it('can use explicit prose under See also when it supports a specific relationship', () => {
    const result = interpretWikiLinkContext(
      'Example',
      'Target page',
      '== See also ==\nExample developed [[Target page]] as an approach.',
    );

    expect(result.context).toBe('see_also');
    expect(result.relation).toBe('developed');
    expect(result.evidence).toContain('developed Target page');
  });

  it('does not confuse an article section named Introduction with the lead', () => {
    const result = interpretWikiLinkContext(
      'Example',
      'Target page',
      '== Introduction ==\nThis section mentions [[Target page]].',
    );

    expect(result.context).toBe('article');
  });

  it('returns a generic relationship when no supporting passage is found', () => {
    const result = interpretWikiLinkContext('Source', 'Target', 'No linked page appears here.');

    expect(result.relation).toBe('Related to');
    expect(result.evidence).toBeNull();
    expect(result.section).toBeNull();
    expect(result.sourceContextFound).toBe(false);
  });

  it('does not treat links inside references or metadata templates as source passages', () => {
    const result = interpretWikiLinkContext(
      'Example',
      'Target page',
      '<ref>[[Target page]]</ref>\n{{Infobox|topic=[[Target page]]}}',
    );

    expect(result.relation).toBe('Related to');
    expect(result.evidence).toBeNull();
    expect(result.sourceContextFound).toBe(false);
  });
});

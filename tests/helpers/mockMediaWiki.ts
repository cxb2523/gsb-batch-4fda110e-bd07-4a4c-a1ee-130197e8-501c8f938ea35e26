export type MockMediaWikiMode = 'default' | 'topical' | 'alphabetical';

export interface MockMediaWikiStats {
  requests: number;
  linkRowsDownloaded: number;
  pageviewRequests: number;
  pageviewLatencyMs: number;
}

export interface MockMediaWikiOptions {
  mode?: MockMediaWikiMode;
  pageviews?: Record<string, number>;
  pageviewsFail?: boolean;
  pageviewLatencyMs?: number;
}

export interface MockMediaWikiHandle {
  stats: MockMediaWikiStats;
  restore: () => void;
}

const LINKS_PER_REQUEST = 500;

function normalizeTitle(title: string): string {
  return title.replace(/_/g, ' ').trim();
}

function pageNumber(title: string): number | null {
  const match = normalizeTitle(title).match(/^(?:Page|Redirect) (\d+)$/);
  return match ? Number(match[1]) : null;
}

function isKnownPage(title: string): boolean {
  return pageNumber(title) !== null;
}

function alphabeticalLinks(title: string): string[] {
  if (normalizeTitle(title) === 'Page 0') {
    return Array.from({ length: 400 }, (_, index) => `Article ${String.fromCharCode(65 + Math.floor(index / 16))}${String(index).padStart(3, '0')}`);
  }
  return Array.from({ length: 8 }, (_, index) => `Depth topic ${index}`);
}

function canonicalTitle(title: string): string {
  const normalized = normalizeTitle(title);
  return normalized.replace(/^Redirect /, 'Page ');
}

function defaultLinks(title: string): string[] {
  const number = pageNumber(canonicalTitle(title)) ?? 0;
  const count = number === 0 ? 650 : 120;
  return Array.from({ length: count }, (_, index) => `${index === 0 ? 'Redirect' : 'Page'} ${number + (index === 0 ? 1 : index)}`)
    .sort((left, right) => left.localeCompare(right));
}

function topicalLinks(title: string): string[] {
  const number = pageNumber(canonicalTitle(title)) ?? 0;
  const cluster = number % 4;
  return Array.from({ length: 120 }, (_, index) => {
    const offset = index % 5 === 0 ? index + 1 : cluster * 30 + index;
    return `Page ${offset}`;
  }).filter((link, index, links) => links.indexOf(link) === index)
    .sort((left, right) => left.localeCompare(right));
}

function continuationOffset(token: string | null): number {
  if (!token) return 0;

  const parts = token.split('|');
  const offset = Number(parts.at(-1));

  return Number.isFinite(offset) ? offset : 0;
}

function makeContinuationToken(title: string, offset: number): string {
  const pageId = pageNumber(canonicalTitle(title)) ?? 0;

  // Synthetic token that mirrors the important property of
  // MediaWiki's real plcontinue: the page id is identifiable.
  return `${pageId}|0|${offset}`;
}

function responseFor(
  titles: string[],
  offset: number,
  mode: MockMediaWikiMode,
  stats: MockMediaWikiStats,
): Response {
  const pages = titles
    .map((title) => {
      const normalizedTitle = normalizeTitle(title);
      if (mode !== 'alphabetical' && !isKnownPage(normalizedTitle)) {
        return { title: normalizedTitle, missing: true };
      }
      const canonical = canonicalTitle(normalizedTitle);
      const links = mode === 'topical' ? topicalLinks(canonical) : mode === 'alphabetical' ? alphabeticalLinks(canonical) : defaultLinks(canonical);
      const pageLinks = links.slice(offset, offset + LINKS_PER_REQUEST);
      stats.linkRowsDownloaded += pageLinks.length;
      return {
        pageid: pageNumber(normalizedTitle) ?? titles.indexOf(title) + 1,
        title: canonical,
        links: pageLinks.map((link) => ({ title: link })),
      };
    })
    .sort((left, right) => left.title.localeCompare(right.title));

  const hasMore = titles.some((title) => {
    if (mode !== 'alphabetical' && !isKnownPage(title)) return false;
    const links = mode === 'topical' ? topicalLinks(canonicalTitle(title)) : mode === 'alphabetical' ? alphabeticalLinks(canonicalTitle(title)) : defaultLinks(canonicalTitle(title));
    return offset + LINKS_PER_REQUEST < links.length;
  });

  return Response.json({
    query: {
      pages,
      redirects: titles.filter((title) => /^Redirect \d+$/.test(normalizeTitle(title)))
        .map((title) => ({ from: normalizeTitle(title), to: canonicalTitle(title) })),
    },
    ...(hasMore
  ? {
      continue: {
        plcontinue: makeContinuationToken(
          titles.find((title) => {
            const links = mode === 'topical'
              ? topicalLinks(canonicalTitle(title))
              : mode === 'alphabetical'
                ? alphabeticalLinks(canonicalTitle(title))
                : defaultLinks(canonicalTitle(title));

            return offset + LINKS_PER_REQUEST < links.length;
          }) ?? titles[0],
          offset + LINKS_PER_REQUEST,
        ),
      },
    }
  : {}),
  });
}

export function installMockMediaWiki(options: MockMediaWikiOptions = {}): MockMediaWikiHandle {
  const mode = options.mode ?? 'default';
  const stats: MockMediaWikiStats = { requests: 0, linkRowsDownloaded: 0, pageviewRequests: 0, pageviewLatencyMs: options.pageviewLatencyMs ?? 0 };
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(input.toString());
    const action = url.searchParams.get('action');

    stats.requests += 1;

    if (action === 'opensearch') {
      const search = url.searchParams.get('search') || 'Page 0';
      return Response.json([search, ['Page 0', 'Page 1'], ['Synthetic page'], ['https://example.test/Page_0']]);
    }

    if (action === 'query' && url.searchParams.get('prop') === 'pageviews') {
      stats.pageviewRequests += 1;
      if (options.pageviewLatencyMs) {
        await new Promise((resolve) => setTimeout(resolve, options.pageviewLatencyMs));
      }
      if (options.pageviewsFail) return new Response('failed', { status: 503 });
      const configuredViews = options.pageviews ?? {};
      const titles = (url.searchParams.get('titles') || '').split('|').filter(Boolean);
      return Response.json({
        query: {
          pages: titles.map((title) => ({
            title,
            pageviews: Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`2026${String(index + 1).padStart(2, '0')}01`, configuredViews[title] ?? 0])),
          })),
        },
      });
    }

    if (action !== 'query' || url.searchParams.get('prop') !== 'links') {
      return Response.json({ query: { pages: {} } });
    }

    const titles = (url.searchParams.get('titles') || '').split('|').filter(Boolean);
    const continueToken = url.searchParams.get('plcontinue');
    const offset = continuationOffset(continueToken);

    return responseFor(titles, offset, mode, stats);
  };

  return {
    stats,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}
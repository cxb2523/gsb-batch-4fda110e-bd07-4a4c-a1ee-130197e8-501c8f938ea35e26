import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installMockMediaWiki } from './helpers/mockMediaWiki';

const pageCache = vi.hoisted(() => new Map<string, { title: string; resolvedTitle: string; links: string[]; complete: boolean }>());
const pageViewCache = vi.hoisted(() => new Map<string, number>());

vi.mock('../lib/db', () => ({
  getCachedPageLinks: vi.fn((title: string) => pageCache.get(title.toLowerCase()) ?? null),
  setCachedPageLinks: vi.fn((page: { title: string; resolvedTitle: string; links: string[]; complete: boolean }) => {
    pageCache.set(page.title.toLowerCase(), page);
  }),
  getCachedPageViews: vi.fn((title: string) => pageViewCache.get(title.toLowerCase()) ?? null),
  setCachedPageViews: vi.fn((title: string, views: number) => pageViewCache.set(title.toLowerCase(), views)),
  getCachedRelationship: vi.fn(() => null),
  setCachedRelationship: vi.fn(),
}));

import { crawlWikipedia, getCrawlRequestBudget } from '../lib/crawler';
import {
  getPageLinksBatch,
  type PageLinksAccumulatedPage,
} from '../lib/wikipedia';
import { getCachedPageLinks, setCachedPageLinks } from '../lib/db';

describe('offline crawler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pageCache.clear();
    pageViewCache.clear();
  });

  it('crawls a small graph with bounded nodes, unique edges, and depth metadata', async () => {
    const mock = installMockMediaWiki();
    const progress: Array<{ done: number; target: number }> = [];

    try {
      const result = await crawlWikipedia({
        seedTitle: 'Page 0',
        depth: 2,
        maxNodes: 20,
        onProgress: (update) => progress.push(update),
      });

      expect(result.nodes.length).toBeGreaterThan(0);
      expect(result.nodes.length).toBeLessThanOrEqual(28);
      expect(result.edges.length).toBeGreaterThan(0);
      expect(new Set(result.nodes.map((node) => node.id)).size).toBe(result.nodes.length);
      expect(new Set(result.edges.map((edge) => `${edge.source}|${edge.target}`)).size)
        .toBe(result.edges.length);
      for (const node of result.nodes) {
        expect(node.outDegree).toBe(result.edges.filter((edge) => edge.source === node.id).length);
        expect(node.inDegree).toBe(result.edges.filter((edge) => edge.target === node.id).length);
      }
      expect(result.nodes.every((node) => node.depth >= 0 && node.depth <= 2)).toBe(true);
      expect(result.nodes.find((node) => node.id === 'Page 0')?.depth).toBe(0);
      expect(progress.length).toBeGreaterThanOrEqual(result.nodes.length);
      expect(progress.slice(0, result.nodes.length).map(({ done }) => done)).toEqual(
        Array.from({ length: result.nodes.length }, (_, index) => index + 1),
      );
      expect(progress.every(({ target }) => target >= 1)).toBe(true);
      expect(mock.stats.requests).toBeGreaterThan(0);
    } finally {
      mock.restore();
    }
  });

  it('reports monotonic varied progress through a large crawl', async () => {
    const mock = installMockMediaWiki();
    const progress: Array<{ done: number; target: number }> = [];

    try {
      await crawlWikipedia({
        seedTitle: 'Page 0',
        depth: 3,
        maxNodes: 500,
        onProgress: (update) => progress.push(update),
      });

      const ratios = progress.map(({ done, target }) => done / target);
      expect(ratios).toEqual([...ratios].sort((left, right) => left - right));
      expect(new Set(ratios).size).toBeGreaterThan(5);
      expect(ratios.at(-1)).toBe(1);
    } finally {
      mock.restore();
    }
  });

  it('handles a 500-link continuation and returns every link row', async () => {
    const mock = installMockMediaWiki();

    try {
      const firstPage = await getPageLinksBatch(['Page 0'], undefined, { paginationSessionId: 'plain-continuation' });
      expect(firstPage.pages[0].links).toHaveLength(500);
      expect(firstPage.pages[0].complete).toBe(false);
      expect(firstPage.continueToken).toBe('0|0|500');

      const secondPage = await getPageLinksBatch(['Page 0'], firstPage.continueToken, { paginationSessionId: 'plain-continuation' });
      const links = [...firstPage.pages[0].links, ...secondPage.pages[0].links];
      expect(links).toHaveLength(650);
      expect(new Set(links).size).toBe(650);
      expect(secondPage.pages[0].complete).toBe(true);
      expect(secondPage.continueToken).toBeUndefined();

      // Once complete, the whole 650-row list is cached — not just the last page.
      const cached = getCachedPageLinks('Page 0');
      expect(cached?.complete).toBe(true);
      expect(cached?.links).toHaveLength(650);
      expect(new Set(cached?.links).size).toBe(650);

      // A settled pagination session leaves no accumulation behind.
      expect(mock.stats.requests).toBe(2);
      expect(mock.stats.linkRowsDownloaded).toBe(650);
    } finally {
      mock.restore();
    }
  });

  it('combines all paginated links for a redirected page, caches the alias, and never re-fetches it', async () => {
  const mock = installMockMediaWiki();
  const paginationSessionId = 'redirect-pagination-test';

  try {
    const firstPage = await getPageLinksBatch(
      ['Redirect 0'],
      undefined,
      { paginationSessionId },
    );

    expect(firstPage.pages[0]?.resolvedTitle).toBe('Page 0');
    expect(firstPage.pages[0]?.links).toHaveLength(500);
    expect(firstPage.pages[0]?.complete).toBe(false);
    expect(firstPage.continueToken).toBe('0|0|500');

    const secondPage = await getPageLinksBatch(
      ['Redirect 0'],
      firstPage.continueToken,
      { paginationSessionId },
    );

    expect(secondPage.pages[0]?.resolvedTitle).toBe('Page 0');
    expect(secondPage.pages[0]?.links).toHaveLength(150);
    expect(secondPage.pages[0]?.complete).toBe(true);
    expect(secondPage.continueToken).toBeUndefined();

    // Both the redirect alias and its resolved canonical title are cached,
    // each holding the complete 650-link result, not just the final 150.
    for (const cachedTitle of ['Redirect 0', 'Page 0']) {
      const cached = getCachedPageLinks(cachedTitle);
      expect(cached?.resolvedTitle).toBe('Page 0');
      expect(cached?.complete).toBe(true);
      expect(cached?.links).toHaveLength(650);
      expect(new Set(cached?.links).size).toBe(650);
    }

    // A fresh request for the original redirect title is served entirely
    // from cache: no new upstream call, and no leftover accumulation.
    const requestsBeforeCacheHit = mock.stats.requests;
    const cachedPage = await getPageLinksBatch(
      ['Redirect 0'],
      undefined,
      { paginationSessionId: 'cache-verification' },
    );

    expect(mock.stats.requests).toBe(requestsBeforeCacheHit);
    expect(cachedPage.continueToken).toBeUndefined();
    expect(cachedPage.pages[0]?.resolvedTitle).toBe('Page 0');
    expect(cachedPage.pages[0]?.complete).toBe(true);
    expect(cachedPage.pages[0]?.links).toHaveLength(650);
    expect(new Set(cachedPage.pages[0]?.links).size).toBe(650);

    expect(mock.stats.linkRowsDownloaded).toBe(650);
  } finally {
    mock.restore();
  }
});

it('keeps accumulated links isolated between independent pagination states', async () => {
  const mock = installMockMediaWiki();
  const firstState = new Map<string, PageLinksAccumulatedPage>();
  const secondState = new Map<string, PageLinksAccumulatedPage>();

  try {
    // Two callers paginate the same title at the same time with their own
    // state maps. Neither should observe the other's rows.
    const [firstPage, secondPage] = await Promise.all([
      getPageLinksBatch(['Page 0'], undefined, { paginationState: firstState }),
      getPageLinksBatch(['Page 0'], undefined, { paginationState: secondState }),
    ]);

    expect(firstPage.pages[0]?.links).toHaveLength(500);
    expect(secondPage.pages[0]?.links).toHaveLength(500);
    expect(firstPage.continueToken).toBe('0|0|500');
    expect(secondPage.continueToken).toBe('0|0|500');
    expect(firstState.get('page 0')?.links).toHaveLength(500);
    expect(secondState.get('page 0')?.links).toHaveLength(500);

    // Finish only the first state. Its accumulation is cleaned up, while the
    // second state keeps its own happy-so-far rows for its continuation.
    const continuedFirstPage = await getPageLinksBatch(
      ['Page 0'], firstPage.continueToken, { paginationState: firstState },
    );

    expect(continuedFirstPage.pages[0]?.links).toHaveLength(150);
    expect(continuedFirstPage.pages[0]?.complete).toBe(true);
    // The continuation rows are the remainder after this state's own 500
    // accumulated rows, not anything borrowed from the other state.
    const firstTail = continuedFirstPage.pages[0]?.links ?? [];
    expect(firstTail.some((link) => firstPage.pages[0]?.links.includes(link))).toBe(false);
    expect(firstState.size).toBe(0);
    expect(secondState.get('page 0')?.links).toHaveLength(500);

    // The second caller continues from its own untouched accumulation and
    // produces the same tail as the first, proving the two did not merge.
    const continuedSecondPage = await getPageLinksBatch(
      ['Page 0'], secondPage.continueToken, { paginationState: secondState },
    );

    expect(continuedSecondPage.pages[0]?.links).toHaveLength(150);
    expect(continuedSecondPage.pages[0]?.complete).toBe(true);
    expect(secondState.size).toBe(0);

    // The shared cache stores one deduplicated 650-link result.
    expect(getCachedPageLinks('Page 0')?.links).toHaveLength(650);
    expect(new Set(getCachedPageLinks('Page 0')?.links).size).toBe(650);
  } finally {
    mock.restore();
  }
});

it('interleaved session accumulation does not leak rows between sessions', async () => {
  const mock = installMockMediaWiki();
  const firstSession = 'isolation-session-a';
  const secondSession = 'isolation-session-b';

  try {
    // Both sessions start paginating the same 650-link page, so each keeps
    // its own 500-row accumulation keyed by session id.
    const a1 = await getPageLinksBatch(['Page 0'], undefined, { paginationSessionId: firstSession });
    const b1 = await getPageLinksBatch(['Page 0'], undefined, { paginationSessionId: secondSession });
    expect(a1.pages[0]?.links).toHaveLength(500);
    expect(b1.pages[0]?.links).toHaveLength(500);
    expect(a1.continueToken).toBe('0|0|500');
    expect(b1.continueToken).toBe('0|0|500');

    // Interleave the continuations: each must return only its own 150-row
    // tail, with no rows borrowed from (or duplicated with) the other session.
    const a2 = await getPageLinksBatch(['Page 0'], a1.continueToken, { paginationSessionId: firstSession });
    const b2 = await getPageLinksBatch(['Page 0'], b1.continueToken, { paginationSessionId: secondSession });

    expect(a2.pages[0]?.links).toHaveLength(150);
    expect(b2.pages[0]?.links).toHaveLength(150);
    const firstTail = a2.pages[0]?.links ?? [];
    const secondTail = b2.pages[0]?.links ?? [];
    expect(firstTail.some((link) => a1.pages[0]?.links.includes(link))).toBe(false);
    expect(secondTail.some((link) => b1.pages[0]?.links.includes(link))).toBe(false);

    // Both tails are the same remainder of the same page, so they must agree
    // exactly; divergence would signal cross-session contamination.
    expect(firstTail).toEqual(secondTail);

    // A session's accumulation is dropped as soon as its own listing completes.
    expect(mock.stats.linkRequests.at(-1)).toEqual({
      titles: ['Page 0'],
      continueToken: '0|0|500',
    });
    const cached = getCachedPageLinks('Page 0');
    expect(cached?.links).toHaveLength(650);
    expect(new Set(cached?.links).size).toBe(650);
  } finally {
    mock.restore();
  }
});

it('preserves expansion depth when baseDepth is greater than the normal crawl depth limit', async () => {
  const mock = installMockMediaWiki({ mode: 'topical' });

  try {
    const result = await crawlWikipedia({
      seedTitle: 'Page 0',
      depth: 1,
      maxNodes: 5,
      knownIds: ['Page 0'],
      baseDepth: 5,
    });

    expect(result.nodes.length).toBeGreaterThan(0);

    // The expanded seed is depth 5.
    // Its newly discovered children should therefore be depth 6.
    expect(result.nodes.every((node) => node.depth === 6)).toBe(true);
    expect(result.nodes.some((node) => node.depth === 5)).toBe(false);
  } finally {
    mock.restore();
  }
});

it('consumes request budget once per actual HTTP retry attempt', async () => {
  const originalFetch = globalThis.fetch;

  let attempts = 0;
  const beforeRequest = vi.fn(() => true);

  globalThis.fetch = vi.fn(async () => {
    attempts += 1;

    if (attempts < 3) {
      return new Response(
        JSON.stringify({ error: 'rate limited' }),
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': '0.001',
          },
        },
      );
    }

    return Response.json({
      query: {
        pages: [
          {
            pageid: 0,
            title: 'Page 0',
            links: [
              { title: 'Page 1' },
            ],
          },
        ],
      },
    });
  }) as typeof fetch;

  try {
    const result = await getPageLinksBatch(
      ['Page 0'],
      undefined,
      {
        paginationSessionId: 'retry-budget-test',
        beforeRequest,
      },
    );

    expect(result.pages[0]?.title).toBe('Page 0');

    // 429 → 429 → success
    expect(attempts).toBe(3);

    // One budget check for every actual HTTP attempt.
    expect(beforeRequest).toHaveBeenCalledTimes(3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

  it('aborts an in-flight link request when its caller is cancelled', async () => {
    const originalFetch = globalThis.fetch;
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    globalThis.fetch = ((_, init) => {
      requestSignal = init?.signal as AbortSignal | undefined;
      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener('abort', () => reject(requestSignal?.reason), { once: true });
      });
    }) as typeof fetch;

    try {
      const request = getPageLinksBatch(['Abort signal page'], undefined, {
        signal: controller.signal,
        timeoutMs: 10_000,
      });
      const rejection = expect(request).rejects.toMatchObject({ name: 'AbortError' });

      controller.abort();
      await rejection;

      expect(requestSignal?.aborted).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('times out a stalled link request', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((_, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    })) as typeof fetch;

    try {
      const request = getPageLinksBatch(['Timeout page'], undefined, { timeoutMs: 20 });
      await expect(request).rejects.toMatchObject({ name: 'TimeoutError' });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('does not paginate satisfied pages in a mixed batch', async () => {
    const mock = installMockMediaWiki();
    const paginationSessionId = 'mixed-batch-pagination';

    try {
      const firstPage = await getPageLinksBatch(['Page 0', 'Page 1'], undefined, { paginationSessionId });
      expect(firstPage.pages.find((page) => page.title === 'Page 1')?.complete).toBe(true);
      expect(firstPage.pages.find((page) => page.title === 'Page 1')?.links).toHaveLength(120);
      expect(firstPage.pages.find((page) => page.title === 'Page 0')?.complete).toBe(false);
      expect(firstPage.continueToken).toBe('0|0|500');

      expect(getCachedPageLinks('Page 1')?.links).toHaveLength(120);

      // The token belongs to Page 0, but the caller re-submits the whole
      // mixed batch. Only the unfinished page should be requested again,
      // with the continuation token, and Page 1 must stay untouched.
      const secondPage = await getPageLinksBatch(
        ['Page 0', 'Page 1'],
        firstPage.continueToken,
        { paginationSessionId },
      );

      expect(secondPage.pages).toHaveLength(2);
      expect(secondPage.pages.find((page) => page.title === 'Page 0')?.links).toHaveLength(150);
      expect(secondPage.pages.find((page) => page.title === 'Page 0')?.complete).toBe(true);
      expect(secondPage.pages.find((page) => page.title === 'Page 1')?.links).toHaveLength(120);
      expect(getCachedPageLinks('Page 1')?.links).toHaveLength(120);
      expect(secondPage.continueToken).toBeUndefined();

      expect(mock.stats.requests).toBe(2);
      expect(mock.stats.linkRequests).toHaveLength(2);
      expect(mock.stats.linkRequests[0]).toEqual({
        titles: ['Page 0', 'Page 1'],
        continueToken: null,
      });
      expect(mock.stats.linkRequests[1]).toEqual({
        titles: ['Page 0'],
        continueToken: '0|0|500',
      });
      expect(mock.stats.linkRowsDownloaded).toBe(500 + 120 + 150);
    } finally {
      mock.restore();
    }
  });

  it('uses completed page-link cache on an identical crawl', async () => {
    const mock = installMockMediaWiki();

    try {
      await crawlWikipedia({ seedTitle: 'Page 0', depth: 1, maxNodes: 3 });
      const firstRequestCount = mock.stats.requests;
      await crawlWikipedia({ seedTitle: 'Page 0', depth: 1, maxNodes: 3 });
      expect(mock.stats.requests - firstRequestCount).toBe(0);
    } finally {
      mock.restore();
    }
  });

  it('returns missing, does not cache it, and keeps pagination state untouched', async () => {
    const mock = installMockMediaWiki();
    const paginationSessionId = 'missing-page-session';
    vi.mocked(setCachedPageLinks).mockClear();

    try {
      const result = await getPageLinksBatch(['Typoed article'], undefined, { paginationSessionId });
      expect(result.pages[0]?.missing).toBe(true);
      expect(result.pages[0]?.complete).toBe(true);
      expect(result.pages[0]?.links).toEqual([]);
      expect(result.continueToken).toBeUndefined();

      expect(setCachedPageLinks).not.toHaveBeenCalled();
      expect(getCachedPageLinks('Typoed article')).toBeNull();

      // Missing pages are not cached, so a repeat request hits upstream again.
      const requestsAfterFirst = mock.stats.requests;
      const repeat = await getPageLinksBatch(['Typoed article'], undefined, { paginationSessionId: 'missing-page-session-2' });
      expect(repeat.pages[0]?.missing).toBe(true);
      expect(mock.stats.requests).toBe(requestsAfterFirst + 1);
      expect(setCachedPageLinks).not.toHaveBeenCalled();
    } finally {
      mock.restore();
    }
  });

  it('supports deterministic topical clusters without environment variables', async () => {
    const mock = installMockMediaWiki({ mode: 'topical' });

    try {
      const result = await crawlWikipedia({ seedTitle: 'Page 0', depth: 2, maxNodes: 12 });
      expect(result.nodes.length).toBeGreaterThan(0);
      expect(result.nodes.length).toBeLessThanOrEqual(20);
      expect(result.nodes.some((node) => node.depth === 1)).toBe(true);
    } finally {
      mock.restore();
    }
  });

  it('caps layer 1 for deeper crawls and rolls into layer 2', async () => {
    const mock = installMockMediaWiki();

    try {
      const result = await crawlWikipedia({ seedTitle: 'Page 0', depth: 2, maxNodes: 20 });
      const layerOneCount = result.nodes.filter((node) => node.depth === 1).length;
      expect(layerOneCount).toBeLessThanOrEqual(Math.ceil(0.4 * 20));
      expect(result.nodes.some((node) => node.depth === 2)).toBe(true);
    } finally {
      mock.restore();
    }
  });

  it('does not get trapped in an alphabetical 400-link layer', async () => {
    const mock = installMockMediaWiki({ mode: 'alphabetical' });

    try {
      const result = await crawlWikipedia({ seedTitle: 'Page 0', depth: 2, maxNodes: 150 });
      expect(result.nodes.filter((node) => node.depth === 1).length).toBeLessThanOrEqual(60);
      expect(result.nodes.some((node) => node.depth === 2)).toBe(true);
      expect(result.nodes.some((node) => /Article [D-Z]/.test(node.title))).toBe(true);
    } finally {
      mock.restore();
    }
  });

  it('uses pageview popularity before the deterministic fallback order', async () => {
    const mock = installMockMediaWiki({
      pageviews: { 'Page 1': 1, 'Page 2': 100, 'Page 3': 50, 'Page 4': 25 },
    });

    try {
      const result = await crawlWikipedia({ seedTitle: 'Page 0', depth: 2, maxNodes: 8 });
      const layerOne = result.nodes.filter((node) => node.depth === 1).map((node) => node.id);
      expect(layerOne.slice(0, 3)).toEqual(['Page 2', 'Page 3', 'Page 4']);
      expect(mock.stats.pageviewRequests).toBeGreaterThan(0);
    } finally {
      mock.restore();
    }
  });

  it('falls back to a stable seeded order when pageviews fail', async () => {
    const firstMock = installMockMediaWiki({ pageviewsFail: true });
    let first: string[];
    try {
      first = (await crawlWikipedia({ seedTitle: 'Page 0', depth: 1, maxNodes: 12 }))
        .nodes.filter((node) => node.depth === 1).map((node) => node.id);
    } finally {
      firstMock.restore();
    }

    const secondMock = installMockMediaWiki({ pageviewsFail: true });
    try {
      const second = (await crawlWikipedia({ seedTitle: 'Page 0', depth: 1, maxNodes: 12 }))
        .nodes.filter((node) => node.depth === 1).map((node) => node.id);
      expect(second).toEqual(first!);
      expect(second).not.toEqual([...second].sort((left, right) => left.localeCompare(right)));
    } finally {
      secondMock.restore();
    }
  });

  it('fills the full node budget at depth 1 and counts ranking requests', async () => {
    const mock = installMockMediaWiki({ pageviewsFail: true });

    try {
      const result = await crawlWikipedia({ seedTitle: 'Page 0', depth: 1, maxNodes: 20 });
      expect(result.nodes).toHaveLength(20);
      expect(mock.stats.requests).toBeLessThanOrEqual(getCrawlRequestBudget(20, 1));
    } finally {
      mock.restore();
    }
  });

  it('keeps edges whose link target is resolved from a redirect', async () => {
    const mock = installMockMediaWiki({ pageviews: { 'Page 1': 100 } });

    try {
      const result = await crawlWikipedia({ seedTitle: 'Page 0', depth: 1, maxNodes: 20 });
      expect(result.nodes.map((node) => node.id)).toContain('Page 1');
      expect(result.edges).toContainEqual({ source: 'Page 0', target: 'Page 1' });
    } finally {
      mock.restore();
    }
  });

  it('emits available edges during crawl batches', async () => {
    const mock = installMockMediaWiki();
    const batches: Array<{ nodes: number; edges: number }> = [];

    try {
      await crawlWikipedia({
        seedTitle: 'Page 0',
        depth: 2,
        maxNodes: 20,
        onBatch: (nodes, edges) => batches.push({ nodes: nodes.length, edges: edges.length }),
      });

      const firstEdgeBatch = batches.findIndex((batch) => batch.edges > 0);
      expect(firstEdgeBatch).toBeGreaterThanOrEqual(0);
      expect(batches.slice(0, firstEdgeBatch).some((batch) => batch.nodes > 0)).toBe(true);
    } finally {
      mock.restore();
    }
  });

  it('expand: never re-fetches known pages, offsets new node depth by baseDepth, and edges to known nodes', async () => {
    const mock = installMockMediaWiki({ mode: 'topical' });
    const requestedTitles: string[] = [];
    const wrappedFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const url = new URL(input.toString());
      if (url.searchParams.get('action') === 'query' && url.searchParams.get('prop') === 'links') {
        requestedTitles.push(...(url.searchParams.get('titles') || '').split('|').filter(Boolean));
      }
      return wrappedFetch(input, init);
    }) as typeof fetch;

    try {
      const knownIds = ['Page 0', 'Page 3', 'Page 4'];
      const result = await crawlWikipedia({
        seedTitle: 'Page 0',
        depth: 1,
        maxNodes: 5,
        knownIds,
        baseDepth: 2,
      });

      // The expanded node itself is already known and should not reappear in the delta.
      expect(result.nodes.some((node) => node.id === 'Page 0')).toBe(false);
      // New nodes are offset by baseDepth (currentDepth 0 relative to the seed -> baseDepth + 1).
      expect(result.nodes.length).toBeGreaterThan(0);
      expect(result.nodes.every((node) => node.depth === 3)).toBe(true);
      // Edges to nodes already known (but not the seed) are still produced.
      expect(result.edges).toContainEqual({ source: 'Page 0', target: 'Page 3' });
      expect(result.edges).toContainEqual({ source: 'Page 0', target: 'Page 4' });
      // Known pages other than the seed are never requested.
      expect(requestedTitles).not.toContain('Page 3');
      expect(requestedTitles).not.toContain('Page 4');
      expect(requestedTitles).toContain('Page 0');
    } finally {
      globalThis.fetch = wrappedFetch;
      mock.restore();
    }
  });
});
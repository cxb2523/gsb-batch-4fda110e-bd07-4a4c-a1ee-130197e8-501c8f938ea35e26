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
import { getPageLinksBatch } from '../lib/wikipedia';
import { setCachedPageLinks } from '../lib/db';

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
      const firstPage = await getPageLinksBatch(['Page 0']);
      expect(firstPage.pages[0].links).toHaveLength(500);
      expect(firstPage.continueToken).toBe('0|0|500');

      const secondPage = await getPageLinksBatch(['Page 0'], firstPage.continueToken);
      const links = [...firstPage.pages[0].links, ...secondPage.pages[0].links];
      expect(links).toHaveLength(650);
      expect(new Set(links).size).toBe(650);
      expect(secondPage.continueToken).toBeUndefined();
      expect(mock.stats.requests).toBe(2);
      expect(mock.stats.linkRowsDownloaded).toBe(650);
    } finally {
      mock.restore();
    }
  });

  it('combines all paginated links for a redirected page and caches the complete result', async () => {
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

    // The completed page should now be available from cache as one
    // complete 650-link result, not just the final 150 links.
    const cachedPage = await getPageLinksBatch(
      ['Redirect 0'],
      undefined,
      { paginationSessionId: 'cache-verification' },
    );

    expect(cachedPage.pages[0]?.resolvedTitle).toBe('Page 0');
    expect(cachedPage.pages[0]?.complete).toBe(true);
    expect(cachedPage.pages[0]?.links).toHaveLength(650);
    expect(new Set(cachedPage.pages[0]?.links).size).toBe(650);

    expect(mock.stats.linkRowsDownloaded).toBe(650);
  } finally {
    mock.restore();
  }
});

it('keeps accumulated links isolated between pagination states', async () => {
  const mock = installMockMediaWiki();
  const firstState = new Map();
  const secondState = new Map();

  try {
    const firstPage = await getPageLinksBatch(['Page 0'], undefined, { paginationState: firstState });
    const secondPage = await getPageLinksBatch(['Page 0'], undefined, { paginationState: secondState });
    const continuedFirstPage = await getPageLinksBatch(
      ['Page 0'], firstPage.continueToken, { paginationState: firstState },
    );

    expect(continuedFirstPage.pages[0]?.links).toHaveLength(150);
    expect(firstState.size).toBe(0);
    expect(secondState.size).toBe(1);

    const continuedSecondPage = await getPageLinksBatch(
      ['Page 0'], secondPage.continueToken, { paginationState: secondState },
    );
    expect(continuedSecondPage.pages[0]?.links).toHaveLength(150);
    expect(secondState.size).toBe(0);
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

    try {
      const firstPage = await getPageLinksBatch(['Page 0', 'Page 1']);
      expect(firstPage.pages.find((page) => page.title === 'Page 1')?.complete).toBe(true);
      expect(firstPage.continueToken).toBe('0|0|500');
      const secondPage = await getPageLinksBatch(['Page 0'], firstPage.continueToken);
      expect(secondPage.pages).toHaveLength(1);
      expect(mock.stats.requests).toBe(2);
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

  it('does not cache missing pages', async () => {
    const mock = installMockMediaWiki();
    vi.mocked(setCachedPageLinks).mockClear();

    try {
      const result = await getPageLinksBatch(['Typoed article']);
      expect(result.pages[0]?.missing).toBe(true);
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
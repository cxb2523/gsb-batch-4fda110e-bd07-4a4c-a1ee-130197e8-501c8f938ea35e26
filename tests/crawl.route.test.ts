import { describe, expect, it, vi } from 'vitest';
import { installMockMediaWiki } from './helpers/mockMediaWiki';
import type { CrawlResult } from '../types/graph';

vi.mock('../lib/db', () => ({
  getCachedPageLinks: vi.fn(() => null),
  setCachedPageLinks: vi.fn(),
  getCachedPageViews: vi.fn(() => null),
  setCachedPageViews: vi.fn(),
  getCachedRelationship: vi.fn(() => null),
  setCachedRelationship: vi.fn(),
  getCachedResult: vi.fn(() => null),
  setCachedResult: vi.fn(),
  generateCacheKey: vi.fn(() => 'test-cache-key'),
}));

import { POST } from '../app/api/crawl/route';
import * as database from '../lib/db';

async function postCrawl(body: Record<string, unknown>, clientIp?: string): Promise<Response> {
  const request = new Request('http://localhost/api/crawl', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(clientIp ? { 'x-real-ip': clientIp } : {}),
    },
    body: JSON.stringify(body),
  });

  return POST(request as never);
}

describe('crawl route', () => {
  it('returns not_found with suggestions for a missing seed', async () => {
    const mock = installMockMediaWiki();

    try {
      const request = new Request('http://localhost/api/crawl', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seedTitle: 'Typoed article', depth: 2, maxNodes: 100 }),
      });
      const response = await POST(request as never);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body).toEqual({
        error: 'not_found',
        title: 'Typoed article',
        suggestions: ['Page 0', 'Page 1'],
      });
    } finally {
      mock.restore();
    }
  });

  it('fetches a cold crawl seed link page only once', async () => {
    const mock = installMockMediaWiki({ mode: 'topical' });
    const originalFetch = globalThis.fetch;
    const seedLinkFetches: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = new URL(input.toString());
      if (url.searchParams.get('prop') === 'links') {
        const titles = (url.searchParams.get('titles') ?? '').split('|');
        if (titles.includes('Page 0')) seedLinkFetches.push(url.searchParams.get('plcontinue') ?? 'initial');
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    try {
      const response = await postCrawl({ seedTitle: 'Page 0', depth: 1, maxNodes: 50 }, '192.0.2.93');
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(body).toContain('event: done');
      expect(seedLinkFetches).toEqual(['initial']);
      expect(mock.stats.linkRowsDownloaded).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = originalFetch;
      mock.restore();
    }
  });

  it('rejects an expansion with too many known nodes', async () => {
  const knownNodeIds = Array.from(
    { length: 501 },
    (_, index) => `Page ${index}`,
  );

  const response = await postCrawl({
    seedTitle: 'Page 0',
    depth: 1,
    maxNodes: 50,
    knownNodeIds,
    knownEdgeIndexPairs: [],
    baseDepth: 0,
  });

  expect(response.status).toBe(400);

  const body = await response.json();

  expect(body).toEqual({
    error: 'Invalid expansion node count',
  });
});

it('rejects an expansion with too many known edges', async () => {
  const knownEdgeIndexPairs: [number, number][] = Array.from(
    { length: 50_001 },
    () => [0, 0],
  );

  const response = await postCrawl({
    seedTitle: 'Page 0',
    depth: 1,
    maxNodes: 50,
    knownNodeIds: ['Page 0'],
    knownEdgeIndexPairs,
    baseDepth: 0,
  });

  expect(response.status).toBe(400);

  const body = await response.json();

  expect(body).toEqual({
    error: 'Invalid expansion edge count',
  });
});

it('rejects an expansion with an empty node id', async () => {
  const response = await postCrawl({
    seedTitle: 'Page 0',
    depth: 1,
    maxNodes: 50,
    knownNodeIds: [''],
    knownEdgeIndexPairs: [],
    baseDepth: 0,
  });

  expect(response.status).toBe(400);

  const body = await response.json();

  expect(body).toEqual({
    error: 'Invalid expansion node id',
  });
});

it('rejects duplicate expansion node ids', async () => {
  const response = await postCrawl({
    seedTitle: 'Page 0',
    depth: 1,
    maxNodes: 50,
    knownNodeIds: ['Page 0', 'Page 0'],
    knownEdgeIndexPairs: [],
    baseDepth: 0,
  });

  expect(response.status).toBe(400);

  const body = await response.json();

  expect(body).toEqual({
    error: 'Duplicate expansion node id',
  });
});

it('rejects an expansion edge that does not contain exactly two indexes', async () => {
  const response = await postCrawl({
    seedTitle: 'Page 0',
    depth: 1,
    maxNodes: 50,
    knownNodeIds: ['Page 0'],
    knownEdgeIndexPairs: [[0] as unknown as [number, number]],
    baseDepth: 0,
  });

  expect(response.status).toBe(400);

  const body = await response.json();

  expect(body).toEqual({
    error: 'Invalid expansion edge index',
  });
});

it('rejects an expansion edge with an out-of-range index', async () => {
  const response = await postCrawl({
    seedTitle: 'Page 0',
    depth: 1,
    maxNodes: 50,
    knownNodeIds: ['Page 0'],
    knownEdgeIndexPairs: [[0, 1]],
    baseDepth: 0,
  });

  expect(response.status).toBe(400);

  const body = await response.json();

  expect(body).toEqual({
    error: 'Invalid expansion edge index',
  });
});

it('still accepts a valid expansion request', async () => {
  const mock = installMockMediaWiki();

  try {
    const response = await postCrawl({
      seedTitle: 'Page 0',
      depth: 1,
      maxNodes: 50,
      knownNodeIds: ['Page 0'],
      knownEdgeIndexPairs: [],
      baseDepth: 0,
    });

    expect(response.status).toBe(200);

    const body = await response.text();

    expect(body).toContain('event: stage\ndata: {"stage":"analyzing"}');
    expect(body).toContain('event: done');
    expect(body.indexOf('event: stage')).toBeLessThan(body.indexOf('event: analysis'));
    expect(body.indexOf('event: analysis')).toBeLessThan(body.indexOf('event: done'));
    expect(body).toContain('"result"');
  } finally {
    mock.restore();
  }
});

it('preserves expansion edges between known nodes and from new nodes to known nodes', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    const url = new URL(input.toString());
    const property = url.searchParams.get('prop');
    if (property === 'pageviews') {
      return Response.json({ query: { pages: [] } });
    }
    const titles = (url.searchParams.get('titles') ?? '').split('|').filter(Boolean);
    return Response.json({
      query: {
        pages: titles.map((title, index) => ({
          pageid: index + 1,
          title,
          links: title === 'Expanded'
            ? [{ title: 'Page 1' }, { title: 'New A' }]
            : title === 'New A'
              ? [{ title: 'Known B' }, { title: 'New A' }, { title: 'Outside' }]
              : [],
        })),
      },
    });
  }) as typeof fetch;
  vi.mocked(database.setCachedResult).mockClear();

  try {
    const response = await postCrawl({
      seedTitle: 'Expanded',
      depth: 1,
      maxNodes: 50,
      knownNodeIds: ['Expanded', 'Page 1', 'Known B'],
      knownEdgeIndexPairs: [[0, 1]],
      baseDepth: 0,
    }, '192.0.2.92');
    const stream = await response.text();
    const doneEvent = stream.split('\n\n').find((event) => event.startsWith('event: done'));
    const payloadLine = doneEvent?.split('\n').find((line) => line.startsWith('data:'));
    const result = JSON.parse(payloadLine!.slice(5)).result as CrawlResult;
    const edgeKeys = result.edges.map((edge) => `${edge.source}|${edge.target}`);

    expect(result.nodes.map((node) => node.id)).toEqual(['New A']);
    expect(result.edges).toContainEqual({ source: 'Expanded', target: 'Page 1' });
    expect(result.edges).toContainEqual({ source: 'New A', target: 'Known B' });
    expect(edgeKeys).not.toContain('New A|New A');
    expect(edgeKeys).not.toContain('New A|Outside');
    expect(new Set(edgeKeys).size).toBe(edgeKeys.length);
    expect(database.setCachedResult).not.toHaveBeenCalled();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

it('returns budget-truncated crawl results without caching them as complete', async () => {
  const originalFetch = globalThis.fetch;
  let linkRequests = 0;
  globalThis.fetch = (async (input) => {
    const url = new URL(input.toString());
    if (url.searchParams.get('prop') === 'links') {
      linkRequests += 1;
      const title = url.searchParams.get('titles')?.split('|')[0] ?? 'Page 0';
      return Response.json({
        query: {
          pages: [{ pageid: 1, title, links: [{ title: 'Page 1' }] }],
        },
        continue: { plcontinue: '1|0|500' },
      });
    }
    return Response.json({ query: { pages: [] } });
  }) as typeof fetch;

  try {
    const response = await postCrawl({ seedTitle: 'Page 0', depth: 1, maxNodes: 50 }, '192.0.2.91');
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(linkRequests).toBeGreaterThanOrEqual(200);
    expect(body).toContain('"partial":true');
    expect(database.setCachedResult).not.toHaveBeenCalled();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

it('rate limits repeated crawl requests and includes retry headers', async () => {
  vi.mocked(database.getCachedResult).mockReturnValue({
    id: 'cached-result',
    seedId: 'Page 0',
    nodes: [],
    edges: [],
    communities: [],
    crawledAt: new Date(0).toISOString(),
    positions: {},
  } as CrawlResult);

  try {
    for (let requestNumber = 0; requestNumber < 60; requestNumber += 1) {
      const response = await postCrawl(
        { seedTitle: 'Page 0', depth: 1, maxNodes: 50 },
        '192.0.2.90',
      );
      expect(response.status).toBe(200);
    }

    const response = await postCrawl(
      { seedTitle: 'Page 0', depth: 1, maxNodes: 50 },
      '192.0.2.90',
    );
    const body = await response.json();

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toMatch(/^\d+$/);
    expect(response.headers.get('ratelimit-limit')).toBe('60');
    expect(body.error).toMatch(/Too many crawl requests/);
  } finally {
    vi.mocked(database.getCachedResult).mockReturnValue(null);
  }
});

});
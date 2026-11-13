import { describe, expect, it } from 'vitest';
import { buildExpandRequestBody, createCrawlRequest, getCrawlPayload, parseCrawlParams } from './crawlRequest';

describe('crawl requests', () => {
  it('creates a new request for the same seed with changed settings', () => {
    const first = createCrawlRequest('A', 1, 100, 1);
    const second = createCrawlRequest('A', 2, 100, 2);

    expect(getCrawlPayload(first)).toEqual({ seedTitle: 'A', depth: 1, maxNodes: 100 });
    expect(getCrawlPayload(second)).toEqual({ seedTitle: 'A', depth: 2, maxNodes: 100 });
    expect(second.nonce).not.toBe(first.nonce);
  });

  it('clamps invalid URL values to server bounds', () => {
    expect(parseCrawlParams('?seed=A&depth=wat&nodes=9999')).toEqual({
      seed: 'A',
        depth: 2,
      maxNodes: 500,
    });
  });

  it('uses defaults for missing URL values', () => {
      expect(parseCrawlParams('?seed=A')).toEqual({ seed: 'A', depth: 2, maxNodes: 150 });
  });

  it('converts Wikipedia URL underscores to title spaces', () => {
    expect(parseCrawlParams('?seed=Alan_Turing')).toEqual({
      seed: 'Alan Turing',
      depth: 2,
      maxNodes: 150,
    });
  });

  it('preserves selected expansion depth and respects the API minimum node budget', () => {
    const request = buildExpandRequestBody('B', {
      id: 'graph',
      seedId: 'A',
      nodes: [
        { id: 'A', title: 'A', url: '', depth: 0, inDegree: 0, outDegree: 1, pagerank: 0, betweenness: 0, communityId: 0 },
        { id: 'B', title: 'B', url: '', depth: 1, inDegree: 1, outDegree: 0, pagerank: 0, betweenness: 0, communityId: 0 },
      ],
      edges: [{ source: 'A', target: 'B' }],
      communities: [],
      crawledAt: '',
      positions: {},
    }, 3, 50);

    expect(request).toMatchObject({
      seedTitle: 'B',
      depth: 3,
      maxNodes: 50,
      knownNodeIds: ['A', 'B'],
      knownEdgeIndexPairs: [[0, 1]],
      baseDepth: 1,
    });
  });
});
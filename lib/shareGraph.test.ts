import { describe, expect, it } from 'vitest';
import { decodeSharedGraph, encodeSharedGraph, type SharedGraph } from './shareGraph';

const snapshot: SharedGraph = {
  depth: 2,
  maxNodes: 150,
  colorMode: 'depth',
  graph: {
    id: 'test', seedId: 'A', crawledAt: '2026-01-01',
    nodes: [
      { id: 'A', title: 'A', url: 'https://en.wikipedia.org/wiki/A', depth: 0, inDegree: 0, outDegree: 1, pagerank: 0.5, betweenness: 0, communityId: 0 },
      { id: 'B', title: 'B', url: 'https://en.wikipedia.org/wiki/B', depth: 1, inDegree: 1, outDegree: 0, pagerank: 0.5, betweenness: 0, communityId: 0 },
    ],
    edges: [{ source: 'A', target: 'B' }], communities: [], positions: { A: { x: 2, y: 3 } },
  },
};

describe('shared graph snapshots', () => {
  it('round trips the directed graph, layout and settings', async () => {
    const encoded = await encodeSharedGraph(snapshot);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(await decodeSharedGraph(encoded)).toEqual({ ...snapshot, graph: { ...snapshot.graph, id: 'shared' } });
  });

  it('rejects invalid snapshots and links', async () => {
    await expect(decodeSharedGraph('not valid!')).rejects.toThrow('Invalid');
    const encoded = await encodeSharedGraph({ ...snapshot, graph: { ...snapshot.graph, edges: [{ source: 'A', target: 'missing' }] } });
    await expect(decodeSharedGraph(encoded)).rejects.toThrow('Invalid');
  });
});
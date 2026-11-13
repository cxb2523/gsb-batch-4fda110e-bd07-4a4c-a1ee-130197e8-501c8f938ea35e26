import Graph from 'graphology';
import { describe, expect, it } from 'vitest';
import { getCommunityColor, getNodeColor, getNodeSize, getShortestPath } from './graphAnalysis';

function makeGraph() {
  const graph = new Graph({ type: 'directed' });
  for (const node of ['A', 'B', 'C', 'D', 'E']) graph.addNode(node);
  graph.addEdge('A', 'B');
  graph.addEdge('B', 'C');
  graph.addEdge('D', 'A');
  return graph;
}

describe('shortest paths', () => {
  it('finds direct and multi-hop paths in either direction', () => {
    const graph = makeGraph();

    expect(getShortestPath(graph, 'A', 'B')).toEqual({ path: ['A', 'B'], length: 1 });
    expect(getShortestPath(graph, 'C', 'A')).toEqual({ path: ['C', 'B', 'A'], length: 2 });
  });

  it('returns null when nodes are disconnected or missing', () => {
    const graph = makeGraph();

    expect(getShortestPath(graph, 'A', 'C')).not.toBeNull();
    expect(getShortestPath(graph, 'C', 'E')).toBeNull();
    expect(getShortestPath(graph, 'A', 'missing')).toBeNull();
  });

  it('does not mutate the source graph', () => {
    const graph = makeGraph();
    const before = { nodes: graph.nodes(), edges: graph.edges() };

    expect(getShortestPath(graph, 'A', 'D')).toEqual({ path: ['A', 'D'], length: 1 });
    expect(graph.nodes()).toEqual(before.nodes);
    expect(graph.edges()).toEqual(before.edges);
    expect(graph.type).toBe('directed');
  });
});

describe('PageRank node sizing', () => {
  it('keeps tied ranks the same size and maps distribution bounds to the size limits', () => {
    const ranks = [0.1, 0.2, 0.2, 0.4];

    expect(getNodeSize(0.1, 5, 17, ranks)).toBe(5);
    expect(getNodeSize(0.2, 5, 17, ranks)).toBeCloseTo(5 + Math.sqrt(1 / 3) * 12);
    expect(getNodeSize(0.4, 5, 17, ranks)).toBe(17);
  });
});

describe('Sigma-compatible generated node colors', () => {
  it('uses rgb colors when the community palette exceeds its fixed colors', () => {
    expect(getCommunityColor(20, 21)).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
  });

  it('uses rgb colors for depth coloring', () => {
    const node = {
      id: 'B', title: 'B', url: '', depth: 1,
      inDegree: 0, outDegree: 0, pagerank: 0, betweenness: 0, communityId: 0,
    };

    expect(getNodeColor(node, 'depth', 'A', 2)).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
  });
});
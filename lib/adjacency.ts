import type { WikiEdge } from '@/types/graph';

const adjacencyCache = new WeakMap<readonly WikiEdge[], Map<string, string[]>>();

export function buildAdjacency(edges: readonly WikiEdge[]): Map<string, string[]> {
  const cached = adjacencyCache.get(edges);
  if (cached) return cached;

  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const sourceNeighbors = adjacency.get(edge.source);
    if (sourceNeighbors) sourceNeighbors.push(edge.target);
    else adjacency.set(edge.source, [edge.target]);

    const targetNeighbors = adjacency.get(edge.target);
    if (targetNeighbors) targetNeighbors.push(edge.source);
    else adjacency.set(edge.target, [edge.source]);
  }

  adjacencyCache.set(edges, adjacency);
  return adjacency;
}
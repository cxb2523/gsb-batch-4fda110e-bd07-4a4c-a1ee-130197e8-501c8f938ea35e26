import { bench, describe } from 'vitest';
import { buildAdjacency } from '../lib/adjacency';
import type { WikiEdge } from '../types/graph';

const nodeCount = 500;
const edgeCount = 15_000;
const edges: WikiEdge[] = Array.from({ length: edgeCount }, (_, index) => ({
  source: `node-${index % nodeCount}`,
  target: `node-${(index * 37 + 11) % nodeCount}`,
}));
const nodeIds = Array.from({ length: nodeCount }, (_, index) => `node-${index}`);
const focusId = 'node-137';
const adjacency = buildAdjacency(edges);

function scanConnectedNodes(): string[] {
  return nodeIds.filter((nodeId) => edges.some((edge) => (
    (edge.source === focusId && edge.target === nodeId) ||
    (edge.target === focusId && edge.source === nodeId)
  )));
}

function buildReducerSetsPerNode(): number {
  let matches = 0;
  for (const nodeId of nodeIds) {
    if (new Set(edges.filter((edge) => edge.source === focusId || edge.target === focusId)
      .flatMap((edge) => [edge.source, edge.target])).has(nodeId)) matches += 1;
  }
  return matches;
}

function readHoistedReducerSet(): number {
  const neighbors = new Set(adjacency.get(focusId) ?? []);
  let matches = 0;
  for (const nodeId of nodeIds) if (neighbors.has(nodeId)) matches += 1;
  return matches;
}

describe('graph interaction performance (500 nodes, 15k edges)', () => {
  bench('baseline: panel scans every edge for every node', () => {
    scanConnectedNodes();
  }, { iterations: 10, warmupIterations: 2 });

  bench('optimized: panel reads cached adjacency', () => {
    adjacency.get(focusId);
  }, { iterations: 10, warmupIterations: 2 });

  bench('baseline: reducer allocates a Set per node', () => {
    buildReducerSetsPerNode();
  }, { iterations: 3, warmupIterations: 1 });

  bench('optimized: reducer reads one hoisted Set', () => {
    readHoistedReducerSet();
  }, { iterations: 3, warmupIterations: 1 });
});
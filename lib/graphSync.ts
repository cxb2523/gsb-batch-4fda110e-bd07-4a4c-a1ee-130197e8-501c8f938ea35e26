import type Graph from 'graphology';
import type { CrawlResult, WikiNode } from '@/types/graph';
import { positionNearNeighbors } from './layoutSeed';

export function computeEdgeWeight(
  source: WikiNode,
  target: WikiNode,
  targetInDegree: number,
  nodeCount: number,
): number {
  const communityWeight = source.communityId === target.communityId ? 1 : 0.15;
  const hubWeight = targetInDegree > nodeCount * 0.35 ? 0.25 : 1;
  return communityWeight * hubWeight;
}

export function mergeGraphData(base: CrawlResult, update: CrawlResult): CrawlResult {
  const nodes = new Map(base.nodes.map((node) => [node.id, node]));
  if (update.metrics) {
    for (const [nodeId, nodeMetrics] of Object.entries(update.metrics)) {
      const existing = nodes.get(nodeId);
      if (existing) nodes.set(nodeId, { ...existing, ...nodeMetrics });
    }
  }
  for (const node of update.nodes) {
    nodes.set(node.id, { ...nodes.get(node.id), ...node });
  }

  const edges = new Map(base.edges.map((edge) => [`${edge.source}|${edge.target}`, edge]));
  for (const edge of update.edges) {
    edges.set(`${edge.source}|${edge.target}`, edge);
  }

  const outgoingEdges = new Map<string, string[]>();
  for (const edge of edges.values()) {
    const targets = outgoingEdges.get(edge.source) ?? [];
    targets.push(edge.target);
    outgoingEdges.set(edge.source, targets);
  }
  const depths = new Map<string, number>([[base.seedId, 0]]);
  const queue = [base.seedId];
  for (let index = 0; index < queue.length; index += 1) {
    const source = queue[index];
    const nextDepth = depths.get(source)! + 1;
    for (const target of outgoingEdges.get(source) ?? []) {
      if (depths.has(target) || !nodes.has(target)) continue;
      depths.set(target, nextDepth);
      queue.push(target);
    }
  }
  const mergedNodes = [...nodes.values()].map((node) => {
    const depth = depths.get(node.id);
    return depth === undefined || depth === node.depth ? node : { ...node, depth };
  });

  return {
    ...base,
    ...update,
    // The expand endpoint's seed is the node being expanded, not the graph's original seed.
    seedId: base.seedId,
    nodes: mergedNodes,
    edges: [...edges.values()],
    positions: { ...base.positions, ...update.positions },
  };
}

interface GraphNodeAttributes {
  x: number;
  y: number;
  fixed: boolean;
  size: number;
  color: string;
  label: string;
  raw: WikiNode;
  isSeed: boolean;
}

export interface GraphSyncOptions {
  colorForNode: (node: WikiNode) => string;
  sizeForNode: (node: WikiNode) => number;
  initialPositions?: Map<string, { x: number; y: number }>;
}

export interface GraphSyncResult {
  seedChanged: boolean;
  addedNodeIds: string[];
  shouldFitCamera: boolean;
}

export function syncGraphData(
  graph: Graph,
  data: CrawlResult,
  options: GraphSyncOptions,
): GraphSyncResult {
  const seedChanged = graph.order > 0 && graph.getAttribute('seedId') !== data.seedId;
  const wasEmpty = graph.order === 0;
  if (seedChanged) {
    graph.clear();
  }
  graph.setAttribute('seedId', data.seedId);

  const incomingIds = new Set(data.nodes.map((node) => node.id));
  const addedNodeIds: string[] = [];
  const currentPositions = new Map(
    graph.nodes().map((nodeId) => {
      const attributes = graph.getNodeAttributes(nodeId);
      return [nodeId, { x: attributes.x as number, y: attributes.y as number }];
    }),
  );
  const neighborsByNode = new Map<string, Set<string>>();
  for (const edge of data.edges) {
    const sourceNeighbors = neighborsByNode.get(edge.source) ?? new Set<string>();
    const targetNeighbors = neighborsByNode.get(edge.target) ?? new Set<string>();
    sourceNeighbors.add(edge.target);
    targetNeighbors.add(edge.source);
    neighborsByNode.set(edge.source, sourceNeighbors);
    neighborsByNode.set(edge.target, targetNeighbors);
  }

  for (const node of data.nodes) {
    const isSeed = node.id === data.seedId;
    const size = options.sizeForNode(node) * (isSeed ? 1.3 : 1);
    const color = options.colorForNode(node);
    const existing = graph.hasNode(node.id);

    if (existing) {
      const attributes = graph.getNodeAttributes(node.id);
      if (
        attributes.size !== size ||
        attributes.color !== color ||
        attributes.label !== node.title ||
        attributes.raw !== node ||
        attributes.isSeed !== isSeed
      ) {
        graph.updateNodeAttributes(node.id, (current) => ({
          ...current,
          size,
          color,
          label: node.title,
          raw: node,
          isSeed,
        }));
      }
      continue;
    }

    const position = options.initialPositions?.get(node.id)
      ?? positionNearNeighbors(node.id, data.edges, currentPositions, data.seedId, neighborsByNode);
    graph.mergeNode(node.id, {
      x: position.x,
      y: position.y,
      fixed: false,
      size,
      color,
      label: node.title,
      raw: node,
      isSeed,
    } satisfies GraphNodeAttributes);
    currentPositions.set(node.id, position);
    addedNodeIds.push(node.id);
  }

  for (const node of graph.nodes()) {
    if (!incomingIds.has(node)) graph.dropNode(node);
  }

  const incomingEdges = new Set<string>();
  const inDegreeByNode = new Map<string, number>();
  for (const edge of data.edges) {
    inDegreeByNode.set(edge.target, (inDegreeByNode.get(edge.target) ?? 0) + 1);
  }
  const nodesById = new Map(data.nodes.map((node) => [node.id, node]));
  for (const edge of data.edges) {
    if (!graph.hasNode(edge.source) || !graph.hasNode(edge.target)) continue;
    const key = `${edge.source}|${edge.target}`;
    incomingEdges.add(key);
    const sourceNode = nodesById.get(edge.source);
    const targetNode = nodesById.get(edge.target);
    const weight = sourceNode && targetNode
      ? computeEdgeWeight(sourceNode, targetNode, inDegreeByNode.get(edge.target) ?? 0, data.nodes.length)
      : 1;
    if (
      !graph.hasEdge(edge.source, edge.target) ||
      graph.getEdgeAttribute(edge.source, edge.target, 'weight') !== weight
    ) {
      graph.mergeEdge(edge.source, edge.target, {
        size: 0.8,
        color: 'rgba(148, 163, 184, 0.22)',
        type: 'line',
        weight,
      });
    }
  }

  for (const edge of graph.edges()) {
    const [source, target] = graph.extremities(edge);
    if (!incomingEdges.has(`${source}|${target}`)) graph.dropEdge(edge);
  }

  return { seedChanged, addedNodeIds, shouldFitCamera: seedChanged || (wasEmpty && addedNodeIds.length > 0) };
}

export function updateGraphColors(
  graph: Graph,
  data: CrawlResult,
  colorForNode: (node: WikiNode) => string,
): void {
  const nodesById = new Map(data.nodes.map((node) => [node.id, node]));
  graph.updateEachNodeAttributes((nodeId, attributes) => {
    const node = nodesById.get(nodeId);
    return node ? { ...attributes, color: colorForNode(node) } : attributes;
  });
}


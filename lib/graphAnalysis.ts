import Graph from 'graphology';
import metrics from 'graphology-metrics';
import louvain from 'graphology-communities-louvain';
import shortestPath from 'graphology-shortest-path';
import type { WikiNode, Community, CrawlResult } from '@/types/graph';

const COMMUNITY_COLORS = [
  '#e76f51', '#2a9d8f', '#457b9d', '#f4a261', '#84a59d',
  '#c06c84', '#6d597a', '#5f8d89', '#d1495b', '#4f6d7a',
  '#7a9e9f', '#bc6c25', '#386641', '#577590', '#b56576',
  '#588157', '#7b6d8d', '#3d5a80', '#cb997e', '#52796f',
];

export interface GraphAnalysisResult {
  nodes: WikiNode[];
  communities: Community[];
}

export function hslToRgbColor(hue: number, saturation: number, lightness: number): string {
  const normalizedHue = ((hue % 360) + 360) % 360 / 360;
  const normalizedSaturation = saturation / 100;
  const normalizedLightness = lightness / 100;
  const channel = (offset: number) => {
    const value = (offset + normalizedHue * 12) % 12;
    const chroma = normalizedSaturation * Math.min(normalizedLightness, 1 - normalizedLightness);
    return Math.round(255 * (
      normalizedLightness - chroma * Math.max(-1, Math.min(value - 3, 9 - value, 1))
    ));
  };

  return `rgb(${channel(0)}, ${channel(8)}, ${channel(4)})`;
}

export function buildUndirectedGraph(source: Graph): Graph {
  const graph = new Graph({ type: 'undirected', multi: false });

  source.forEachNode((node) => graph.addNode(node));
  source.forEachEdge((_edge, _attributes, sourceNode, targetNode) => {
    if (sourceNode !== targetNode) graph.mergeEdge(sourceNode, targetNode);
  });

  return graph;
}

export function buildPathGraph(data: CrawlResult | null): Graph {
  const graph = new Graph({ type: 'undirected', multi: false });
  if (!data) return graph;

  for (const node of data.nodes) graph.addNode(node.id);
  for (const edge of data.edges) {
    if (edge.source !== edge.target && graph.hasNode(edge.source) && graph.hasNode(edge.target)) {
      graph.mergeEdge(edge.source, edge.target);
    }
  }

  return graph;
}

export function findShortestPath(
  graph: Graph,
  from: string,
  to: string,
): { path: string[]; length: number } | null {
  if (!graph.hasNode(from) || !graph.hasNode(to)) return null;

  try {
    const path = shortestPath.bidirectional(graph, from, to);
    if (!path) return null;

    return { path, length: path.length - 1 };
  } catch {
    return null;
  }
}

export function analyzeGraph(graph: Graph, seedId: string): GraphAnalysisResult {
  // Calculate PageRank
  const pagerankScores = metrics.centrality.pagerank(graph);
  
  // Calculate Betweenness Centrality
  const betweennessScores = metrics.centrality.betweenness(graph);
  
  // Detect communities using Louvain
  const communityIds = louvain(graph, { resolution: 1 });
  
  // Group nodes by community
  const communityMap = new Map<number, string[]>();
  for (const nodeId of graph.nodes()) {
    const communityId = communityIds[nodeId];
    if (!communityMap.has(communityId)) {
      communityMap.set(communityId, []);
    }
    communityMap.get(communityId)!.push(nodeId);
  }
  
  // Create community objects with labels
  const communities: Community[] = [];
  
  for (const [communityId, nodeIds] of Array.from(communityMap.entries())) {
    // Sort by PageRank to get top pages
    const sortedNodes = nodeIds
      .map((id: string) => ({ id, pagerank: pagerankScores[id] || 0 }))
      .sort((a: { pagerank: number }, b: { pagerank: number }) => b.pagerank - a.pagerank);
    
    // Create label from top 3 PageRank pages
    const topPages = sortedNodes.slice(0, 3).map((n: { id: string }) => n.id);
    const label = topPages.slice(0, 2).join(' & ');
    
    communities.push({
      id: communityId,
      label,
      size: nodeIds.length,
      topPages,
    });
  }
  
  // Sort communities by size
  communities.sort((a, b) => b.size - a.size);
  
  // Update nodes with metrics
  const nodes: WikiNode[] = [];
  for (const nodeId of graph.nodes()) {
    const nodeData = graph.getNodeAttributes(nodeId) as Partial<WikiNode>;
    nodes.push({
      id: nodeId,
      title: nodeData.title || nodeId,
      url: nodeData.url || '',
      depth: nodeData.depth ?? 0,
      inDegree: graph.inDegree(nodeId),
      outDegree: graph.outDegree(nodeId),
      pagerank: pagerankScores[nodeId] || 0,
      betweenness: betweennessScores[nodeId] || 0,
      communityId: communityIds[nodeId] || 0,
    });
  }
  
  return { nodes, communities };
}

export function getShortestPath(
  graph: Graph, 
  from: string, 
  to: string
): { path: string[]; length: number } | null {
  return findShortestPath(buildUndirectedGraph(graph), from, to);
}

export function getCommunityColor(communityId: number, totalCommunities: number): string {
  if (totalCommunities <= COMMUNITY_COLORS.length) {
    return COMMUNITY_COLORS[communityId % COMMUNITY_COLORS.length];
  }
  // Generate a color for large number of communities
  const hue = (communityId * 137.508) % 360;
  return hslToRgbColor(hue, 70, 60);
}

export function getNodeColor(
  node: WikiNode, 
  colorMode: 'community' | 'depth',
  seedId: string,
  maxDepth: number
): string {
  if (node.id === seedId) {
    return '#f08a70';
  }
  
  if (colorMode === 'community') {
    return getCommunityColor(node.communityId, 20);
  } else {
    // Color by depth - gradient from green (shallow) to red (deep)
    if (node.depth < 0) return '#888888'; // Unknown depth
    const ratio = node.depth / Math.max(maxDepth, 1);
    const hue = (1 - ratio) * 120; // 120 = green, 0 = red
    return hslToRgbColor(hue, 70, 50);
  }
}

export function getNodeSize(
  pagerank: number,
  minSize: number = 5,
  maxSize: number = 18,
  rankValues: number[] = [pagerank],
): number {
  let sortedRanks = sortedRankCache.get(rankValues);
  if (!sortedRanks) {
    sortedRanks = rankValues.filter(Number.isFinite).sort((left, right) => left - right);
    sortedRankCache.set(rankValues, sortedRanks);
  }
  if (sortedRanks.length <= 1) return minSize;

  let lower = 0;
  let upper = sortedRanks.length;
  while (lower < upper) {
    const middle = (lower + upper) >>> 1;
    if (sortedRanks[middle] < pagerank) lower = middle + 1;
    else upper = middle;
  }
  const lowerRankCount = lower;
  const percentile = lowerRankCount / (sortedRanks.length - 1);
  return minSize + Math.sqrt(percentile) * (maxSize - minSize);
}

const sortedRankCache = new WeakMap<number[], number[]>();

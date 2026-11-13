import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { WikiEdge, WikiNode } from '@/types/graph';
import type { ExploreTopic } from './exploreTopics';

export interface ExploreGraphData {
  schemaVersion: 1;
  seedTitle: string;
  seedId: string;
  nodes: WikiNode[];
  edges: WikiEdge[];
  partial: boolean;
  failedTitles: string[];
}

export function validateExploreGraph(data: unknown, topic: ExploreTopic): string[] {
  if (!data || typeof data !== 'object') return ['Graph data must be an object.'];
  const graph = data as Partial<ExploreGraphData>;
  if (graph.schemaVersion !== 1) return ['Unsupported graph data version.'];
  if (typeof graph.seedTitle !== 'string' || graph.seedTitle.toLowerCase() !== topic.wikipediaTitle.toLowerCase()) {
    return [`Graph seed title does not match the curated Wikipedia title for ${topic.slug}.`];
  }
  if (typeof graph.seedId !== 'string' || !graph.seedId.trim()) return ['Graph seed is missing.'];
  if (!Array.isArray(graph.nodes) || graph.nodes.length === 0) return ['Graph nodes are missing.'];
  if (!Array.isArray(graph.edges)) return ['Graph edges are missing.'];
  if (typeof graph.partial !== 'boolean' || !Array.isArray(graph.failedTitles)) return ['Graph crawl status is missing.'];

  const issues: string[] = [];
  const nodeIds = new Set<string>();
  for (const node of graph.nodes) {
    if (!node || typeof node.id !== 'string' || !node.id.trim()) {
      issues.push('Graph contains a node without an ID.');
      continue;
    }
    if (nodeIds.has(node.id)) issues.push(`Graph contains duplicate node ID ${node.id}.`);
    nodeIds.add(node.id);
    if (typeof node.title !== 'string' || !node.title.trim() || typeof node.url !== 'string') {
      issues.push(`Graph node ${node.id} has invalid metadata.`);
    }
    if (![node.depth, node.inDegree, node.outDegree, node.pagerank, node.betweenness, node.communityId].every(Number.isFinite)) {
      issues.push(`Graph node ${node.id} has invalid metrics.`);
    }
  }

  if (!nodeIds.has(graph.seedId)) issues.push('Graph seed is not present in its nodes.');

  const edgeIds = new Set<string>();
  for (const edge of graph.edges) {
    if (!edge || typeof edge.source !== 'string' || typeof edge.target !== 'string') {
      issues.push('Graph contains an invalid edge.');
      continue;
    }
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
      issues.push(`Edge ${edge.source} -> ${edge.target} references a missing node.`);
    }
    const edgeId = `${edge.source}\u0000${edge.target}`;
    if (edgeIds.has(edgeId)) issues.push(`Graph contains duplicate edge ${edge.source} -> ${edge.target}.`);
    edgeIds.add(edgeId);
  }

  return issues;
}

export async function loadExploreGraph(topic: ExploreTopic): Promise<ExploreGraphData | null> {
  const filePath = path.join(process.cwd(), 'data', 'explore', `${topic.slug}.json`);
  let contents: string;
  try {
    contents = await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }

  let data: unknown;
  try {
    data = JSON.parse(contents);
  } catch {
    throw new Error(`Explore graph data for ${topic.slug} is not valid JSON.`);
  }

  const issues = validateExploreGraph(data, topic);
  if (issues.length > 0) throw new Error(`Invalid explore graph for ${topic.slug}: ${issues.join(' ')}`);
  return data as ExploreGraphData;
}
import type { CrawlResult } from '@/types/graph';

export interface CrawlRequest {
  seed: string;
  depth: number;
  maxNodes: number;
  nonce: number;
}

export const DEFAULT_DEPTH = 2;
export const DEFAULT_MAX_NODES = 150;

function parseBoundedNumber(value: string | null, fallback: number, min: number, max: number): number {
  if (value === null || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

export function parseCrawlParams(search: string): { seed: string | null; depth: number; maxNodes: number } {
  const params = new URLSearchParams(search);
  const seed = params.get('seed')?.replace(/_/g, ' ').trim() || null;
  return {
    seed,
    depth: parseBoundedNumber(params.get('depth'), DEFAULT_DEPTH, 1, 3),
    maxNodes: parseBoundedNumber(params.get('nodes'), DEFAULT_MAX_NODES, 50, 500),
  };
}

export function createCrawlRequest(seed: string, depth: number, maxNodes: number, nonce: number): CrawlRequest {
  return { seed, depth, maxNodes, nonce };
}

export function getCrawlPayload(request: CrawlRequest): { seedTitle: string; depth: number; maxNodes: number } {
  return {
    seedTitle: request.seed,
    depth: request.depth,
    maxNodes: request.maxNodes,
  };
}

export interface ExpandRequestBody {
  seedTitle: string;
  depth: number;
  maxNodes: number;
  knownNodeIds: string[];
  knownEdgeIndexPairs: [number, number][];
  baseDepth: number;
}

/** Builds the (small) expand request body: node ids once, edges as index pairs into them. */
export function buildExpandRequestBody(
  nodeId: string,
  data: CrawlResult,
  depth: number,
  maxNodes: number,
): ExpandRequestBody {
  const knownNodeIds = data.nodes.map((node) => node.id);
  const indexById = new Map(knownNodeIds.map((id, index) => [id, index]));
  const knownEdgeIndexPairs: [number, number][] = [];
  for (const edge of data.edges) {
    const sourceIndex = indexById.get(edge.source);
    const targetIndex = indexById.get(edge.target);
    if (sourceIndex !== undefined && targetIndex !== undefined) {
      knownEdgeIndexPairs.push([sourceIndex, targetIndex]);
    }
  }

  const expandedNode = data.nodes.find((node) => node.id === nodeId);
  return {
    seedTitle: nodeId,
    depth,
    maxNodes: Math.max(50, Math.floor(maxNodes / 2)),
    knownNodeIds,
    knownEdgeIndexPairs,
    baseDepth: expandedNode?.depth ?? 0,
  };
}
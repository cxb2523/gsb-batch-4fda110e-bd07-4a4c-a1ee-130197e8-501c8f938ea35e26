import type { CrawlResult } from '@/types/graph';

export interface SharedGraph {
  graph: CrawlResult;
  depth: number;
  maxNodes: number;
  colorMode: 'community' | 'depth';
}

const MAX_LINK_LENGTH = 100_000;
const MAX_DECOMPRESSED_BYTES = 5_000_000;

async function transform(bytes: Uint8Array, format: 'compress' | 'decompress'): Promise<Uint8Array> {
  const transformer = format === 'compress' ? new CompressionStream('gzip') : new DecompressionStream('gzip');
  const reader = new Blob([bytes as BlobPart]).stream().pipeThrough(transformer).getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > MAX_DECOMPRESSED_BYTES) {
      await reader.cancel();
      throw new Error('Shared graph is too large.');
    }
    chunks.push(value);
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

export async function encodeSharedGraph(snapshot: SharedGraph): Promise<string> {
  if (typeof CompressionStream === 'undefined') throw new Error('This browser does not support graph links.');
  const bytes = await transform(new TextEncoder().encode(JSON.stringify({ version: 1, ...snapshot })), 'compress');
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  const encoded = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  if (encoded.length > MAX_LINK_LENGTH) throw new Error('This graph is too large for a share link. Download a screenshot instead.');
  return encoded;
}

export async function decodeSharedGraph(encoded: string): Promise<SharedGraph> {
  if (!encoded || encoded.length > MAX_LINK_LENGTH || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error('Invalid shared graph link.');
  if (typeof DecompressionStream === 'undefined') throw new Error('This browser does not support graph links.');
  try {
    const binary = atob(encoded.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(await transform(bytes, 'decompress')));
    return validateSharedGraph(parsed);
  } catch {
    throw new Error('Invalid or unsupported shared graph link.');
  }
}

function validateSharedGraph(value: unknown): SharedGraph {
  if (!value || typeof value !== 'object') throw new Error('Invalid snapshot');
  const snapshot = value as SharedGraph & { version: number };
  const graph = snapshot.graph;
  if (snapshot.version !== 1 || !graph || typeof graph !== 'object' ||
      !Number.isInteger(snapshot.depth) || snapshot.depth < 1 || snapshot.depth > 3 ||
      !Number.isInteger(snapshot.maxNodes) || snapshot.maxNodes < 50 || snapshot.maxNodes > 500 ||
      !['community', 'depth'].includes(snapshot.colorMode) ||
      !Array.isArray(graph.nodes) || graph.nodes.length < 1 || graph.nodes.length > 1000 ||
      !Array.isArray(graph.edges) || graph.edges.length > 50_000 ||
      !Array.isArray(graph.communities) || graph.communities.length > 1000 ||
      typeof graph.seedId !== 'string' || typeof graph.crawledAt !== 'string' ||
      !graph.positions || typeof graph.positions !== 'object' || Array.isArray(graph.positions)) throw new Error('Invalid snapshot');
  const ids = new Set<string>();
  for (const node of graph.nodes) {
    if (!node || typeof node.id !== 'string' || !node.id.trim() || node.id.length > 512 || ids.has(node.id) ||
        typeof node.title !== 'string' || !node.title.trim() || node.title.length > 512 ||
        ![node.depth, node.inDegree, node.outDegree, node.pagerank, node.betweenness, node.communityId].every(Number.isFinite)) throw new Error('Invalid node');
    ids.add(node.id);
    node.url = `https://en.wikipedia.org/wiki/${encodeURIComponent(node.title.replace(/ /g, '_'))}`;
    const position = graph.positions[node.id];
    if (position && (!Number.isFinite(position.x) || !Number.isFinite(position.y))) throw new Error('Invalid position');
  }
  if (!ids.has(graph.seedId)) throw new Error('Invalid seed');
  for (const edge of graph.edges) {
    if (!edge || !ids.has(edge.source) || !ids.has(edge.target) || edge.source === edge.target) throw new Error('Invalid edge');
  }
  for (const community of graph.communities) {
    if (!community || !Number.isFinite(community.id) || !Number.isFinite(community.size) ||
        typeof community.label !== 'string' || community.label.length > 512 || !Array.isArray(community.topPages) ||
        community.topPages.length > 1000 || !community.topPages.every((title) => typeof title === 'string' && title.length <= 512)) throw new Error('Invalid community');
  }
  graph.id = 'shared';
  return { graph, depth: snapshot.depth, maxNodes: snapshot.maxNodes, colorMode: snapshot.colorMode };
}
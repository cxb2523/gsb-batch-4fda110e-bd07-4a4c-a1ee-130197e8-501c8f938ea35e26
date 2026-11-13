export interface WikiNode {
  id: string;
  title: string;
  url: string;
  depth: number;
  inDegree: number;
  outDegree: number;
  pagerank: number;
  betweenness: number;
  communityId: number;
}

export interface WikiEdge {
  source: string;
  target: string;
}

export type WikiConnectionContext = 'lead' | 'article' | 'see_also';

export interface WikiRelationship {
  source: string;
  target: string;
  relation: string;
  context: WikiConnectionContext | null;
  explanation: string;
  evidence: string | null;
  section: string | null;
  sourceUrl: string;
  sourceContextFound: boolean;
}

export interface Community {
  id: number;
  label: string;
  size: number;
  topPages: string[];
}

export interface CrawlProgress {
  done: number;
  target: number;
}

export interface NodeMetrics {
  pagerank: number;
  betweenness: number;
  communityId: number;
  inDegree: number;
  outDegree: number;
}

export interface CrawlResult {
  id: string;
  seedId: string;
  nodes: WikiNode[];
  edges: WikiEdge[];
  communities: Community[];
  crawledAt: string;
  positions: { [key: string]: { x: number; y: number } };
  progress?: CrawlProgress;
  partial?: boolean;
  failedTitles?: string[];
  /** Updated metrics for nodes not included in `nodes` (used by expand deltas). */
  metrics?: { [nodeId: string]: NodeMetrics };
}

export interface SearchResult {
  title: string;
  url: string;
  extract?: string;
}

export interface PathResult {
  path: string[];
  length: number;
}

export interface CrawlRequest {
  seedTitle: string;
  depth: number;
  maxNodes: number;
  /** IDs of nodes already present in the client's graph; present only for expand requests. */
  knownNodeIds?: string[];
  /** Known edges as index pairs into `knownNodeIds`, used to recompute analysis without resending edges. */
  knownEdgeIndexPairs?: [number, number][];
  /** Depth of the node being expanded within the original graph. */
  baseDepth?: number;
}

import Graph from 'graphology';
import { getPageLinksBatch, getPageViews, titleToUrl } from './wikipedia';
import type { PageLinksAccumulatedPage, PageLinksBatchResult } from './wikipedia';
import { isJunkTitle } from './filters';
import type { CrawlProgress, WikiNode, WikiEdge } from '@/types/graph';
import { randomUUID } from 'node:crypto';

const WIKIPEDIA_BATCH_SIZE = 8;
const MAX_CRAWL_CONCURRENCY = 3;
const WIKIPEDIA_REQUEST_TIMEOUT_MS = 10_000;
const PAGE_LINK_LIMIT: number | undefined = undefined;
const MAX_REQUEST_BUDGET = 500;

function seededHash(seed: string, title: string): number {
  let hash = 2166136261;
  for (const character of `${seed}${title}`) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function isLowPriorityTitle(title: string): boolean {
  return /^(?:List of |Index of |\d{4}$)/i.test(title);
}

interface CrawlState {
  nodes: WikiNode[];
  nodeIds: Set<string>;
  linksByNode: Map<string, string[]>;
  visited: Set<string>;
  queue: { title: string; depth: number }[];
  resolvedTitles: Map<string, string>;
  failedTitles: Set<string>;
}

export function getCrawlRequestBudget(maxNodes: number, depth: number): number {
  const requestedDepthFactor = Math.min(Math.max(depth, 1), 3);
  const rawBudget = Math.max(maxNodes * 8, 200) * requestedDepthFactor;
  return Math.min(Math.max(rawBudget, 200), MAX_REQUEST_BUDGET);
}

export function shouldQueuePage(
  title: string,
  visited: Set<string>,
  queued: Set<string> = new Set()
): boolean {
  const normalized = normalizeTitle(title);
  if (!normalized) return false;
  if (isJunkTitle(normalized)) return false;
  if (visited.has(normalized) || queued.has(normalized)) return false;
  return true;
}

function normalizeTitle(title: string): string {
  return title.replace(/_/g, ' ').trim();
}

function getCanonicalTitle(title: string, resolvedTitles: Map<string, string>): string {
  let canonical = normalizeTitle(title);
  const seen = new Set<string>();
  while (resolvedTitles.has(canonical) && !seen.has(canonical)) {
    seen.add(canonical);
    canonical = normalizeTitle(resolvedTitles.get(canonical)!);
  }
  return canonical;
}

export interface CrawlOptions {
  seedTitle: string;
  depth: number;
  maxNodes: number;
  /** IDs already known to the caller; treated as visited (not re-fetched) but valid edge endpoints. */
  knownIds?: string[];
  /** Depth of the seed within the caller's larger graph; new node depths are offset by this. */
  baseDepth?: number;
  /** Link data already fetched by the caller for seed validation. */
  seedPage?: PageLinksBatchResult;
  /** Accumulation state associated with a pre-fetched seed page. */
  seedPaginationState?: Map<string, PageLinksAccumulatedPage>;
  onProgress?: (progress: CrawlProgress) => void;
  onBatch?: (nodes: WikiNode[], edges: WikiEdge[]) => void;
  /** AbortSignal for cancellation */
  signal?: AbortSignal;
}

export async function crawlWikipedia(options: CrawlOptions): Promise<{
  nodes: WikiNode[];
  edges: WikiEdge[];
  seedId: string;
  partial: boolean;
  failedTitles: string[];
}> {
  const {
    seedTitle,
    depth,
    maxNodes,
    knownIds = [],
    baseDepth = 0,
    seedPage,
    seedPaginationState,
    onProgress,
    onBatch,
    signal,
  } = options;
  const requestBudget = getCrawlRequestBudget(maxNodes, depth);
  const progress: CrawlState = {
    nodes: [],
    nodeIds: new Set(),
    linksByNode: new Map(),
    visited: new Set(),
    queue: [],
    resolvedTitles: new Map(),
    failedTitles: new Set(),
  };

  const queuedTitles = new Set<string>();
  const emittedEdgeKeys = new Set<string>();

  // Start with the seed page
  const seedNormalized = normalizeTitle(seedTitle);

  // Known ids are valid edge endpoints but must not be re-fetched (except the seed, which is
  // the node being expanded and needs its links discovered).
  for (const knownId of knownIds) {
    const normalizedKnown = normalizeTitle(knownId);
    progress.nodeIds.add(normalizedKnown);
    if (normalizedKnown !== seedNormalized) {
      progress.visited.add(normalizedKnown);
      queuedTitles.add(normalizedKnown);
    }
  }

  if (!isJunkTitle(seedNormalized)) {
    progress.queue.push({ title: seedNormalized, depth: 0 });
    queuedTitles.add(seedNormalized);
  }

  let progressTarget = 1;
  let lastProgressDone = -1;
  let activeWork = 0;
  let requestsUsed = 0;
  let budgetExhausted = false;
  const consumeRequestBudget = (): boolean => {
    if (signal?.aborted) return false;
    if (requestsUsed >= requestBudget) {
      budgetExhausted = true;
      return false;
    }
    requestsUsed += 1;
    return true;
  };
  const configuredConcurrency = Number(process.env.CRAWL_CONCURRENCY ?? 3);
  const crawlConcurrency = Math.min(MAX_CRAWL_CONCURRENCY, Math.max(1, Math.trunc(configuredConcurrency) || 3));

  const rankLayer = async (layer: { title: string; depth: number }[]): Promise<typeof layer> => {
    if (layer.length <= 1) return layer;
    const pageViews = await getPageViews(layer.map((item) => item.title), {
      concurrency: crawlConcurrency,
      signal,
      beforeRequest: consumeRequestBudget,
    });
    return [...layer].sort((left, right) => {
      const leftLowPriority = isLowPriorityTitle(left.title);
      const rightLowPriority = isLowPriorityTitle(right.title);
      if (leftLowPriority !== rightLowPriority) return leftLowPriority ? 1 : -1;
      const viewDifference = (pageViews.get(right.title) ?? 0) - (pageViews.get(left.title) ?? 0);
      if (viewDifference !== 0) return viewDifference;
      return seededHash(seedNormalized, left.title) - seededHash(seedNormalized, right.title);
    });
  };

  const getNewAvailableEdges = (): WikiEdge[] => {
    const newEdges: WikiEdge[] = [];
    for (const [source, links] of progress.linksByNode) {
      if (!progress.nodeIds.has(source) || isJunkTitle(source)) continue;
      for (const link of links) {
        const target = getCanonicalTitle(link, progress.resolvedTitles);
        const edgeKey = `${source}|${target}`;
        if (
          source === target ||
          isJunkTitle(target) ||
          !progress.nodeIds.has(target) ||
          emittedEdgeKeys.has(edgeKey)
        ) continue;
        emittedEdgeKeys.add(edgeKey);
        newEdges.push({ source, target });
      }
    }
    return newEdges;
  };

  const emitProgress = (complete = false) => {
    const done = progress.nodes.length;
    const needsTerminalCorrection = progressTarget > done + 1 || requestsUsed >= requestBudget;
    const wasAlreadyComplete = complete && lastProgressDone === done && !needsTerminalCorrection;
    const knownWork = done + progress.queue.length;
    progressTarget = complete
      ? done
      : Math.min(maxNodes, Math.max(progressTarget, done, knownWork));
    if (wasAlreadyComplete) return;
    lastProgressDone = done;
    onProgress?.({ done, target: Math.max(progressTarget, done) });
  };

  const processBatch = async (batch: { title: string; depth: number }[]) => {

    const batchTitles = batch.map(({ title }) => title);
    const paginationSessionId = randomUUID();
    const paginationState = batchTitles.includes(seedTitle) && seedPaginationState
      ? seedPaginationState
      : new Map<string, PageLinksAccumulatedPage>();
    const fetchBatch = async (titles: string[], continueToken?: string) => {
      if (signal?.aborted) return null;
      if (!continueToken && seedPage && titles.includes(seedTitle)) {
        return seedPage;
      }
      if (requestsUsed >= requestBudget) {
        budgetExhausted = true;
        return null;
      }

      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          return await getPageLinksBatch(titles, continueToken, {
            paginationSessionId,
            paginationState,
            beforeRequest: consumeRequestBudget,
            signal,
            timeoutMs: WIKIPEDIA_REQUEST_TIMEOUT_MS,
          });
        } catch {
          if (signal?.aborted || requestsUsed >= requestBudget) {
            break;
          }

          if (attempt === 0) {
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        }
      }

      if (signal?.aborted) {
        for (const title of batchTitles) {
          progress.failedTitles.add(title);
        }
        return null;
      }

      for (const title of batchTitles) {
        progress.failedTitles.add(title);
      }

      return null;
    };

    const batchResponse = await fetchBatch(batchTitles);
    if (!batchResponse) {
      return;
    }

    const batchNodeIds = new Set(progress.nodes.map((node) => node.id));
    for (const page of batchResponse.pages) {
      const normalizedTitle = normalizeTitle(page.title);
      const resolvedTitle = normalizeTitle(page.resolvedTitle);
      if (resolvedTitle !== normalizedTitle) progress.resolvedTitles.set(normalizedTitle, resolvedTitle);
    }
    const batchResults = batch.map(({ title, depth: currentDepth }) => {
      const canonicalTitle = getCanonicalTitle(title, progress.resolvedTitles);
      const result = batchResponse.pages.find((page) => page.title === title);
      if (progress.visited.has(canonicalTitle) || !result) {
        return null;
      }

      if (result.missing) {
        return null;
      }

      return { title, currentDepth, result, canonicalTitle };
    });

    const collectedLinks = new Map<string, string[]>();
    const satisfiedTitles = new Set<string>();
    const batchCanonicalTitles = new Set<string>();

    for (const item of batchResults) {
      if (!item) {
        activeWork -= 1;
        continue;
      }

      const { title, currentDepth, result, canonicalTitle } = item;
      if (progress.visited.has(canonicalTitle) || batchCanonicalTitles.has(canonicalTitle)) {
        activeWork -= 1;
        continue;
      }

      if (progress.nodes.length >= maxNodes) {
        activeWork -= 1;
        continue;
      }

      batchCanonicalTitles.add(canonicalTitle);
      progress.visited.add(canonicalTitle);
      const links = PAGE_LINK_LIMIT === undefined ? result.links : result.links.slice(0, PAGE_LINK_LIMIT);
      collectedLinks.set(title, links.map(normalizeTitle));
      const nodeId = canonicalTitle;
      progress.linksByNode.set(nodeId, [...(progress.linksByNode.get(nodeId) ?? []), ...links.map(normalizeTitle)]);
      if (result.complete || (PAGE_LINK_LIMIT !== undefined && links.length >= PAGE_LINK_LIMIT)) {
        satisfiedTitles.add(title);
      }

      if (!progress.nodeIds.has(nodeId)) {
        progress.nodes.push({
          id: nodeId,
          title: nodeId,
          url: titleToUrl(nodeId),
          depth: baseDepth + currentDepth,
          inDegree: 0,
          outDegree: 0,
          pagerank: 0,
          betweenness: 0,
          communityId: 0,
        });
        progress.nodeIds.add(nodeId);
      }

      if (currentDepth < depth) {
        for (const link of links) {
          const normalizedLink = normalizeTitle(link);
          const canonicalLink = getCanonicalTitle(normalizedLink, progress.resolvedTitles);
          if (
            !isJunkTitle(normalizedLink) &&
            !progress.visited.has(canonicalLink) &&
            progress.nodes.length < maxNodes &&
            shouldQueuePage(normalizedLink, progress.visited, queuedTitles)
          ) {
            progress.queue.push({ title: normalizedLink, depth: currentDepth + 1 });
            queuedTitles.add(normalizedLink);
          }
        }
      }

      activeWork -= 1;
      emitProgress();

    }

    let continueToken = batchResponse.continueToken;
    while (continueToken && progress.nodes.length < maxNodes && requestsUsed < requestBudget) {
      const activeItems = batchResults.filter((item) => item !== null && item.currentDepth < depth && !satisfiedTitles.has(item.title));
      if (activeItems.length === 0) break;
      const tokenPageId = Number(continueToken.split('|')[0]);
      const pointsIntoSatisfiedPage = Number.isFinite(tokenPageId) && batchResponse.pages.some((page) => (
        page.pageid === tokenPageId && satisfiedTitles.has(page.title)
      ));
      // A shared continuation can keep draining a page that is already complete.
      // Restart only unsatisfied titles without plcontinue when that happens.
      const paginatedResponse = await fetchBatch(
        activeItems.map((item) => item!.title),
        pointsIntoSatisfiedPage ? undefined : continueToken,
      );
      if (!paginatedResponse) {
        break;
      }

      for (const paginatedResult of paginatedResponse.pages) {
        const currentLinks = collectedLinks.get(paginatedResult.title);
        const item = batchResults.find((batchItem) => batchItem?.title === paginatedResult.title);
        if (
          currentLinks === undefined ||
          !item ||
          item.currentDepth >= depth ||
          satisfiedTitles.has(item.title)
        ) continue;

        const remaining = PAGE_LINK_LIMIT === undefined ? paginatedResult.links.length : PAGE_LINK_LIMIT - currentLinks.length;
        if (remaining <= 0) continue;
        const paginatedLinks = paginatedResult.links.slice(0, remaining);
        const nodeId = getCanonicalTitle(item.title, progress.resolvedTitles);
        const newLinks = paginatedLinks.map(normalizeTitle).filter((link) => !currentLinks.includes(link));
        progress.linksByNode.set(nodeId, [...(progress.linksByNode.get(nodeId) ?? []), ...newLinks]);

        for (const link of newLinks) {
          const normalizedLink = normalizeTitle(link);
          const canonicalLink = getCanonicalTitle(normalizedLink, progress.resolvedTitles);

          if (
            !isJunkTitle(normalizedLink) &&
            !progress.visited.has(canonicalLink) &&
            progress.nodes.length < maxNodes &&
            shouldQueuePage(normalizedLink, progress.visited, queuedTitles)
          ) {
            progress.queue.push({ title: normalizedLink, depth: item.currentDepth + 1 });
            queuedTitles.add(normalizedLink);
          }
        }

        collectedLinks.set(paginatedResult.title, [...currentLinks, ...newLinks]);
        if (paginatedResult.complete || (PAGE_LINK_LIMIT !== undefined && currentLinks.length + newLinks.length >= PAGE_LINK_LIMIT)) {
          satisfiedTitles.add(item.title);
        }
      }

      continueToken = paginatedResponse.continueToken;
    }
    if (continueToken && requestsUsed >= requestBudget) budgetExhausted = true;

    onBatch?.(progress.nodes.filter((node) => !batchNodeIds.has(node.id)), getNewAvailableEdges());
  };

  while (progress.queue.length > 0 && progress.nodes.length < maxNodes && requestsUsed < requestBudget) {
    if (signal?.aborted) {
      throw new Error('Crawl aborted');
    }
    
    const layerDepth = progress.queue[0].depth;
    const layer = await rankLayer(progress.queue.splice(0, progress.queue.length).filter((item) => item.depth === layerDepth));
    const remainingNodeBudget = maxNodes - progress.nodes.length;
    const layerQuota = depth >= 2 && layerDepth === 1
      ? Math.min(remainingNodeBudget, Math.ceil(maxNodes * 0.4))
      : remainingNodeBudget;
    const admittedLayer = layer.slice(0, layerQuota);
    const batches: { title: string; depth: number }[][] = [];
    for (let index = 0; index < admittedLayer.length; index += WIKIPEDIA_BATCH_SIZE) {
      batches.push(admittedLayer.slice(index, index + WIKIPEDIA_BATCH_SIZE));
    }
    activeWork = layer.length;
    let nextBatchIndex = 0;
    const workers = Array.from({ length: Math.min(crawlConcurrency, batches.length) }, async () => {
      while (nextBatchIndex < batches.length && requestsUsed < requestBudget) {
        if (signal?.aborted) {
          throw new Error('Crawl aborted');
        }
        await processBatch(batches[nextBatchIndex++]);
      }
      if (nextBatchIndex < batches.length && requestsUsed >= requestBudget) budgetExhausted = true;
    });
    await Promise.all(workers);
  }
  if (progress.queue.length > 0 && requestsUsed >= requestBudget) budgetExhausted = true;

  const edgeKeys = new Set<string>();
  const edges: WikiEdge[] = [];
  for (const [source, links] of progress.linksByNode) {
    if (isJunkTitle(source)) continue;
    for (const link of links) {
      const target = getCanonicalTitle(link, progress.resolvedTitles);
      if (isJunkTitle(target) || !progress.nodeIds.has(target)) continue;
      const edgeKey = `${source}|${target}`;
      if (source !== target && !edgeKeys.has(edgeKey)) {
        edgeKeys.add(edgeKey);
        edges.push({ source, target });
      }
    }
  }
  const inDegreeMap = new Map<string, number>();
  const outDegreeMap = new Map<string, number>();
  for (const edge of edges) {
    outDegreeMap.set(edge.source, (outDegreeMap.get(edge.source) ?? 0) + 1);
    inDegreeMap.set(edge.target, (inDegreeMap.get(edge.target) ?? 0) + 1);
  }
  for (const node of progress.nodes) {
    node.outDegree = outDegreeMap.get(node.id) ?? 0;
    node.inDegree = inDegreeMap.get(node.id) ?? 0;
  }
  onBatch?.([], edges.filter((edge) => !emittedEdgeKeys.has(`${edge.source}|${edge.target}`)));

  emitProgress(true);

  const resolvedSeedId = getCanonicalTitle(seedTitle, progress.resolvedTitles);
  return {
    nodes: progress.nodes,
    edges,
    seedId: resolvedSeedId,
    partial: progress.failedTitles.size > 0 || budgetExhausted,
    failedTitles: [...progress.failedTitles],
  };
}

export function sanitizeGraphData(nodes: WikiNode[], edges: WikiEdge[]): { nodes: WikiNode[]; edges: WikiEdge[] } {
  const validNodeIds = new Set(nodes.filter((node) => node && node.id).map((node) => node.id));
  const dedupedNodes = Array.from(new Map(nodes.filter((node) => node && node.id).map((node) => [node.id, node])).values());
  const validEdges = edges.filter((edge) => {
    if (!edge) return false;
    if (!edge.source || !edge.target) return false;
    if (edge.source === edge.target) return false;
    return validNodeIds.has(edge.source) && validNodeIds.has(edge.target);
  });

  return { nodes: dedupedNodes, edges: validEdges };
}

export function buildGraph(nodes: WikiNode[], edges: WikiEdge[]): Graph {
  const { nodes: validNodes, edges: validEdges } = sanitizeGraphData(nodes, edges);
  const graph = new Graph({ type: 'directed' });
  
  const addedNodes = new Set<string>();
  
  for (const node of validNodes) {
    if (!addedNodes.has(node.id)) {
      graph.addNode(node.id, {
        title: node.title,
        url: node.url,
        depth: node.depth,
        pagerank: node.pagerank,
        betweenness: node.betweenness,
        communityId: node.communityId,
      });
      addedNodes.add(node.id);
    }
  }
  
  for (const edge of validEdges) {
    if (graph.hasNode(edge.source) && graph.hasNode(edge.target)) {
      if (!graph.hasEdge(edge.source, edge.target)) {
        try {
          graph.addEdge(edge.source, edge.target);
        } catch {
          // Edge already exists, ignore
        }
      }
    }
  }
  
  return graph;
}

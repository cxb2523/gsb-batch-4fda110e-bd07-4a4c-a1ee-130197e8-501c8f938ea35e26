import { NextRequest, NextResponse } from 'next/server';
import { crawlWikipedia, buildGraph, sanitizeGraphData } from '@/lib/crawler';
import { analyzeGraph } from '@/lib/graphAnalysis';
import { getCachedResult, setCachedResult, generateCacheKey } from '@/lib/db';
import { getPageLinksBatch, searchWikipedia } from '@/lib/wikipedia';
import type { PageLinksAccumulatedPage } from '@/lib/wikipedia';
import { nanoid } from 'nanoid';
import type { CrawlProgress, CrawlResult, CrawlRequest, WikiNode, WikiEdge } from '@/types/graph';
import { createSlidingWindowRateLimiter } from '@/lib/rateLimit';
import { trackEvent } from '@/lib/analytics';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Assumes a Vercel plan that permits 60 seconds for this Node.js function.
export const maxDuration = 60;
const MAX_EXPAND_KNOWN_NODES = 500;
const MAX_EXPAND_KNOWN_EDGES = 50_000;
const MAX_EXPAND_NODE_ID_LENGTH = 512;
const MIN_DEPTH = 1;
const MAX_DEPTH = 3;
const MIN_MAX_NODES = 50;
const MAX_MAX_NODES = 500;
const MAX_SEED_TITLE_LENGTH = 512;
const CRAWL_RATE_LIMIT = 60;
const CRAWL_RATE_WINDOW_MS = 10 * 60 * 1000;
const consumeCrawlRateLimit = createSlidingWindowRateLimiter({
  limit: CRAWL_RATE_LIMIT,
  windowMs: CRAWL_RATE_WINDOW_MS,
});
const encoder = new TextEncoder();

function sendStreamEvent(controller: ReadableStreamDefaultController, event: string, payload: unknown) {
  try {
    controller.enqueue(
      encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
    );
    return true;
  } catch {
    return false;
  }
}

function closeStream(controller: ReadableStreamDefaultController): void {
  try {
    controller.close();
  } catch {
    // The client may have disconnected before the crawl completed.
  }
}

function sanitizeExpansionDelta(
  knownNodeIds: string[],
  nodes: WikiNode[],
  edges: WikiEdge[],
): { nodes: WikiNode[]; edges: WikiEdge[] } {
  const knownIds = new Set(knownNodeIds);
  const newNodes = sanitizeGraphData(nodes, []).nodes.filter((node) => !knownIds.has(node.id));
  const validIds = new Set([...knownIds, ...newNodes.map((node) => node.id)]);
  const validEdges = new Map<string, WikiEdge>();

  for (const edge of edges) {
    if (
      !edge?.source || !edge.target ||
      edge.source === edge.target ||
      !validIds.has(edge.source) ||
      !validIds.has(edge.target)
    ) continue;

    validEdges.set(`${edge.source}|${edge.target}`, edge);
  }

  return { nodes: newNodes, edges: [...validEdges.values()] };
}

export async function POST(request: NextRequest) {
  try {
    const crawlId = nanoid();
    const crawlStartedAt = Date.now();
    const body = (await request.json()) as CrawlRequest;
    const { seedTitle, depth, maxNodes, knownNodeIds, knownEdgeIndexPairs, baseDepth } = body;

    // Validate seedTitle
    if (!seedTitle || typeof seedTitle !== 'string') {
      return NextResponse.json(
        { error: 'seedTitle is required' },
        { status: 400 }
      );
    }

    if (seedTitle.trim().length === 0) {
      return NextResponse.json(
        { error: 'seedTitle must not be empty' },
        { status: 400 }
      );
    }

    if (seedTitle.length > MAX_SEED_TITLE_LENGTH) {
      return NextResponse.json(
        { error: 'seedTitle is too long' },
        { status: 400 }
      );
    }

    // Validate depth
    if (depth !== undefined && depth !== null) {
      if (typeof depth !== 'number' || !Number.isInteger(depth)) {
        return NextResponse.json(
          { error: 'depth must be an integer' },
          { status: 400 }
        );
      }

      if (depth < MIN_DEPTH || depth > MAX_DEPTH) {
        return NextResponse.json(
          { error: `depth must be between ${MIN_DEPTH} and ${MAX_DEPTH}` },
          { status: 400 }
        );
      }
    }

    // Validate maxNodes
    if (maxNodes !== undefined && maxNodes !== null) {
      if (typeof maxNodes !== 'number' || !Number.isInteger(maxNodes)) {
        return NextResponse.json(
          { error: 'maxNodes must be an integer' },
          { status: 400 }
        );
      }

      if (maxNodes < MIN_MAX_NODES || maxNodes > MAX_MAX_NODES) {
        return NextResponse.json(
          { error: `maxNodes must be between ${MIN_MAX_NODES} and ${MAX_MAX_NODES}` },
          { status: 400 }
        );
      }
    }

    const isExpand = Array.isArray(knownNodeIds);
    const knownIds = knownNodeIds ?? [];
    if (isExpand) {
      if (
        knownIds.length === 0 ||
        knownIds.length > MAX_EXPAND_KNOWN_NODES
      ) {
        return NextResponse.json(
          { error: 'Invalid expansion node count' },
          { status: 400 }
        );
      }

      if (
        !Array.isArray(knownEdgeIndexPairs) ||
        knownEdgeIndexPairs.length > MAX_EXPAND_KNOWN_EDGES
      ) {
        return NextResponse.json(
          { error: 'Invalid expansion edge count' },
          { status: 400 }
        );
      }

      const uniqueNodeIds = new Set<string>();

      for (const id of knownIds) {
        if (
          typeof id !== 'string' ||
          id.trim().length === 0 ||
          id.length > MAX_EXPAND_NODE_ID_LENGTH
        ) {
          return NextResponse.json(
            { error: 'Invalid expansion node id' },
            { status: 400 }
          );
        }

        if (uniqueNodeIds.has(id)) {
          return NextResponse.json(
            { error: 'Duplicate expansion node id' },
            { status: 400 }
          );
        }

        uniqueNodeIds.add(id);
      }

      for (const pair of knownEdgeIndexPairs) {
        if (
          !Array.isArray(pair) ||
          pair.length !== 2 ||
          !Number.isInteger(pair[0]) ||
          !Number.isInteger(pair[1]) ||
          pair[0] < 0 ||
          pair[1] < 0 ||
          pair[0] >= knownIds.length ||
          pair[1] >= knownIds.length
        ) {
          return NextResponse.json(
            { error: 'Invalid expansion edge index' },
            { status: 400 }
          );
        }
      }
    }

    // Validate baseDepth (only used for expand, but validate if present)
    if (baseDepth !== undefined && baseDepth !== null) {
      if (typeof baseDepth !== 'number') {
        return NextResponse.json(
          { error: 'baseDepth must be a number' },
          { status: 400 }
        );
      }

      if (!Number.isFinite(baseDepth)) {
        return NextResponse.json(
          { error: 'baseDepth must be a finite number' },
          { status: 400 }
        );
      }

      if (baseDepth < 0) {
        return NextResponse.json(
          { error: 'baseDepth must be non-negative' },
          { status: 400 }
        );
      }
    }

    const validatedBaseDepth = baseDepth !== undefined && baseDepth !== null
      ? Math.max(Math.trunc(Number(baseDepth)), 0)
      : 0;
    const validatedDepth = Math.min(Math.max(depth ?? 2, MIN_DEPTH), MAX_DEPTH);
    const validatedMaxNodes = Math.min(Math.max(maxNodes ?? 150, MIN_MAX_NODES), MAX_MAX_NODES);

    const clientAddress = request.headers.get('x-real-ip')?.trim()
      || request.headers.get('x-forwarded-for')?.split(',').at(-1)?.trim()
      || 'unknown';
    const rateLimit = consumeCrawlRateLimit(clientAddress);
    const rateLimitHeaders = {
      'RateLimit-Limit': String(rateLimit.limit),
      'RateLimit-Remaining': String(rateLimit.remaining),
      'RateLimit-Reset': String(Math.ceil(rateLimit.resetAt / 1000)),
    };

    if (!rateLimit.allowed) {
      return NextResponse.json(
        { error: 'Too many crawl requests. Please wait before trying again.' },
        {
          status: 429,
          headers: {
            ...rateLimitHeaders,
            'Retry-After': String(rateLimit.retryAfterSeconds),
          },
        },
      );
    }

    // Check crawl cache first before making Wikipedia API calls
    const cacheKey = generateCacheKey(seedTitle, validatedDepth, validatedMaxNodes);
    const cachedResult = isExpand ? null : getCachedResult(cacheKey);

    if (cachedResult) {
      return NextResponse.json(cachedResult);
    }
      await trackEvent({
      event_name: 'crawl_started',
      session_id: crawlId,
      metadata: {
        seedTitle,
        depth: validatedDepth,
        maxNodes: validatedMaxNodes,
        isExpand,
      },
    });

    const seedPaginationState = new Map<string, PageLinksAccumulatedPage>();
    const seedPageBatch = await getPageLinksBatch([seedTitle], undefined, {
      paginationState: seedPaginationState,
      signal: request.signal,
      timeoutMs: 10_000,
    });
    const seedPage = seedPageBatch.pages[0];
    if (!seedPage || seedPage.missing) {
      const suggestions = await searchWikipedia(seedTitle)
        .then((results) => results.map((result) => result.title))
        .catch(() => []);
      return NextResponse.json(
        { error: 'not_found', title: seedTitle, suggestions },
        { status: 404 },
      );
    }

    const stream = new ReadableStream({
      async start(controller) {
        let crawlProgress: CrawlProgress = { done: 0, target: 1 };
        const heartbeat = setInterval(() => {
          sendStreamEvent(controller, 'progress', { progress: crawlProgress });
        }, 2000);
        try {
          const { nodes: crawledNodes, edges: crawledEdges, seedId: crawledSeedId, partial, failedTitles } = await crawlWikipedia({
            seedTitle,
            depth: validatedDepth,
            maxNodes: validatedMaxNodes,
            knownIds,
            baseDepth: validatedBaseDepth,
            seedPage: { pages: [seedPage], continueToken: seedPageBatch.continueToken },
            seedPaginationState,
            signal: request.signal,
            onProgress: (progress) => {
              crawlProgress = progress;
              sendStreamEvent(controller, 'progress', { progress: crawlProgress });
            },
            onBatch: (nodes, edges) => {
              if (nodes.length > 0) sendStreamEvent(controller, 'nodes', { nodes });
              if (edges.length > 0) sendStreamEvent(controller, 'edges', { edges });
            },
          });

          if (partial) {
            sendStreamEvent(controller, 'warning', { failedTitles });
          }

          const { nodes: deltaNodes, edges: deltaEdges } = isExpand
            ? sanitizeExpansionDelta(knownIds, crawledNodes, crawledEdges)
            : sanitizeGraphData(crawledNodes, crawledEdges);
          const deltaNodeIds = new Set(deltaNodes.map((node) => node.id));

          // Reconstruct the caller's known edges (decoded from index pairs) so pagerank/betweenness/
          // communities are computed for the whole merged graph, without the client resending it.
          const knownEdges: WikiEdge[] = isExpand
            ? (knownEdgeIndexPairs ?? [])
                .filter(([sourceIndex, targetIndex]) => knownIds[sourceIndex] !== undefined && knownIds[targetIndex] !== undefined)
                .map(([sourceIndex, targetIndex]) => ({ source: knownIds[sourceIndex], target: knownIds[targetIndex] }))
            : [];

          const analysisNodeSource: WikiNode[] = isExpand
            ? [
                ...knownIds.map((id): WikiNode => ({
                  id, title: id, url: '', depth: 0,
                  inDegree: 0, outDegree: 0, pagerank: 0, betweenness: 0, communityId: 0,
                })),
                ...deltaNodes,
              ]
            : deltaNodes;
          const analysisEdgeSource = isExpand ? [...knownEdges, ...deltaEdges] : deltaEdges;

          const { nodes: validAnalysisNodes, edges: validAnalysisEdges } = sanitizeGraphData(analysisNodeSource, analysisEdgeSource);
          const graph = buildGraph(validAnalysisNodes, validAnalysisEdges);

          const seedId = crawledSeedId;
          sendStreamEvent(controller, 'stage', { stage: 'analyzing' });
          const { nodes: analyzedNodes, communities } = analyzeGraph(graph, seedId);

          const allMetrics = Object.fromEntries(analyzedNodes.map((node) => [node.id, {
            pagerank: node.pagerank,
            betweenness: node.betweenness,
            communityId: node.communityId,
            inDegree: node.inDegree,
            outDegree: node.outDegree,
          }]));
          sendStreamEvent(controller, 'analysis', { metrics: allMetrics, communities });

          // Expand responses are deltas: only new nodes/edges, plus updated metrics for known nodes.
          const resultNodes = isExpand ? analyzedNodes.filter((node) => deltaNodeIds.has(node.id)) : analyzedNodes;
          const resultEdges = isExpand ? deltaEdges : validAnalysisEdges;
          const resultMetrics = isExpand
            ? Object.fromEntries(Object.entries(allMetrics).filter(([id]) => !deltaNodeIds.has(id)))
            : undefined;

          const result: CrawlResult = {
            id: nanoid(),
            seedId,
            nodes: resultNodes,
            edges: resultEdges,
            communities,
            crawledAt: new Date().toISOString(),
            positions: {},
            progress: { done: 1, target: 1 },
            partial,
            failedTitles,
            metrics: resultMetrics,
          };

          if (!isExpand && !partial) {
            setCachedResult(cacheKey, seedTitle, validatedDepth, validatedMaxNodes, result);
          }
         await trackEvent({
          event_name: 'crawl_completed',
          session_id: crawlId,
          duration_ms: Date.now() - crawlStartedAt,
          metadata: {
            seedTitle,
            depth: validatedDepth,
            maxNodes: validatedMaxNodes,
            nodeCount: result.nodes.length,
            edgeCount: result.edges.length,
            partial,
            isExpand,
          },
        });
        
        sendStreamEvent(controller, 'done', { result });
        clearInterval(heartbeat);
        closeStream(controller);
        } catch (error) {
          clearInterval(heartbeat);
          console.error('Crawl error:', error);
          await trackEvent({
          event_name: 'crawl_failed',
          session_id: crawlId,
          duration_ms: Date.now() - crawlStartedAt,
          metadata: {
            seedTitle,
            depth: validatedDepth,
            maxNodes: validatedMaxNodes,
            isExpand,
            error: String(error),
          },
        });
          sendStreamEvent(controller, 'error', {
            error: 'Failed to crawl Wikipedia',
            details: String(error),
          });
          closeStream(controller);
        }
      },
    });

    return new Response(stream, {
      headers: {
        ...rateLimitHeaders,
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      },
    });
  } catch (error) {
    console.error('Crawl request error:', error);
    return NextResponse.json(
      { error: 'Failed to crawl Wikipedia', details: String(error) },
      { status: 500 }
    );
  }
}

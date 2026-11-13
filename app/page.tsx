'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import type { Community, CrawlResult, WikiEdge, WikiNode, PathResult } from '@/types/graph';
import { createCrawlRequest, getCrawlPayload, parseCrawlParams, buildExpandRequestBody, type CrawlRequest } from '@/lib/crawlRequest';
import { mergeGraphData } from '@/lib/graphSync';
import { decodeSharedGraph } from '@/lib/shareGraph';
import { SeedSearch } from './components/SeedSearch';
import { CrawlControls } from './components/CrawlControls';
import { MemoizedSidebar } from './components/Sidebar';
import { MemoizedNodeDetailPanel } from './components/NodeDetailPanel';
import { usePathfinder } from './components/usePathfinder';
import { exploreTopics } from '@/lib/exploreTopics';

// Dynamically import GraphCanvas to avoid SSR issues with WebGL/Sigma
const GraphCanvas = dynamic(
  () => import('./components/GraphCanvas').then(mod => mod.GraphCanvas),
  { 
    ssr: false,
    loading: () => (
      <div className="flex items-center justify-center h-full bg-gradient-to-b from-gray-950 to-slate-950">
        <div className="loading-spinner" />
      </div>
    )
  }
);

type ColorMode = 'community' | 'depth';

const exampleTopics = ['Alan Turing', 'Climate change', 'Jazz', 'Quantum mechanics'];

class CrawlNotFoundError extends Error {
  constructor(public readonly title: string, public readonly suggestions: string[]) {
    super('not_found');
  }
}

function validateGraphData(data: Partial<CrawlResult> | null | undefined): string[] {
  if (!data) {
    return ['No graph data is available.'];
  }

  const issues: string[] = [];
  if (!Array.isArray(data.nodes)) {
    issues.push('Node list is missing.');
    return issues;
  }

  if (!Array.isArray(data.edges)) {
    issues.push('Edge list is missing.');
  }

  if (data.nodes.length === 0) {
    issues.push('Graph is empty.');
  }

  const nodeIds = new Set<string>();
  let hasDuplicateNodeIds = false;
  for (const node of data.nodes) {
    if (node?.id && nodeIds.has(node.id)) hasDuplicateNodeIds = true;
    if (node?.id) nodeIds.add(node.id);
  }
  if (hasDuplicateNodeIds) issues.push('Graph contains duplicate node IDs.');

  const validNodeIds = nodeIds;
  for (const edge of data.edges ?? []) {
    if (!validNodeIds.has(edge.source) || !validNodeIds.has(edge.target)) {
      if (issues.length < 10) issues.push(`Edge references missing nodes: ${edge.source} -> ${edge.target}`);
    }
  }

  for (const node of data.nodes) {
    if (!node || typeof node.id !== 'string' || !node.id.trim()) {
      if (issues.length < 10) issues.push('A node has an invalid id.');
      continue;
    }

    if (!Number.isFinite(node.depth)) {
      if (issues.length < 10) issues.push(`Node ${node.id} has an invalid depth.`);
    }

    if (!Number.isFinite(node.pagerank)) {
      if (issues.length < 10) issues.push(`Node ${node.id} has an invalid PageRank.`);
    }

    if (!Number.isFinite(node.betweenness)) {
      if (issues.length < 10) issues.push(`Node ${node.id} has an invalid betweenness value.`);
    }

    if (data.positions?.[node.id] && (!Number.isFinite(data.positions[node.id].x) || !Number.isFinite(data.positions[node.id].y))) {
      if (issues.length < 10) issues.push(`Node ${node.id} has invalid saved coordinates.`);
    }
  }

  const invalidPositions = Object.entries(data.positions ?? {}).filter(([, pos]) => (
    !pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)
  ));

  if (invalidPositions.length > 0) {
    if (issues.length < 10) issues.push('One or more saved node positions are invalid.');
  }

  return issues;
}

function createSeedPreview(title: string): CrawlResult {
  const normalizedTitle = title.trim().replace(/_/g, ' ');
  const seed: WikiNode = {
    id: normalizedTitle,
    title: normalizedTitle,
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(normalizedTitle.replace(/ /g, '_'))}`,
    depth: 0,
    inDegree: 0,
    outDegree: 0,
    pagerank: 1,
    betweenness: 0,
    communityId: 0,
  };

  return {
    id: 'streaming',
    seedId: normalizedTitle,
    nodes: [seed],
    edges: [],
    communities: [],
    crawledAt: new Date().toISOString(),
    positions: {},
  };
}

async function readCrawlResponse(
  response: Response,
  handlers?: {
    onNodes?: (nodes: WikiNode[]) => void;
    onEdges?: (edges: WikiEdge[]) => void;
    onStage?: (stage: 'crawling' | 'analyzing') => void;
    onAnalysis?: (metrics: Record<string, Partial<WikiNode>>, communities: Community[]) => void;
    onWarning?: (failedTitles: string[]) => void;
  }
): Promise<CrawlResult> {
  if (!response.ok) {
    const errorData = await response.json();
    if (response.status === 404 && errorData.error === 'not_found') {
      throw new CrawlNotFoundError(errorData.title, errorData.suggestions ?? []);
    }
    throw new Error(errorData.error || 'Failed to crawl');
  }

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/event-stream')) {
    return response.json() as Promise<CrawlResult>;
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing response stream');

  const decoder = new TextDecoder();
  let buffer = '';
  let finalResult: CrawlResult | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split('\n\n');
    buffer = chunks.pop() ?? '';

    for (const chunk of chunks) {
      const eventLine = chunk.split('\n').find((line) => line.startsWith('event:'));
      const dataLine = chunk.split('\n').find((line) => line.startsWith('data:'));
      if (!dataLine) continue;

      const payload = JSON.parse(dataLine.slice(5).trim());
      const event = eventLine?.slice(6).trim();
      if (event === 'nodes') handlers?.onNodes?.(payload.nodes ?? []);
      if (event === 'edges') handlers?.onEdges?.(payload.edges ?? []);
      if (event === 'stage' && (payload.stage === 'crawling' || payload.stage === 'analyzing')) {
        handlers?.onStage?.(payload.stage);
      }
      if (event === 'analysis') handlers?.onAnalysis?.(payload.metrics ?? {}, payload.communities ?? []);
      if (event === 'warning') handlers?.onWarning?.(payload.failedTitles ?? []);
      if (payload?.result) {
        finalResult = payload.result as CrawlResult;
      }
      if (payload?.error) throw new Error(payload.error);
    }
  }

  if (!finalResult) throw new Error('Crawl stream ended without a final result');
  return finalResult;
}

// Animated background particles
function AnimatedBackground() {
  return (
    <div className="animated-bg">
      <div className="grid-overlay" />
    </div>
  );
}

export default function Home() {
  const queryClient = useQueryClient();
  
  // State
  const [depth, setDepth] = useState(2);
  const [maxNodes, setMaxNodes] = useState(150);
  const [submittedRequest, setSubmittedRequest] = useState<CrawlRequest | null>(null);
  const [colorMode, setColorMode] = useState<ColorMode>('community');
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [reduceEffects, setReduceEffects] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [focusedNode, setFocusedNode] = useState<string | null>(null);
  const [focusedCommunityId, setFocusedCommunityId] = useState<number | null>(null);
  const [pathSelection, setPathSelection] = useState<{ from: string; to: string; result: PathResult | null } | null>(null);
  const [liveData, setLiveData] = useState<CrawlResult | null>(null);
  const [seedPreview, setSeedPreview] = useState(false);
  const [crawlStage, setCrawlStage] = useState<'crawling' | 'analyzing'>('crawling');
  const previousDataRef = useRef<CrawlResult | null>(null);
  const [graphError, setGraphError] = useState<string | null>(null);
  const [sharedGraphLoading, setSharedGraphLoading] = useState(false);
  const [sharedGraphError, setSharedGraphError] = useState<string | null>(null);
  const [crawlWarning, setCrawlWarning] = useState<number | null>(null);
  const [notFound, setNotFound] = useState<{ title: string; suggestions: string[] } | null>(null);
  const [expandedNodeIds, setExpandedNodeIds] = useState<Set<string>>(new Set());
  const [expandingNodeId, setExpandingNodeId] = useState<string | null>(null);
  const [expandNotice, setExpandNotice] = useState<string | null>(null);
  const liveUpdateRef = useRef<{ nonce: number; update: (current: CrawlResult) => CrawlResult } | null>(null);
  const liveUpdateFrameRef = useRef<number | null>(null);
  const submittedRequestRef = useRef<CrawlRequest | null>(null);
  const requestNonceRef = useRef(0);

  useEffect(() => {
    const lowPower = typeof navigator !== 'undefined' && (navigator.hardwareConcurrency ?? 8) <= 4;
    const reducedMotion = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    setReduceEffects(lowPower || reducedMotion);
  }, []);

  const mergeLiveData = useCallback((request: CrawlRequest, update: (current: CrawlResult) => CrawlResult) => {
    const pending = liveUpdateRef.current;
    if (!pending || request.nonce > pending.nonce) {
      liveUpdateRef.current = { nonce: request.nonce, update };
    } else if (pending.nonce === request.nonce) {
      liveUpdateRef.current = { nonce: request.nonce, update: (current) => update(pending.update(current)) };
    }
    // Updates from an older crawl request are never composed or queued.

    if (liveUpdateFrameRef.current !== null) return;

    liveUpdateFrameRef.current = window.requestAnimationFrame(() => {
      const pending = liveUpdateRef.current;
      liveUpdateRef.current = null;
      liveUpdateFrameRef.current = null;
      const activeRequest = submittedRequestRef.current;
      if (!pending || !activeRequest || activeRequest.nonce !== pending.nonce) return;

      setLiveData((current) => pending.update(current ?? {
        id: 'streaming',
        seedId: activeRequest.seed,
        nodes: [],
        edges: [],
        communities: [],
        crawledAt: new Date().toISOString(),
        positions: {},
      }));
    });
  }, []);

  useEffect(() => () => {
    if (liveUpdateFrameRef.current !== null) {
      window.cancelAnimationFrame(liveUpdateFrameRef.current);
    }
  }, []);

  // Query for crawl data
  const { data, isLoading, error, refetch } = useQuery<CrawlResult>({
    queryKey: submittedRequest
      ? ['crawl', submittedRequest.seed, submittedRequest.depth, submittedRequest.maxNodes, submittedRequest.nonce]
      : ['crawl', 'idle'],
    queryFn: async ({ signal }) => {
      if (!submittedRequest) throw new Error('No crawl request submitted');
      const request = submittedRequest;
      const isCurrentRequest = () => submittedRequestRef.current?.nonce === request.nonce;

      try {
        const response = await fetch('/api/crawl', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(getCrawlPayload(request)),
          signal,
        });
        const result = await readCrawlResponse(response, {
            onStage: (stage) => {
              if (isCurrentRequest()) setCrawlStage(stage);
            },
            onNodes: (nodes) => {
              if (nodes.length > 0 && isCurrentRequest()) setSeedPreview(false);
              mergeLiveData(request, (current) => ({
                ...current,
                nodes: (() => {
                  const merged = new Map(current.nodes.map((node) => [node.id, node]));
                  for (const node of nodes) if (node?.id) merged.set(node.id, node);
                  return [...merged.values()];
                })(),
              }));
            },
            onEdges: (edges) => mergeLiveData(request, (current) => ({
              ...current,
              edges: (() => {
                const merged = new Map(current.edges.map((edge) => [`${edge.source}|${edge.target}`, edge]));
                for (const edge of edges) if (edge?.source && edge?.target) merged.set(`${edge.source}|${edge.target}`, edge);
                return [...merged.values()];
              })(),
            })),
            onAnalysis: (metrics, communities) => mergeLiveData(request, (current) => ({
              ...current,
              nodes: current.nodes.map((node) => ({ ...node, ...(metrics[node.id] ?? {}) })),
              communities,
            })),
            onWarning: (failedTitles) => {
              if (!isCurrentRequest()) return;
              setCrawlWarning(failedTitles.length);
            },
        });
        const issues = validateGraphData(result);
        if (issues.length > 0) throw new Error(issues[0]);
        return result;
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          throw error;
        }
        if (error instanceof CrawlNotFoundError) {
          if (isCurrentRequest()) {
            setNotFound({
              title: error.title,
              suggestions: error.suggestions,
            });
            setGraphError(null);
          }

          throw error;
        }

        const message = error instanceof Error
          ? error.message
          : 'Unable to explore this topic right now.';

        if (isCurrentRequest()) {
          setGraphError(message);
        }

        throw error;
      }
    },
    enabled: submittedRequest !== null,
    retry: false,
    staleTime: 1000 * 60 * 30, // 30 minutes
  });

  const displayData = data ?? liveData ?? previousDataRef.current;
  const creationStage = crawlStage === 'analyzing'
    ? 'Ranking pages and finding communities'
    : !displayData
    ? 'Opening a new trail'
    : liveData && liveData.nodes.length < 2
      ? 'Finding the first links'
      : liveData && liveData.communities.length === 0
        ? 'Mapping connections'
        : 'Arranging the neighborhoods';
  const streamingPageCount = liveData?.nodes.length ?? 0;
  const streamingPageLabel = `${streamingPageCount} ${streamingPageCount === 1 ? 'page' : 'pages'} in map`;
  const crawlStatus = error
    ? `Crawl error: ${error instanceof Error ? error.message : 'unable to load pages'}`
    : isLoading
      ? `Crawl in progress: ${Math.max(0, (displayData?.nodes.length ?? 0) - (seedPreview ? 1 : 0))} pages found`
      : data
        ? `Crawl complete: ${data.nodes.length} pages found`
        : '';
  const pathfinder = usePathfinder(displayData);
  const selectedNode = displayData?.nodes.find((node) => node.id === selectedNodeId) ?? null;

  useEffect(() => {
    if (data) setLiveData(null);
  }, [data]);

  useEffect(() => {
    if (!pathSelection || !displayData) return;
    const nodeIds = new Set(displayData.nodes.map((node) => node.id));
    if (!nodeIds.has(pathSelection.from) || !nodeIds.has(pathSelection.to)) setPathSelection(null);
  }, [displayData, pathSelection]);

  useEffect(() => {
  const handlePopState = () => {
    setSelectedNodeId(null);
    setFocusedNode(null);
    setFocusedCommunityId(null);
    setPathSelection(null);
  };

  window.addEventListener('popstate', handlePopState);

  return () => {
    window.removeEventListener('popstate', handlePopState);
  };
}, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPathSelection(null);
        setFocusedCommunityId(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    if (!displayData) return;

    if (selectedNodeId && !displayData.nodes.some((node) => node.id === selectedNodeId)) {
      setSelectedNodeId(null);
    }
  }, [displayData, selectedNodeId]);

  // Expand mutation
  const expandMutation = useMutation({
    mutationFn: async (nodeId: string) => {
      if (!displayData) throw new Error('No graph data available to expand.');
      if (!submittedRequest) throw new Error('No active crawl request.');
      const nonce = submittedRequest.nonce;
      const currentData = displayData;
      const currentDepth = depth;
      const currentMaxNodes = maxNodes;
      const response = await fetch('/api/crawl', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildExpandRequestBody(nodeId, currentData, currentDepth, currentMaxNodes)),
      });

      const result = await readCrawlResponse(response);
      if (!Array.isArray(result.nodes) || !Array.isArray(result.edges)) {
        throw new Error('Received an invalid response while expanding this page.');
      }
      return { nodeId, result, nonce };
    },
    onSuccess: ({ nodeId, result, nonce }) => {
      if (submittedRequest?.nonce !== nonce) {
        // Ignore expand responses from old graphs
        return;
      }

      if (!result.partial) {
        setExpandedNodeIds((current) => {
          const next = new Set(current);
          next.add(nodeId);
          return next;
        });
      }

      setExpandNotice(
        result.nodes.length === 0
          ? `No new pages found from "${nodeId}".`
          : null
      );
      if (displayData && submittedRequest) {
        const queryKey = ['crawl', submittedRequest.seed, submittedRequest.depth, submittedRequest.maxNodes, submittedRequest.nonce];
        const currentData = queryClient.getQueryData<CrawlResult>(queryKey) ?? displayData;
        queryClient.setQueryData(queryKey, mergeGraphData(currentData, result));
      }
    },
    onError: (error) => {
      if (error instanceof Error && error.name === 'AbortError') {
        // Don't show error for aborted expand requests
        return;
      }
      setGraphError(error instanceof Error ? error.message : 'Could not explore this page.');
    },
    onSettled: () => {
      setExpandingNodeId(null);
    },
  });

  // Handle search
  const handleSearch = useCallback((title: string) => {
    previousDataRef.current = data ?? liveData;
    const request = createCrawlRequest(title, depth, maxNodes, ++requestNonceRef.current);
    const url = new URL(window.location.href);
    url.hash = '';
    url.searchParams.set('seed', title);
    url.searchParams.set('depth', request.depth.toString());
    url.searchParams.set('nodes', request.maxNodes.toString());
    window.history.replaceState({}, '', url.toString());
    submittedRequestRef.current = request;
    setSubmittedRequest(request);
    liveUpdateRef.current = null;
    if (liveUpdateFrameRef.current !== null) {
      window.cancelAnimationFrame(liveUpdateFrameRef.current);
      liveUpdateFrameRef.current = null;
    }
    setLiveData(createSeedPreview(title));
    setCrawlStage('crawling');
    setSeedPreview(true);
    setGraphError(null);
    setCrawlWarning(null);
    setNotFound(null);
    setSharedGraphError(null);
    setSharedGraphLoading(false);
    setSelectedNodeId(null);
    setFocusedNode(null);
    setPathSelection(null);
    setExpandedNodeIds(new Set());
    setExpandingNodeId(null);
    setExpandNotice(null);
  }, [data, depth, liveData, maxNodes]);

  const handleReturnHome = useCallback(() => {
    submittedRequestRef.current = null;
    requestNonceRef.current += 1;
    liveUpdateRef.current = null;
    if (liveUpdateFrameRef.current !== null) {
      window.cancelAnimationFrame(liveUpdateFrameRef.current);
      liveUpdateFrameRef.current = null;
    }
    void queryClient.cancelQueries({ queryKey: ['crawl'] });
    queryClient.removeQueries({ queryKey: ['crawl'] });

    const url = new URL(window.location.href);
    url.hash = '';
    url.searchParams.delete('seed');
    url.searchParams.delete('depth');
    url.searchParams.delete('nodes');
    window.history.replaceState({}, '', url.toString());

    previousDataRef.current = null;
    setSubmittedRequest(null);
    setLiveData(null);
    setSeedPreview(false);
    setCrawlStage('crawling');
    setSelectedNodeId(null);
    setFocusedNode(null);
    setFocusedCommunityId(null);
    setPathSelection(null);
    setExpandedNodeIds(new Set());
    setExpandingNodeId(null);
    setExpandNotice(null);
    setGraphError(null);
    setCrawlWarning(null);
    setNotFound(null);
    setSharedGraphError(null);
    setSharedGraphLoading(false);
    setSidebarVisible(true);
    setSidebarOpen(false);
  }, [queryClient]);

  const handleGoDeeper = useCallback(() => {
    if (!submittedRequest || submittedRequest.depth >= 3) return;
    const nextDepth = Math.min(3, Math.max(submittedRequest.depth + 1, depth));
    const nextMaxNodes = maxNodes;
    previousDataRef.current = data ?? liveData;
    setDepth(nextDepth);
    setMaxNodes(nextMaxNodes);
    const request = createCrawlRequest(submittedRequest.seed, nextDepth, nextMaxNodes, ++requestNonceRef.current);
    const url = new URL(window.location.href);
    url.hash = '';
    url.searchParams.set('depth', String(nextDepth));
    url.searchParams.set('nodes', String(nextMaxNodes));
    window.history.replaceState({}, '', url.toString());
    submittedRequestRef.current = request;
    setSubmittedRequest(request);
    setLiveData(null);
    setCrawlStage('crawling');
    setExpandedNodeIds(new Set());
    setGraphError(null);
    setCrawlWarning(null);
  }, [data, depth, liveData, maxNodes, submittedRequest]);

  // Handle node click
  const handleNodeClick = useCallback((node: WikiNode, shiftKey = false) => {
    if (shiftKey && selectedNodeId && selectedNodeId !== node.id) {
      setPathSelection({
        from: selectedNodeId,
        to: node.id,
        result: pathfinder.findPath(selectedNodeId, node.id),
      });
      setFocusedNode(null);
      setFocusedCommunityId(null);
      return;
    }

    if (!selectedNodeId) {
  window.history.pushState(
    {
      ...(window.history.state ?? {}),
      wikicrawlNodePanel: true,
    },
    '',
  );
}

    setSelectedNodeId(node.id);
    setFocusedNode(node.id);
    setFocusedCommunityId(null);
    setPathSelection(null);
    setGraphError(null);
    setCrawlWarning(null);
  }, [pathfinder, selectedNodeId]);

  const handleFindPath = useCallback((from: string, to: string) => {
    setSelectedNodeId(from);
    setPathSelection({ from, to, result: pathfinder.findPath(from, to) });
    setFocusedNode(null);
    setFocusedCommunityId(null);
  }, [pathfinder]);

  const handlePathNodeClick = useCallback((nodeId: string) => {
    setSelectedNodeId(nodeId);
    setFocusedNode(null);
    setFocusedCommunityId(null);
  }, []);

  // Handle node selection from sidebar
  const handleNodeSelect = useCallback((nodeId: string) => {
    setFocusedNode(nodeId);
    setFocusedCommunityId(null);
    const node = displayData?.nodes.find(n => n.id === nodeId);
    if (node) {
      setSelectedNodeId(node.id);
    }
  }, [displayData]);

  // Handle community selection
  const handleCommunitySelect = useCallback((communityId: number) => {
    if (!displayData) return;
    const community = displayData.communities.find((candidate) => candidate.id === communityId);
    const topPage = community?.topPages[0]
      ? displayData.nodes.find((node) => node.id === community.topPages[0])
      : null;
    setFocusedCommunityId(communityId);
    setFocusedNode(null);
    setSelectedNodeId(topPage?.id ?? null);
  }, [displayData, setFocusedCommunityId]);

  // Handle expand from node
  const handleExpand = useCallback((nodeId: string) => {
    if (expandedNodeIds.has(nodeId) || expandingNodeId) return;
    setGraphError(null);
    setExpandNotice(null);
    setExpandingNodeId(nodeId);
    expandMutation.mutate(nodeId);
  }, [expandMutation, expandedNodeIds, expandingNodeId]);

const handleCloseSelection = useCallback(() => {
  if (window.history.state?.wikicrawlNodePanel) {
    window.history.back();
    return;
  }

  setSelectedNodeId(null);
  setFocusedNode(null);
  setFocusedCommunityId(null);
  setPathSelection(null);
}, []);

  // Load from URL params
  useEffect(() => {
    const encoded = new URLSearchParams(window.location.hash.slice(1)).get('graph');
    if (encoded !== null) {
      const nonce = ++requestNonceRef.current;
      setSharedGraphLoading(true);
      void decodeSharedGraph(encoded).then((snapshot) => {
        if (requestNonceRef.current !== nonce) return;
        const request = createCrawlRequest(snapshot.graph.seedId, snapshot.depth, snapshot.maxNodes, nonce);
        queryClient.setQueryData(['crawl', request.seed, request.depth, request.maxNodes, request.nonce], snapshot.graph);
        submittedRequestRef.current = request;
        setDepth(snapshot.depth);
        setMaxNodes(snapshot.maxNodes);
        setColorMode(snapshot.colorMode);
        setSubmittedRequest(request);
      }).catch((error: unknown) => {
        if (requestNonceRef.current === nonce) setSharedGraphError(error instanceof Error ? error.message : 'Could not open this graph link.');
      }).finally(() => {
        if (requestNonceRef.current === nonce) setSharedGraphLoading(false);
      });
      return;
    }
    const { seed, depth: urlDepth, maxNodes: urlMaxNodes } = parseCrawlParams(window.location.search);
    setDepth(urlDepth);
    setMaxNodes(urlMaxNodes);

    if (seed) {
      setCrawlStage('crawling');
      const request = createCrawlRequest(seed, urlDepth, urlMaxNodes, ++requestNonceRef.current);
      submittedRequestRef.current = request;
      setSubmittedRequest(request);
      setLiveData(createSeedPreview(seed));
      setSeedPreview(true);
    }
  }, [queryClient]);

  useEffect(() => {
    if (!data) return;
    const issues = validateGraphData(data);
    if (issues.length > 0) {
      setGraphError(issues[0]);
      setSelectedNodeId(null);
      setFocusedNode(null);
    }
  }, [data]);

  return (
    <div className={`app-shell h-screen flex flex-col relative overflow-hidden ${reduceEffects ? 'reduce-effects' : ''}`}>
      <AnimatedBackground />
      
      {/* Header */}
      <header className="app-header relative z-40 flex-shrink-0 glass border-b border-white/10 px-6 py-4">
        <div className="header-inner max-w-7xl mx-auto">
          {isLoading && !displayData && (
            <div className="mb-4">
              <div className="mb-2 flex items-center justify-between text-xs text-slate-300">
                <span>Crawling Wikipedia</span>
                <span>Still working</span>
              </div>
              <div className="creation-progress is-indeterminate" aria-hidden="true">
                <span />
              </div>
            </div>
          )}
          <div className="header-topline flex items-center justify-between mb-4">
            <div className="app-brand flex items-center gap-4">
              {/* Animated logo */}
              <Link href="/" className="app-home-link" aria-label="Return to WikiCrawl home" onNavigate={handleReturnHome}>
                <span className="relative">
                <div className="app-brand-mark w-12 h-12 rounded-xl bg-gradient-to-br from-cyan-500 via-purple-500 to-pink-500 p-[2px]">
                  <div className="w-full h-full bg-slate-900 rounded-[10px] flex items-center justify-center">
                    <svg className="w-7 h-7 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                    </svg>
                  </div>
                </div>
                </span>
              </Link>
              <div>
                <p className="app-brand-title text-2xl font-bold">
                  <Link href="/" onNavigate={handleReturnHome}>
                    <span className="gradient-text">WikiCrawl</span>
                    <span className="text-white/90"> / field notes</span>
                  </Link>
                </p>
                <p className="text-sm text-cyan-400/80">A visual index of unexpected connections</p>
                <p className="text-xs text-slate-400">
                  Created by{' '}
                  <a href="https://www.linkedin.com/in/adityavardhan-jain/" target="_blank" rel="noopener noreferrer" className="text-slate-300 hover:text-white">
                    Adityavardhan Jain
                  </a>
                </p>
                <nav className="home-discovery-nav" aria-label="WikiCrawl guides">
                  <Link href="/explore">Explore topics</Link>
                  <Link href="/learn">Learn how it works</Link>
                </nav>
              </div>
            </div>
            
            {/* Color mode toggle with animated background */}
            <div className="mode-switch relative flex items-center gap-1 bg-slate-800/50 rounded-xl p-1.5 border border-white/10" role="group" aria-label="Graph color mode">
              <button
                type="button"
                aria-pressed={colorMode === 'community'}
                onClick={() => setColorMode('community')}
                className={`mode-switch-button relative z-10 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  colorMode === 'community' ? 'is-active text-white' : 'text-slate-400 hover:text-white'
                }`}
              >
                Community
              </button>
              <button
                type="button"
                aria-pressed={colorMode === 'depth'}
                onClick={() => setColorMode('depth')}
                className={`mode-switch-button relative z-10 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                  colorMode === 'depth' ? 'is-active text-white' : 'text-slate-400 hover:text-white'
                }`}
              >
                Depth
              </button>
            </div>
          </div>
          
          {/* Search and controls */}
          <div className="header-search-controls">
            <div className="flex-1">
              <SeedSearch onSearch={handleSearch} isLoading={isLoading} />
            </div>
            <div className="header-crawl-controls">
              <button
                type="button"
                className="options-toggle atlas-mobile-button"
                aria-expanded={optionsOpen}
                aria-controls="crawl-options"
                onClick={() => setOptionsOpen((open) => !open)}
              >
                Options <span aria-hidden="true">{optionsOpen ? '−' : '+'}</span>
              </button>
              <div id="crawl-options" className={`crawl-options ${optionsOpen ? 'crawl-options-open' : ''}`}>
              <CrawlControls
                depth={depth}
                maxNodes={maxNodes}
                onDepthChange={setDepth}
                onMaxNodesChange={setMaxNodes}
                onGoDeeper={handleGoDeeper}
                canGoDeeper={Boolean(submittedRequest && submittedRequest.depth < 3)}
                nextDepth={Math.min(3, Math.max(depth, (submittedRequest?.depth ?? depth) + 1))}
                isAtMaxDepth={submittedRequest?.depth === 3}
                isLoading={isLoading}
                disabled={isLoading}
              />
              </div>
            </div>
          </div>
          <div className="sr-only" aria-live="polite">{crawlStatus}</div>
        </div>
      </header>

      {/* Main content */}
      <div className="flex-1 min-h-0 min-w-0 flex overflow-hidden relative z-30">
        {/* Graph area */}
        <div className="flex-1 min-h-0 min-w-0 relative">
          {isLoading && !displayData && (
            <div className="creation-stage absolute inset-0 flex items-center justify-center px-6 z-50">
              <div className="creation-card w-full max-w-lg" role="status" aria-live="polite" aria-busy="true">
                <div className="creation-card-mark" aria-hidden="true">{'///'}</div>
                <p className="creation-kicker">New field note</p>
                <h3>Building your map</h3>
                <p className="creation-stage-label">{creationStage}</p>
                <div
                  className="creation-progress is-indeterminate"
                  role="progressbar"
                  aria-label="Wikipedia crawl progress"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuetext={`${streamingPageLabel}; crawl in progress`}
                >
                  <span />
                </div>
                <div className="creation-meta">
                  <span>{streamingPageLabel}</span>
                  <span>Depth {depth} · up to {maxNodes} pages</span>
                </div>
              </div>
            </div>
          )}

          {isLoading && displayData && (
            <div className="absolute inset-x-4 top-4 z-30 flex justify-center">
              <div className="streaming-status flex items-center gap-3 rounded-full border border-cyan-500/30 bg-slate-950/80 px-4 py-2 text-xs text-cyan-200 shadow-lg backdrop-blur-md" role="status" aria-live="polite">
                <span className="streaming-indicator" aria-hidden="true" />
                <span>{creationStage}</span>
                <span className="min-w-24 text-right tabular-nums">{streamingPageLabel}</span>
                <span className="creation-progress is-indeterminate h-1.5 w-24" aria-hidden="true">
                  <span />
                </span>
              </div>
            </div>
          )}

          {notFound && (
            <div className="absolute inset-0 z-40 flex items-center justify-center px-6">
              <div className="glass-strong w-full max-w-lg max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-2xl border border-cyan-500/30 p-8 text-center">
                <p className="mb-2 text-lg font-semibold text-cyan-300">No Wikipedia article named &quot;{notFound.title}&quot;</p>
                <p className="mb-5 text-sm text-slate-400">Try one of these related articles:</p>
                <div className="flex flex-wrap justify-center gap-2">
                  {notFound.suggestions.map((suggestion) => (
                    <button
                      key={suggestion}
                      type="button"
                      onClick={() => handleSearch(suggestion)}
                      className="rounded-full border border-cyan-400/30 bg-cyan-400/10 px-3 py-2 text-sm text-cyan-200 transition hover:bg-cyan-400/20 hover:text-white"
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {error && !notFound && !displayData && (
            <div className="absolute inset-0 z-40 flex items-center justify-center">
              <div className="text-center p-8 glass-strong rounded-2xl max-w-md border border-red-500/30">
                <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-red-500/20 flex items-center justify-center">
                  <svg className="w-8 h-8 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                </div>
                <p className="text-red-400 text-lg font-semibold mb-2">Connection Lost</p>
                <p className="text-slate-400 text-sm mb-6">
                  {String(error).includes('429') 
                    ? 'Wikipedia rate limit reached. Please wait a moment and try again.' 
                    : String(error)}
                </p>
                <button
                  onClick={() => refetch()}
                  className="btn-primary ripple px-6 py-3 text-white font-medium rounded-xl"
                >
                  <span>Try Again</span>
                </button>
              </div>
            </div>
          )}

          {displayData && (
            <>
              <GraphCanvas
                data={displayData}
                colorMode={colorMode}
                onNodeClick={handleNodeClick}
                onStageClick={handleCloseSelection}
                focusedNode={focusedNode}
                isStreaming={isLoading}
                reduceEffects={reduceEffects}
                focusedCommunityId={focusedCommunityId}
                path={pathSelection?.result ?? null}
                isExpanded={expandedNodeIds.size > 0}
                isExpanding={Boolean(expandingNodeId)}
                shareSettings={submittedRequest && data && !error ? { depth: submittedRequest.depth, maxNodes: submittedRequest.maxNodes } : undefined}
              />
              
              <MemoizedNodeDetailPanel
                node={selectedNode}
                data={displayData}
                onClose={handleCloseSelection}
                onExpand={handleExpand}
                isExpanding={Boolean(selectedNode) && expandingNodeId === selectedNode?.id}
                isExpanded={Boolean(selectedNode) && expandedNodeIds.has(selectedNode?.id ?? '')}
                pathSelection={pathSelection}
                onFindPath={handleFindPath}
                onPathNodeClick={handlePathNodeClick}
                onClearPath={() => setPathSelection(null)}
              />

            </>
          )}

          {graphError && displayData && (
            <div className="absolute inset-x-0 bottom-6 z-30 flex justify-center px-4">
              <div className="flex max-w-lg items-center gap-4 rounded-2xl border border-amber-500/30 bg-slate-950/85 px-4 py-3 text-sm text-amber-200 shadow-xl backdrop-blur-md">
                <span>{graphError}</span>
                <button type="button" onClick={() => refetch()} className="shrink-0 text-xs font-semibold uppercase tracking-wide text-cyan-300 hover:text-white">
                  Retry
                </button>
              </div>
            </div>
          )}

          {expandNotice && displayData && (
            <div className="absolute inset-x-0 bottom-6 z-30 flex justify-center px-4">
              <div className="flex max-w-lg items-center gap-4 rounded-2xl border border-cyan-500/30 bg-slate-950/85 px-4 py-3 text-sm text-cyan-200 shadow-xl backdrop-blur-md">
                <span>{expandNotice}</span>
                <button type="button" aria-label="Dismiss notice" onClick={() => setExpandNotice(null)} className="shrink-0 text-lg leading-none text-slate-400 hover:text-white">
                  ×
                </button>
              </div>
            </div>
          )}

          {crawlWarning !== null && displayData && (
            <div className="absolute inset-x-0 top-16 z-30 flex justify-center px-4">
              <div className="crawl-warning flex max-w-xl items-center gap-4 px-4 py-3 text-sm" role="status" aria-live="polite">
                <span>Map ready to explore. {crawlWarning} {crawlWarning === 1 ? 'page was' : 'pages were'} unavailable, so some links may be missing.</span>
                <button type="button" onClick={() => refetch()} className="shrink-0 text-xs font-semibold uppercase tracking-wide text-cyan-300 hover:text-white">
                  Retry crawl
                </button>
                <button type="button" aria-label="Dismiss warning" onClick={() => setCrawlWarning(null)} className="shrink-0 text-lg leading-none text-slate-400 hover:text-white">
                  ×
                </button>
              </div>
            </div>
          )}

          {sharedGraphError && !displayData && (
            <div className="absolute inset-0 flex items-center justify-center px-5" role="alert">
              <p className="text-center text-amber-200">{sharedGraphError}</p>
            </div>
          )}

          {!displayData && !isLoading && !error && !notFound && !sharedGraphLoading && !sharedGraphError && (
            <div className="home-empty-scroll absolute inset-0 flex items-center justify-center overflow-y-auto px-5 py-8">
              <section className="atlas-empty-state" aria-labelledby="welcome-title">
                <div className="landing-index-line">
                  <span>FIELD NOTE 001</span>
                  <span>WIKIPEDIA, MAPPED</span>
                </div>
                <h1 id="welcome-title">Explore Wikipedia as a knowledge graph.</h1>
                <p>WikiCrawl follows article links from a topic you choose, then maps the pages and connections in an interactive graph. Follow an idea beyond its first link and find a Wikipedia rabbit hole of your own.</p>
                <div className="landing-examples" role="group" aria-label="Example topics">
                  <span className="landing-examples-label">Start with</span>
                  {exampleTopics.map((topic) => (
                    <button key={topic} type="button" onClick={() => handleSearch(topic)}>{topic}</button>
                  ))}
                </div>
                <div className="landing-footnote"><span aria-hidden="true">↗</span> Search above to map any article</div>
                <section className="home-discovery-content" aria-labelledby="popular-explorations-heading">
                  <div>
                    <p className="landing-examples-label">A quick tour</p>
                    <h3>How the map takes shape</h3>
                    <p>Choose an article, set a crawl depth, and WikiCrawl gathers a bounded sample of linked pages. The map preserves link direction and adds graph metrics for the pages in that sample.</p>
                  </div>
                  <div>
                    <h3 id="popular-explorations-heading">Popular starting points</h3>
                    <ul>
                      {exploreTopics.slice(0, 6).map((topic) => (
                        <li key={topic.slug}><Link href={`/explore/${topic.slug}`}>{topic.title}<span aria-hidden="true"> ↗</span></Link></li>
                      ))}
                    </ul>
                    <Link className="home-all-topics" href="/explore">Browse all curated explorations ↗</Link>
                  </div>
                  <p className="home-rabbit-hole">Start with a <Link href="/learn/what-is-a-wikipedia-rabbit-hole">Wikipedia rabbit hole</Link>, or read <Link href="/learn/how-wikicrawl-works">how WikiCrawl works</Link>.</p>
                </section>
              </section>
            </div>
          )}
        </div>

        {/* Sidebar */}
        {displayData && (
          <>
            <button type="button" className="mobile-sidebar-toggle atlas-mobile-button" aria-expanded={sidebarVisible && sidebarOpen} onClick={() => {
              if (!sidebarVisible) {
                setSidebarVisible(true);
                setSidebarOpen(true);
              } else {
                setSidebarOpen((open) => !open);
              }
            }}>
              {sidebarOpen ? 'Close atlas' : 'Open atlas'}
            </button>
            {!sidebarVisible && (
              <button type="button" className="desktop-sidebar-toggle" onClick={() => setSidebarVisible(true)}>
                Open Atlas <span aria-hidden="true">←</span>
              </button>
            )}
            {sidebarVisible && <MemoizedSidebar data={displayData} onNodeSelect={handleNodeSelect} onCommunitySelect={handleCommunitySelect} focusedNode={focusedNode} focusedCommunityId={focusedCommunityId} isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} onDesktopClose={() => setSidebarVisible(false)} />}
          </>
        )}
      </div>
    </div>
  );
}

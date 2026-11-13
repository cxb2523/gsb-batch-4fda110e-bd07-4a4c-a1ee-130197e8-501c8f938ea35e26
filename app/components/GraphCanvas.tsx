'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Graph from 'graphology';
import { Sigma } from 'sigma';
import { EdgeArrowProgram, EdgeLineProgram } from 'sigma/rendering';
import { Download, Link as LinkIcon } from 'lucide-react';
import type { CrawlResult, WikiNode, PathResult } from '@/types/graph';
import { getFocusCameraTarget } from '@/lib/cameraFocus';
import { getCommunityColor, getNodeSize, hslToRgbColor } from '@/lib/graphAnalysis';
import { syncGraphData } from '@/lib/graphSync';
import { computeRobustBounds } from '@/lib/layoutMetrics';
import { seedInitialPositions } from '@/lib/layoutSeed';
import { encodeSharedGraph } from '@/lib/shareGraph';
import { getRememberedPositions, useForceLayout } from './useForceLayout';
import { useNodeSummary, usePrefetchNodeSummary } from './useNodeSummary';

const HOVER_PREFETCH_DWELL_MS = 300;
const NODE_ARRIVAL_DURATION_MS = 240;
const NODE_ARRIVAL_STAGGER_MS = 32;

interface NodeArrival {
  startedAt: number;
  delay: number;
}

interface GraphCanvasProps {
  data: CrawlResult;
  colorMode: 'community' | 'depth';
  onNodeClick: (node: WikiNode, shiftKey?: boolean) => void;
  onStageClick?: () => void;
  focusedNode: string | null;
  path: PathResult | null;
  isStreaming?: boolean;
  isExpanded?: boolean;
  focusedCommunityId?: number | null;
  reduceEffects?: boolean;
  shareSettings?: { depth: number; maxNodes: number };
  isExpanding?: boolean;
}

export function GraphCanvas({
  data,
  colorMode,
  onNodeClick,
  onStageClick = () => undefined,
  focusedNode,
  path,
  isStreaming = false,
  isExpanded = false,
  focusedCommunityId = null,
  reduceEffects = false,
  shareSettings,
  isExpanding = false,
}: GraphCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef(new Graph({ type: 'directed', multi: false }));
  const sigmaRef = useRef<Sigma | null>(null);
  const onNodeClickRef = useRef(onNodeClick);
  const onStageClickRef = useRef(onStageClick);
  const dataRef = useRef(data);
  const [hoveredNode, setHoveredNode] = useState<WikiNode | null>(null);
  const hoveredSummary = useNodeSummary(hoveredNode?.id ?? null, { enabled: false });
  const prefetchSummary = usePrefetchNodeSummary();
  const prefetchSummaryRef = useRef(prefetchSummary);
  const hoverDwellTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const tooltipPositionRef = useRef({ x: 0, y: 0 });
  const tooltipFrameRef = useRef<number | null>(null);
  const focusedNodeRef = useRef(focusedNode);
  const cameraReturnStateRef = useRef<{ x: number; y: number; ratio: number; angle: number } | null>(null);
  const hoveredNodeRef = useRef<string | null>(null);
  const focusNeighborsRef = useRef(new Set<string>());
  const hoverNeighborsRef = useRef(new Set<string>());
  const colorModeRef = useRef(colorMode);
  const topRankIdsRef = useRef(new Set<string>());
  const hubIdsRef = useRef(new Set<string>());
  const maxDegreeRef = useRef(1);
  const compactLabelsRef = useRef(false);
  const showAllEdgesRef = useRef(false);
  const showArrowsRef = useRef(false);
  const pathNodeIdsRef = useRef(new Set<string>());
  const pathEdgeKeysRef = useRef(new Set<string>());
  const communityNodeIdsRef = useRef(new Set<string>());
  const focusedCommunityIdRef = useRef<number | null>(focusedCommunityId);
  const communityFrameRef = useRef<number | null>(null);
  const updateCommunityLabelsRef = useRef<() => void>(() => undefined);
  const pendingNewNodeIdsRef = useRef<string[]>([]);
  const nodeArrivalsRef = useRef(new Map<string, NodeArrival>());
  const nodeArrivalFrameRef = useRef<number | null>(null);
  const initialCameraFitPendingRef = useRef(false);
  const previousShapeRef = useRef({ seedId: '', nodes: 0, edges: 0 });
  const [layoutRevision, setLayoutRevision] = useState(0);
  const [containerReady, setContainerReady] = useState(false);
  const [showAllEdges, setShowAllEdges] = useState(false);
  const [showArrows, setShowArrows] = useState(false);
  const [arrivalsActive, setArrivalsActive] = useState(false);
  const [shareBusy, setShareBusy] = useState(false);
  const [shareMessage, setShareMessage] = useState('');
  const [manualLink, setManualLink] = useState('');
  const [communityLabels, setCommunityLabels] = useState<Array<{
    id: number;
    label: string;
    size: number;
    color: string;
    x: number;
    y: number;
  }>>([]);

  dataRef.current = data;
  colorModeRef.current = colorMode;
  prefetchSummaryRef.current = prefetchSummary;

  const maxDepth = useMemo(() => {
    const depths = data.nodes.map((n) => n.depth).filter((d) => d >= 0);
    return Math.max(...depths, 1);
  }, [data.nodes]);

  const rankValues = useMemo(() => data.nodes.map((node) => node.pagerank), [data.nodes]);
  const topRankIds = useMemo(() => new Set(
    [...data.nodes]
      .sort((left, right) => right.pagerank - left.pagerank)
      .slice(0, 30)
      .map((node) => node.id),
  ), [data.nodes]);
  const hubIds = useMemo(() => new Set(
    [...data.nodes]
      .sort((left, right) => (right.inDegree + right.outDegree) - (left.inDegree + left.outDegree))
      .slice(0, 100)
      .map((node) => node.id),
  ), [data.nodes]);
  const maxDegree = useMemo(() => Math.max(
    1,
    ...data.nodes.map((node) => node.inDegree + node.outDegree),
  ), [data.nodes]);
  const pathNodeIds = useMemo(() => new Set(path?.path ?? []), [path]);
  const pathEdgeKeys = useMemo(() => new Set(
    path?.path.slice(1).map((nodeId, index) => {
      const previousId = path.path[index];
      return previousId < nodeId ? `${previousId}|${nodeId}` : `${nodeId}|${previousId}`;
    }) ?? [],
  ), [path]);
  const communityNodeIds = useMemo(() => new Set(
    focusedCommunityId === null
      ? []
      : data.nodes.filter((node) => node.communityId === focusedCommunityId).map((node) => node.id),
  ), [data.nodes, focusedCommunityId]);
  const edgeCount = data.edges.length;
  const denseEdges = edgeCount > 4 * Math.max(data.nodes.length, 1);
  topRankIdsRef.current = topRankIds;
  hubIdsRef.current = hubIds;
  maxDegreeRef.current = maxDegree;
  pathNodeIdsRef.current = pathNodeIds;
  pathEdgeKeysRef.current = pathEdgeKeys;
  communityNodeIdsRef.current = communityNodeIds;
  focusedCommunityIdRef.current = focusedCommunityId;
  showAllEdgesRef.current = showAllEdges;
  showArrowsRef.current = showArrows;

  useEffect(() => {
    onNodeClickRef.current = onNodeClick;
    onStageClickRef.current = onStageClick;
    focusedNodeRef.current = focusedNode;
    focusNeighborsRef.current = focusedNode && graphRef.current.hasNode(focusedNode)
      ? new Set(graphRef.current.neighbors(focusedNode))
      : new Set();
    sigmaRef.current?.refresh();
  }, [focusedNode, onNodeClick, onStageClick, data]);

  useEffect(() => {
    if (!containerRef.current) return;

    const mountContainer = containerRef.current;
    if (mountContainer.clientHeight === 0 || mountContainer.clientWidth === 0) {
      if (typeof ResizeObserver !== 'undefined') {
        const observer = new ResizeObserver(() => {
          if (mountContainer.clientHeight > 0 && mountContainer.clientWidth > 0) {
            setContainerReady(true);
          }
        });
        observer.observe(mountContainer);
        return () => observer.disconnect();
      }
      const frame = window.requestAnimationFrame(() => setContainerReady(true));
      return () => window.cancelAnimationFrame(frame);
    }

    const graph = graphRef.current;
    const nodeArrivals = nodeArrivalsRef.current;
    const compactLabels = window.innerWidth <= 700;
    compactLabelsRef.current = compactLabels;
    const sigma = new Sigma(graph, mountContainer, {
      renderLabels: true,
      labelFont: 'var(--font-display)',
      labelSize: 12,
      labelColor: { color: '#e2e8f0' },
      labelWeight: '600',
      labelDensity: compactLabels ? 0.008 : 0.08,
      labelGridCellSize: compactLabels ? 220 : 90,
      defaultEdgeColor: 'rgba(148, 163, 184, 0.2)',
      defaultNodeColor: '#67e8f9',
      minCameraRatio: 0.22,
      maxCameraRatio: 4,
      hideLabelsOnMove: true,
      hideEdgesOnMove: dataRef.current.edges.length > 4 * Math.max(dataRef.current.nodes.length, 1),
      labelRenderedSizeThreshold: 6,
      nodeReducer: (node, attributes) => {
        const arrival = nodeArrivalsRef.current.get(node);
        const arrivalProgress = arrival
          ? Math.max(0, Math.min(1, (performance.now() - arrival.startedAt - arrival.delay) / NODE_ARRIVAL_DURATION_MS))
          : 1;
        const arrivalEase = 1 - (1 - arrivalProgress) ** 3;
        const nodeAttributes = arrival && node !== dataRef.current.seedId
          ? { ...attributes, size: Math.max(0.01, Number(attributes.size) * arrivalEase) }
          : attributes;
        const focusId = focusedNodeRef.current;
        const hoverId = hoveredNodeRef.current;
        const isRoot = node === dataRef.current.seedId;
        const isFocus = node === focusId;
        const isNeighbor = focusNeighborsRef.current.has(node);
        const isHover = node === hoverId;
        const isHoverNeighbor = hoverNeighborsRef.current.has(node);
        const nodeData = graph.getNodeAttributes(node).raw as WikiNode;
        const isTopRanked = topRankIdsRef.current.has(node);
        const hasPath = pathNodeIdsRef.current.size > 0;
        const isPathNode = pathNodeIdsRef.current.has(node);
        const hasCommunityFocus = focusedCommunityIdRef.current !== null;
        const isCommunityMember = communityNodeIdsRef.current.has(node);

        if (hasPath && !isPathNode) {
          return {
            ...nodeAttributes,
            size: Math.max(4, (Number(nodeAttributes.size) || 8) * 0.62),
            color: 'rgba(100, 116, 139, 0.18)',
            label: '',
            forceLabel: false,
            zIndex: 1,
          };
        }

        if (isPathNode) {
          return {
            ...nodeAttributes,
            size: (Number(nodeAttributes.size) || 8) + 3,
            color: '#77c9bd',
            label: nodeData.title,
            forceLabel: true,
            zIndex: 12,
          };
        }

        if (hasCommunityFocus && !isCommunityMember) {
          return {
            ...nodeAttributes,
            size: Math.max(5, (Number(nodeAttributes.size) || 8) * 0.76),
            color: 'rgba(100, 116, 139, 0.24)',
            label: '',
            forceLabel: false,
            zIndex: 1,
          };
        }

        if (isRoot) {
          return {
            ...nodeAttributes,
            size: (Number(nodeAttributes.size) || 10) + 4,
            color: '#f08a70',
            label: nodeData.title,
            forceLabel: true,
            zIndex: 10,
          };
        }

        if (focusId && !isFocus && !isNeighbor) {
          return {
            ...nodeAttributes,
            size: Math.max(5, (Number(nodeAttributes.size) || 8) * 0.76),
            color: 'rgba(100, 116, 139, 0.24)',
            label: '',
            forceLabel: false,
            zIndex: 1,
          };
        }

        if (isFocus) {
          return {
            ...nodeAttributes,
            size: (Number(nodeAttributes.size) || 8) + 3,
            color: '#edf0e7',
            label: nodeData.title,
            forceLabel: true,
            zIndex: 8,
          };
        }

        if (isNeighbor) {
          return {
            ...nodeAttributes,
            size: (Number(nodeAttributes.size) || 8) + 1.5,
            color: '#72c9c0',
            label: nodeData.title,
            forceLabel: false,
            zIndex: 5,
          };
        }

        if (isHover) {
          return {
            ...nodeAttributes,
            size: (Number(nodeAttributes.size) || 8) + 2,
            color: '#d8f27a',
            label: nodeData.title,
            forceLabel: true,
            zIndex: 6,
          };
        }

        if (isHoverNeighbor) {
          return {
            ...nodeAttributes,
            color: '#9adbd3',
            label: nodeData.title,
            forceLabel: false,
          };
        }

        return {
          ...nodeAttributes,
          label: nodeData.title,
          forceLabel: isTopRanked && !compactLabelsRef.current,
        };
      },
      edgeReducer: (edge, edgeAttributes) => {
        const focusId = focusedNodeRef.current;
        const hoverId = hoveredNodeRef.current;
        const [source, target] = graph.extremities(edge);
        const pathEdgeKey = source < target ? `${source}|${target}` : `${target}|${source}`;
        const hasPath = pathNodeIdsRef.current.size > 0;
        const isPathEdge = pathEdgeKeysRef.current.has(pathEdgeKey);
        if (hasPath && !isPathEdge) {
          return { ...edgeAttributes, hidden: false, type: showArrowsRef.current ? 'arrow' : 'line', color: 'rgba(100, 116, 139, 0.08)', size: 0.35 };
        }
        if (isPathEdge) {
          return { ...edgeAttributes, type: showArrowsRef.current ? 'arrow' : 'line', color: '#77c9bd', size: 3 };
        }
        const isFocusedEdge = focusId === source || focusId === target;
        const isHoveredEdge = hoverId === source || hoverId === target;
        if (
          dataRef.current.edges.length > 4 * Math.max(dataRef.current.nodes.length, 1) &&
          !showAllEdgesRef.current &&
          !isFocusedEdge &&
          !isHoveredEdge &&
          !hubIdsRef.current.has(source) &&
          !hubIdsRef.current.has(target)
        ) {
          return { ...edgeAttributes, hidden: true };
        }

        const sourceData = graph.getNodeAttributes(source).raw as WikiNode;
        const targetData = graph.getNodeAttributes(target).raw as WikiNode;
        const edgeAlpha = 0.06 + 0.22 * Math.sqrt(
          Math.max(sourceData.inDegree + sourceData.outDegree, targetData.inDegree + targetData.outDegree) / maxDegreeRef.current,
        );
        const normalEdgeAlpha = sourceData.communityId === targetData.communityId ? edgeAlpha : edgeAlpha * 0.5;

        if (isFocusedEdge) {
          return { ...edgeAttributes, type: showArrowsRef.current ? 'arrow' : 'line', color: 'rgba(119, 201, 189, 0.86)', size: 1.6 };
        }

        if (isHoveredEdge) {
          return { ...edgeAttributes, type: showArrowsRef.current ? 'arrow' : 'line', color: 'rgba(216, 242, 122, 0.54)', size: 1.1 };
        }

        if (focusId) {
          return { ...edgeAttributes, type: showArrowsRef.current ? 'arrow' : 'line', color: `rgba(148, 163, 184, ${edgeAlpha * 0.4})`, size: 0.45 };
        }

        return { ...edgeAttributes, type: showArrowsRef.current ? 'arrow' : 'line', color: `rgba(148, 163, 184, ${normalEdgeAlpha})`, size: 0.8 };
      },
      edgeProgramClasses: {
        line: EdgeLineProgram,
        arrow: EdgeArrowProgram,
      },
    });

    sigmaRef.current = sigma;
    const updateResponsiveLabelDensity = () => {
      const isCompact = window.innerWidth <= 700;
      if (compactLabelsRef.current === isCompact) return;
      compactLabelsRef.current = isCompact;
      sigma.setSetting('labelDensity', isCompact ? 0.008 : 0.08);
      sigma.setSetting('labelGridCellSize', isCompact ? 220 : 90);
    };
    window.addEventListener('resize', updateResponsiveLabelDensity);

    const updateCommunityLabels = () => {
      if (communityFrameRef.current !== null) return;
      communityFrameRef.current = window.requestAnimationFrame(() => {
        communityFrameRef.current = null;
        if (compactLabelsRef.current || sigma.getCamera().getState().ratio < 0.45) {
          setCommunityLabels([]);
          return;
        }

        const nextLabels = dataRef.current.communities.slice(0, 8).flatMap((community) => {
          const members = dataRef.current.nodes.filter((node) => node.communityId === community.id && graph.hasNode(node.id));
          if (members.length === 0) return [];
          const centroid = members.reduce((sum, node) => {
            const position = graph.getNodeAttributes(node.id);
            return { x: sum.x + Number(position.x), y: sum.y + Number(position.y) };
          }, { x: 0, y: 0 });
          const viewport = sigma.graphToViewport({
            x: centroid.x / members.length,
            y: centroid.y / members.length,
          });
          return [{
            id: community.id,
            label: community.label,
            size: community.size,
            color: getCommunityColor(community.id, Math.max(dataRef.current.communities.length, 1)),
            x: viewport.x,
            y: viewport.y,
          }];
        });
        setCommunityLabels(nextLabels);
      });
    };
    updateCommunityLabelsRef.current = updateCommunityLabels;
    sigma.getCamera().on('updated', updateCommunityLabels);
    graph.on('eachNodeAttributesUpdated', updateCommunityLabels);
    updateCommunityLabels();

    sigma.on('enterNode', ({ node }) => {
      if (hoveredNodeRef.current === node) return;
      const nodeData = graph.getNodeAttributes(node).raw as WikiNode;
      hoveredNodeRef.current = node;
      hoverNeighborsRef.current = graph.hasNode(node) ? new Set(graph.neighbors(node)) : new Set();
      setHoveredNode(nodeData);
      sigma.refresh();
      sigma.getContainer().style.cursor = 'pointer';

      if (hoverDwellTimeoutRef.current) clearTimeout(hoverDwellTimeoutRef.current);
      hoverDwellTimeoutRef.current = setTimeout(() => {
        prefetchSummaryRef.current(nodeData.id);
      }, HOVER_PREFETCH_DWELL_MS);
    });

    sigma.on('leaveNode', () => {
      if (hoverDwellTimeoutRef.current) {
        clearTimeout(hoverDwellTimeoutRef.current);
        hoverDwellTimeoutRef.current = null;
      }
      if (hoveredNodeRef.current === null) return;
      hoveredNodeRef.current = null;
      hoverNeighborsRef.current = new Set();
      setHoveredNode(null);
      sigma.refresh();
      sigma.getContainer().style.cursor = 'default';
    });

    sigma.on('clickNode', ({ node, event }) => {
      const nodeData = graph.getNodeAttributes(node).raw as WikiNode;
      onNodeClickRef.current(nodeData, 'shiftKey' in event.original && event.original.shiftKey);
    });
    sigma.on('clickStage', () => onStageClickRef.current());

    const container = sigma.getContainer();
    const handleMouseMove = (event: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      tooltipPositionRef.current = {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      };
      if (tooltipFrameRef.current !== null) return;
      tooltipFrameRef.current = window.requestAnimationFrame(() => {
        tooltipFrameRef.current = null;
        const { x, y } = tooltipPositionRef.current;
        if (tooltipRef.current) {
          tooltipRef.current.style.transform = `translate3d(${x + 15}px, ${y + 15}px, 0)`;
        }
      });
    };
    container.addEventListener('mousemove', handleMouseMove);

    return () => {
      container.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('resize', updateResponsiveLabelDensity);
      if (tooltipFrameRef.current !== null) window.cancelAnimationFrame(tooltipFrameRef.current);
      if (nodeArrivalFrameRef.current !== null) window.cancelAnimationFrame(nodeArrivalFrameRef.current);
      nodeArrivals.clear();
      if (hoverDwellTimeoutRef.current) clearTimeout(hoverDwellTimeoutRef.current);
      sigma.getCamera().removeListener('updated', updateCommunityLabels);
      graph.removeListener('eachNodeAttributesUpdated', updateCommunityLabels);
      if (communityFrameRef.current !== null) window.cancelAnimationFrame(communityFrameRef.current);
      sigma.kill();
      sigmaRef.current = null;
    };
  }, [containerReady]);

  const applyRobustBounds = useCallback((fitCamera = false) => {
    const sigma = sigmaRef.current;
    if (!sigma) return;
    const points = graphRef.current.nodes().map((node) => {
      const attributes = graphRef.current.getNodeAttributes(node);
      return { x: Number(attributes.x), y: Number(attributes.y) };
    });
    sigma.setCustomBBox(computeRobustBounds(points));
    if (fitCamera) sigma.getCamera().animatedReset({ duration: 420 });
  }, []);

  useEffect(() => {
    const graph = graphRef.current;
    hoveredNodeRef.current = null;
    hoverNeighborsRef.current = new Set();
    setHoveredNode(null);

    const wasEmpty = graph.order === 0;
    const seedChanged = graph.order > 0 && graph.getAttribute('seedId') !== data.seedId;
    const positions = wasEmpty || seedChanged
      ? data.id === 'shared' && Object.keys(data.positions).length > 0
        ? new Map(Object.entries(data.positions))
        : getRememberedPositions(data.seedId) ?? seedInitialPositions(data.nodes, data.seedId)
      : undefined;
    const result = syncGraphData(graph, data, {
      initialPositions: positions,
      sizeForNode: (node) => getNodeSize(node.pagerank, 5, 18, rankValues),
      colorForNode: (node) => getNodeColor(node, data.seedId, colorModeRef.current, data.communities.length, maxDepth),
    });
    if (isStreaming && !reduceEffects && result.addedNodeIds.length > 0) {
      const startedAt = performance.now();
      result.addedNodeIds.forEach((nodeId, index) => {
        if (nodeId !== data.seedId) {
          nodeArrivalsRef.current.set(nodeId, {
            startedAt,
            delay: index * NODE_ARRIVAL_STAGGER_MS,
          });
        }
      });
      if (nodeArrivalsRef.current.size > 0 && nodeArrivalFrameRef.current === null) {
        setArrivalsActive(true);
        const refreshArrivals = () => {
          const now = performance.now();
          for (const [nodeId, arrival] of nodeArrivalsRef.current) {
            if (now - arrival.startedAt >= arrival.delay + NODE_ARRIVAL_DURATION_MS) {
              nodeArrivalsRef.current.delete(nodeId);
            }
          }
          sigmaRef.current?.refresh();
          nodeArrivalFrameRef.current = nodeArrivalsRef.current.size > 0
            ? window.requestAnimationFrame(refreshArrivals)
            : null;
          if (nodeArrivalsRef.current.size === 0) setArrivalsActive(false);
        };
        nodeArrivalFrameRef.current = window.requestAnimationFrame(refreshArrivals);
      }
    }
    focusNeighborsRef.current = focusedNodeRef.current && graph.hasNode(focusedNodeRef.current)
      ? new Set(graph.neighbors(focusedNodeRef.current))
      : new Set();
    const isFirstGraphSync = previousShapeRef.current.nodes === 0 && data.nodes.length > 0;
    if (result.seedChanged) {
      pendingNewNodeIdsRef.current = result.addedNodeIds;
    } else if (isFirstGraphSync) {
      pendingNewNodeIdsRef.current = result.addedNodeIds;
    } else if (result.addedNodeIds.length > 0) {
      pendingNewNodeIdsRef.current = isStreaming
        ? [...new Set([...pendingNewNodeIdsRef.current, ...result.addedNodeIds])]
        : result.addedNodeIds;
    }
    if (isFirstGraphSync || result.seedChanged || (!isStreaming && result.addedNodeIds.length > 0)) {
      setLayoutRevision((revision) => revision + 1);
    }
    previousShapeRef.current = { seedId: data.seedId, nodes: data.nodes.length, edges: edgeCount };

    sigmaRef.current?.refresh();
    updateCommunityLabelsRef.current();
    if (result.shouldFitCamera) initialCameraFitPendingRef.current = true;
    const canFitInitialGraph = initialCameraFitPendingRef.current && (!isStreaming || data.nodes.length > 1);
    if (canFitInitialGraph && sigmaRef.current) {
      initialCameraFitPendingRef.current = false;
      sigmaRef.current?.setCustomBBox(null);
      applyRobustBounds(true);
    }
  }, [applyRobustBounds, colorMode, containerReady, data, edgeCount, isStreaming, maxDegree, maxDepth, rankValues, reduceEffects]);

  const sharedLayout = data.id === 'shared' && layoutRevision <= 1;
  const { arranging, paused, ready, togglePause } = useForceLayout(graphRef.current, {
    seedId: data.seedId,
    changeKey: `${data.seedId}:${layoutRevision}`,
    newNodeIds: pendingNewNodeIdsRef.current,
    enabled: !isStreaming && !sharedLayout,
    relayoutAll: false,
    onLayoutStop: applyRobustBounds,
  });

  useEffect(() => {
    if (!denseEdges && showAllEdges) setShowAllEdges(false);
    sigmaRef.current?.setSetting('hideEdgesOnMove', denseEdges);
    sigmaRef.current?.refresh();
  }, [denseEdges, showAllEdges]);

  useEffect(() => {
    graphRef.current.forEachEdge((edge) => {
      graphRef.current.setEdgeAttribute(edge, 'type', showArrows ? 'arrow' : 'line');
    });
    sigmaRef.current?.refresh();
  }, [showArrows]);

  useEffect(() => {
    if (!sigmaRef.current || !focusedNode) return;

    const camera = sigmaRef.current.getCamera();
    if (!cameraReturnStateRef.current) cameraReturnStateRef.current = camera.getState();
    const display = sigmaRef.current.getNodeDisplayData(focusedNode);
    const target = getFocusCameraTarget(display);
    if (target) camera.animate(target, { duration: 300 });
  }, [focusedNode]);

  useEffect(() => {
    if (focusedNode || path || !cameraReturnStateRef.current || !sigmaRef.current) return;
    const camera = sigmaRef.current.getCamera();
    camera.animate(cameraReturnStateRef.current, { duration: 300 });
    cameraReturnStateRef.current = null;
  }, [focusedNode, path]);

  useEffect(() => {
    if (!sigmaRef.current || !path || path.path.length === 0) return;

    const camera = sigmaRef.current.getCamera();
    if (!cameraReturnStateRef.current) cameraReturnStateRef.current = camera.getState();
    const positions = path.path
      .map((nodeId) => sigmaRef.current?.getNodeDisplayData(nodeId))
      .filter((display) => getFocusCameraTarget(display) !== null)
      .map((display) => getFocusCameraTarget(display)!);
    if (positions.length === 0) return;

    const bounds = positions.reduce((current, position) => ({
      minX: Math.min(current.minX, Number(position.x)),
      maxX: Math.max(current.maxX, Number(position.x)),
      minY: Math.min(current.minY, Number(position.y)),
      maxY: Math.max(current.maxY, Number(position.y)),
    }), {
      minX: Number.POSITIVE_INFINITY,
      maxX: Number.NEGATIVE_INFINITY,
      minY: Number.POSITIVE_INFINITY,
      maxY: Number.NEGATIVE_INFINITY,
    });
    const centerX = (bounds.minX + bounds.maxX) / 2;
    const centerY = (bounds.minY + bounds.maxY) / 2;
    const width = Math.max(bounds.maxX - bounds.minX, 0.08);
    const height = Math.max(bounds.maxY - bounds.minY, 0.08);
    const dimensions = sigmaRef.current.getDimensions();
    const viewportAspect = dimensions.width / Math.max(dimensions.height, 1);
    const fitWidth = Math.max(width, height * viewportAspect);
    const ratio = Math.min(4, Math.max(0.22, fitWidth * 1.35));

    camera.animate({ x: centerX, y: centerY, ratio }, { duration: 420 });
  }, [path]);

  useEffect(() => {
    sigmaRef.current?.refresh();
  }, [focusedNode]);

  useEffect(() => {
    if (!sigmaRef.current || focusedCommunityId === null) return;
    const displays = data.nodes
      .filter((node) => node.communityId === focusedCommunityId)
      .map((node) => getFocusCameraTarget(sigmaRef.current?.getNodeDisplayData(node.id)))
      .filter((display): display is { x: number; y: number } => display !== null);
    if (displays.length === 0) return;

    const bounds = displays.reduce((current, display) => ({
      minX: Math.min(current.minX, display.x),
      maxX: Math.max(current.maxX, display.x),
      minY: Math.min(current.minY, display.y),
      maxY: Math.max(current.maxY, display.y),
    }), {
      minX: Number.POSITIVE_INFINITY,
      maxX: Number.NEGATIVE_INFINITY,
      minY: Number.POSITIVE_INFINITY,
      maxY: Number.NEGATIVE_INFINITY,
    });
    const spread = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, 0.08);
    const ratio = Math.min(4, Math.max(0.22, spread * 1.35));
    sigmaRef.current.getCamera().animate({
      x: (bounds.minX + bounds.maxX) / 2,
      y: (bounds.minY + bounds.maxY) / 2,
      ratio,
    }, { duration: 420 });
  }, [data.nodes, focusedCommunityId]);

  const resetLayout = () => {
    const graph = graphRef.current;
    const positions = seedInitialPositions(data.nodes, data.seedId);

    for (const node of data.nodes) {
      const pos = positions.get(node.id) ?? { x: 0, y: 0 };
      graph.setNodeAttribute(node.id, 'x', pos.x);
      graph.setNodeAttribute(node.id, 'y', pos.y);
      graph.setNodeAttribute(node.id, 'fixed', false);
    }

    pendingNewNodeIdsRef.current = data.nodes.map((node) => node.id);
    setLayoutRevision((revision) => revision + 1);
    sigmaRef.current?.refresh();
  };

  const canShare = Boolean(shareSettings && sigmaRef.current && !isStreaming && !isExpanding && !arrivalsActive && (ready || sharedLayout));

  const copyShareLink = async () => {
    if (!shareSettings || !canShare) return;
    setShareBusy(true);
    setShareMessage('');
    setManualLink('');
    try {
      const positions = Object.fromEntries(graphRef.current.nodes().map((id) => {
        const attributes = graphRef.current.getNodeAttributes(id);
        return [id, { x: Number(attributes.x), y: Number(attributes.y) }];
      }));
      const encoded = await encodeSharedGraph({ graph: { ...data, positions }, ...shareSettings, colorMode });
      const url = new URL(window.location.pathname, window.location.origin);
      url.hash = `graph=${encoded}`;
      const link = url.toString();
      try {
        if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
        await navigator.clipboard.writeText(link);
        setShareMessage('Graph link copied.');
      } catch {
        setManualLink(link);
        setShareMessage('Copy the graph link below.');
      }
    } catch (error) {
      setShareMessage(error instanceof Error ? error.message : 'Could not create a graph link.');
    } finally {
      setShareBusy(false);
    }
  };

  const downloadScreenshot = () => {
    const sigma = sigmaRef.current;
    if (!sigma || !canShare) return;
    setShareMessage('');
    try {
      sigma.refresh();
      const layers = sigma.getCanvases();
      const orderedLayers = ['edges', 'edgeLabels', 'nodes', 'labels', 'hovers', 'hoverNodes'];
      const source = layers.nodes;
      if (!source?.width || !source.height) throw new Error('The graph is not ready to capture.');
      const canvas = document.createElement('canvas');
      canvas.width = source.width;
      canvas.height = source.height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Could not create a screenshot.');
      context.fillStyle = '#121a16';
      context.fillRect(0, 0, canvas.width, canvas.height);
      for (const layer of orderedLayers) {
        if (layers[layer]) context.drawImage(layers[layer], 0, 0, canvas.width, canvas.height);
      }
      canvas.toBlob((blob) => {
        if (!blob) {
          setShareMessage('Could not create a screenshot.');
          return;
        }
        const objectUrl = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = objectUrl;
        link.download = `wikicrawl-${data.seedId.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 80) || 'graph'}.png`;
        link.click();
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
        setShareMessage('Screenshot downloaded.');
      }, 'image/png');
    } catch (error) {
      setShareMessage(error instanceof Error ? error.message : 'Could not create a screenshot.');
    }
  };

  return (
    <div className="relative w-full h-full min-h-[320px]">
      <div ref={containerRef} className="graph-surface absolute inset-0 w-full h-full" />

      <div
        className="graph-toolbar absolute top-4 right-4 flex gap-1 graph-overlay rounded-lg p-1 z-10"
        onPointerDown={(event) => event.stopPropagation()}
        onWheel={(event) => event.stopPropagation()}
      >
        <button className="graph-control" onClick={() => sigmaRef.current?.getCamera().animatedZoom({ duration: 180 })} aria-label="Zoom in">+</button>
        <button className="graph-control" onClick={() => sigmaRef.current?.getCamera().animatedUnzoom({ duration: 180 })} aria-label="Zoom out">-</button>
        <button aria-label="Fit graph to view" className="graph-control graph-control-wide" onClick={() => sigmaRef.current?.getCamera().animatedReset({ duration: 220 })}>Fit</button>
        <button aria-label="Reset graph layout" className="graph-control graph-control-wide" onClick={resetLayout}>Reset</button>
        {denseEdges && (
          <button aria-label={showAllEdges ? 'Show graph hubs' : 'Show all graph edges'} className="graph-control graph-control-wide" onClick={() => setShowAllEdges((visible) => !visible)}>
            {showAllEdges ? 'Hubs' : 'All edges'}
          </button>
        )}
        <button aria-label={showArrows ? 'Hide edge arrows' : 'Show edge arrows'} className="graph-control graph-control-wide" onClick={() => setShowArrows((visible) => !visible)}>
          {showArrows ? 'Arrows on' : 'Arrows'}
        </button>
      </div>

      {shareSettings && (
        <div className="graph-share" onPointerDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}>
          <div className="graph-share-actions graph-overlay" role="group" aria-label="Share graph">
            <button type="button" className="graph-control" aria-label="Copy graph link" title="Copy graph link" disabled={!canShare || shareBusy} onClick={() => void copyShareLink()}><LinkIcon size={17} aria-hidden="true" /></button>
            <button type="button" className="graph-control" aria-label="Download graph screenshot" title="Download graph screenshot" disabled={!canShare || shareBusy} onClick={downloadScreenshot}><Download size={17} aria-hidden="true" /></button>
          </div>
          {shareMessage && <p className="graph-share-message" role="status">{shareMessage}</p>}
          {manualLink && <textarea aria-label="Graph link to copy" className="graph-share-link" readOnly value={manualLink} onFocus={(event) => event.currentTarget.select()} />}
        </div>
      )}

      {(arranging || paused) && (
        <div
          className="absolute top-16 right-4 graph-overlay rounded-lg px-3 py-2 text-xs text-cyan-200 z-10"
          onPointerDown={(event) => event.stopPropagation()}
          onWheel={(event) => event.stopPropagation()}
        >
          <span>{paused ? 'Paused' : 'Arranging...'}</span>
          <button className="ml-3 text-white underline" onClick={togglePause}>
            {paused ? 'Resume' : 'Pause'}
          </button>
        </div>
      )}

      <div
        className="graph-legend absolute top-4 left-4 graph-overlay rounded-xl p-4 text-xs z-10 max-w-xs"
        onPointerDown={(event) => event.stopPropagation()}
        onWheel={(event) => event.stopPropagation()}
      >
        <div className="text-white font-semibold mb-3 flex items-center gap-2">
          <svg className="w-4 h-4 text-cyan-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span>Exploration map</span>
        </div>
        <div className="flex items-center gap-2 mb-2">
          <div className="w-3 h-3 rounded-full bg-[#f08a70] border border-[#ffd1c2]/70" />
          <span className="text-slate-300">Root</span>
        </div>
        {colorMode === 'community' ? (
          <div className="graph-legend-community-list space-y-1.5">
            {data.communities.slice(0, 8).map((community) => {
              const topNode = data.nodes.find((node) => node.id === community.topPages[0]);
              return (
                <button
                  key={community.id}
                  type="button"
                  className="flex w-full items-center gap-2 text-left text-slate-300 hover:text-white"
                  onClick={() => topNode && onNodeClick(topNode)}
                >
                  <span
                    className="h-3 w-3 flex-shrink-0 rounded-full"
                    style={{ backgroundColor: getCommunityColor(community.id, Math.max(data.communities.length, 1)) }}
                  />
                  <span className="truncate">{community.label}</span>
                  <span className="ml-auto text-slate-500">{community.size}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="space-y-1.5">
            <div className="h-2 w-40 rounded-full bg-gradient-to-r from-red-400 via-yellow-300 to-emerald-400" />
            <div className="flex w-40 justify-between text-slate-500"><span>3 hops</span><span>1 hop</span></div>
          </div>
        )}
        <div className="mt-3 flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-[#f4f1ea] border border-white/70" />
          <span className="text-slate-300">Focus</span>
        </div>
      </div>

      {communityLabels.map((community) => (
        <div
          key={community.id}
          className="pointer-events-none absolute z-[5] -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/10 bg-slate-950/65 px-2 py-1 text-[10px] text-slate-200 shadow-lg backdrop-blur-sm"
          style={{ left: community.x, top: community.y }}
        >
          <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full" style={{ backgroundColor: community.color }} />
          {community.label} <span className="text-slate-500">({community.size})</span>
        </div>
      ))}

      <div
        className="graph-gesture-key absolute bottom-4 left-4 graph-overlay rounded-xl p-4 text-xs z-10 max-sm:hidden"
        onPointerDown={(event) => event.stopPropagation()}
        onWheel={(event) => event.stopPropagation()}
      >
        <div className="text-white font-semibold mb-3 flex items-center gap-2">
          <svg className="w-4 h-4 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 15l-2 5L9 9l11 4-5 2zm0 0l5 5M7.188 2.239l.777 2.897M5.136 7.965l-2.898-.777M13.95 4.05l-2.122 2.122m-5.657 5.656l-2.12 2.122" />
          </svg>
          Explore
        </div>
        <div className="text-slate-400 space-y-1.5">
          <p className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-cyan-400" />
            Hover for context
          </p>
          <p className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-purple-400" />
            Click to focus
          </p>
          <p className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-pink-400" />
            Scroll to zoom
          </p>
        </div>
      </div>

      {hoveredNode && (
        <div
          ref={tooltipRef}
          className="node-tooltip"
          style={{
            transform: `translate3d(${tooltipPositionRef.current.x + 15}px, ${tooltipPositionRef.current.y + 15}px, 0)`,
          }}
        >
          <h4>{hoveredNode.title}</h4>
          {hoveredSummary.data?.extract ? (
            <p>{hoveredSummary.data.extract.slice(0, 200)}...</p>
          ) : (
            <p className="text-gray-400 italic">Click for details</p>
          )}
          <div className="mt-2 pt-2 border-t border-gray-700 flex gap-4 text-xs">
            <span>Depth: {hoveredNode.depth >= 0 ? hoveredNode.depth : '?'}</span>
            <span>PageRank: {hoveredNode.pagerank.toFixed(4)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function getDepthColor(depth: number, maxDepth: number): string {
  if (depth < 0) return '#94a3b8';
  const ratio = depth / Math.max(maxDepth, 1);
  const hue = 178 - ratio * 22;
  return hslToRgbColor(hue, 52, 58);
}

function getNodeColor(
  node: WikiNode,
  seedId: string,
  colorMode: 'community' | 'depth',
  communityCount: number,
  maxDepth: number,
): string {
  if (node.id === seedId) return '#f08a70';
  return colorMode === 'community'
    ? getCommunityColor(node.communityId, Math.max(communityCount, 1))
    : getDepthColor(node.depth, maxDepth);
}

'use client';

import { useEffect, useRef, useState } from 'react';
import Graph from 'graphology';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import FA2Layout from 'graphology-layout-forceatlas2/worker';

const rememberedPositions = new Map<string, Map<string, { x: number; y: number }>>();

export function getRememberedPositions(seedId: string): Map<string, { x: number; y: number }> | undefined {
  const positions = rememberedPositions.get(seedId);
  return positions ? new Map(positions) : undefined;
}

interface UseForceLayoutOptions {
  seedId: string;
  changeKey: string;
  newNodeIds: string[];
  enabled?: boolean;
  relayoutAll?: boolean;
  onLayoutStop?: () => void;
}

export function useForceLayout(
  graph: Graph,
  { seedId, changeKey, newNodeIds, enabled = true, relayoutAll = false, onLayoutStop }: UseForceLayoutOptions,
): { arranging: boolean; paused: boolean; ready: boolean; togglePause: () => void } {
  const layoutRef = useRef<FA2Layout | null>(null);
  const seedRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const newNodeIdsRef = useRef(newNodeIds);
  const onLayoutStopRef = useRef(onLayoutStop);
  const [arranging, setArranging] = useState(false);
  const [paused, setPaused] = useState(false);
  const [settledKey, setSettledKey] = useState<string | null>(null);

  newNodeIdsRef.current = newNodeIds;
  onLayoutStopRef.current = onLayoutStop;

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    layoutRef.current?.kill();
    layoutRef.current = null;

    if (!enabled || graph.order === 0) {
      setArranging(false);
      return;
    }

    setSettledKey(null);

    const isNewSeed = seedRef.current !== seedId;
    seedRef.current = seedId;
    const newIds = new Set(newNodeIdsRef.current);
    setPaused(false);
    // The installed worker reads `fixed` into its node matrix and skips those
    // nodes during force application, so existing nodes remain stable here.
    graph.forEachNode((node) => {
      graph.setNodeAttribute(node, 'fixed', isNewSeed || relayoutAll ? false : !newIds.has(node));
    });

    timerRef.current = setTimeout(() => {
      const layout = new FA2Layout(graph, {
        settings: {
          ...forceAtlas2.inferSettings(graph),
          barnesHutOptimize: true,
          scalingRatio: 10,
          gravity: 0.5,
          strongGravityMode: false,
          slowDown: 5,
          linLogMode: true,
          outboundAttractionDistribution: true,
          edgeWeightInfluence: 1,
        },
      });
      layoutRef.current = layout;
      setArranging(true);
      layout.start();

      timerRef.current = setTimeout(() => {
        layout.stop();
        graph.forEachNode((node) => graph.setNodeAttribute(node, 'fixed', true));
        rememberedPositions.set(seedId, new Map(
          graph.nodes().map((node) => {
            const attributes = graph.getNodeAttributes(node);
            return [node, { x: attributes.x as number, y: attributes.y as number }];
          }),
        ));
        setArranging(false);
        onLayoutStopRef.current?.();
        setSettledKey(changeKey);
      }, 1800);
    }, 80);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      layoutRef.current?.kill();
      layoutRef.current = null;
    };
  }, [changeKey, enabled, graph, relayoutAll, seedId]);

  const togglePause = () => {
    const layout = layoutRef.current;
    if (!layout) return;
    if (paused) {
      layout.start();
      setPaused(false);
      setArranging(true);
    } else {
      layout.stop();
      setPaused(true);
      setArranging(false);
    }
  };

  return { arranging, paused, ready: enabled && settledKey === changeKey, togglePause };
}

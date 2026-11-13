'use client';

import { useMemo } from 'react';
import type { CrawlResult, PathResult } from '@/types/graph';
import { buildPathGraph, findShortestPath } from '@/lib/graphAnalysis';

export interface Pathfinder {
  findPath: (from: string, to: string) => PathResult | null;
}

export function usePathfinder(data: CrawlResult | null): Pathfinder {
  const graph = useMemo(() => buildPathGraph(data), [data]);

  return useMemo(() => ({
    findPath: (from: string, to: string) => findShortestPath(graph, from, to),
  }), [graph]);
}
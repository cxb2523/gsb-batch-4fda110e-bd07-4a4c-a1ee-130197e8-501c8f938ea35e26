'use client';

import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { fetchSummary, type PageSummary } from '@/lib/summary';

const SUMMARY_STALE_TIME = 1000 * 60 * 60 * 24; // 24h

export function summaryQueryKey(title: string) {
  return ['page-summary', title] as const;
}

interface UseNodeSummaryOptions {
  /** Set to false to only read the cache (e.g. for a hover tooltip) without fetching. */
  enabled?: boolean;
}

export function useNodeSummary(
  title: string | null,
  options: UseNodeSummaryOptions = {},
): UseQueryResult<PageSummary> {
  const { enabled = true } = options;
  return useQuery({
    queryKey: summaryQueryKey(title ?? ''),
    queryFn: () => fetchSummary(title as string),
    enabled: Boolean(title) && enabled,
    staleTime: SUMMARY_STALE_TIME,
    retry: 1,
  });
}

/** Warms the summary cache (e.g. after a hover dwell) without subscribing to it. */
export function usePrefetchNodeSummary(): (title: string) => void {
  const queryClient = useQueryClient();
  return (title: string) => {
    void queryClient.prefetchQuery({
      queryKey: summaryQueryKey(title),
      queryFn: () => fetchSummary(title),
      staleTime: SUMMARY_STALE_TIME,
    });
  };
}

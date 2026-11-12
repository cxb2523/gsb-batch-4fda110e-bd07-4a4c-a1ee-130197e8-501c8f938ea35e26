import "server-only";

import { config as appConfig } from "@/config";

import { googleRequest } from "../google/api";
import type { QueryResult } from "../types";

import type { SearchConsoleConfig } from "./catalog";

/**
 * Search Console's Search Analytics API, as a service account the user added
 * to their property. Read-only by construction: the token's scope
 * (webmasters.readonly) can't change anything, and only Google's fixed API
 * host is called.
 */

const API = "https://searchconsole.googleapis.com/webmasters/v3";
export const SEARCH_CONSOLE_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";

export const DIMENSIONS = ["date", "query", "page", "country", "device", "searchAppearance"] as const;
export const FILTER_DIMENSIONS = ["query", "page", "country", "device", "searchAppearance"] as const;
export const OPERATORS = ["equals", "notEquals", "contains", "notContains", "includingRegex", "excludingRegex"] as const;
export const SEARCH_TYPES = ["web", "image", "video", "news", "discover", "googleNews"] as const;

export type SearchAnalyticsQuery = {
  startDate: string;
  endDate: string;
  dimensions?: (typeof DIMENSIONS)[number][];
  filters?: { dimension: (typeof FILTER_DIMENSIONS)[number]; operator: (typeof OPERATORS)[number]; expression: string }[];
  type?: (typeof SEARCH_TYPES)[number];
  aggregationType?: "auto" | "byPage" | "byProperty";
  /** "all" includes the last few days, which are still changing. */
  dataState?: "final" | "all";
  rowLimit?: number;
};

type Response = { rows?: { keys?: string[]; clicks: number; impressions: number; ctr: number; position: number }[] };

/** Runs one Search Analytics query and returns at most `maxRows` rows. */
export async function querySearchAnalytics(
  target: SearchConsoleConfig & { credential: string },
  query: SearchAnalyticsQuery,
  maxRows: number,
  signal?: AbortSignal,
): Promise<QueryResult> {
  const timeout = AbortSignal.timeout(appConfig().searchConsole.requestTimeoutMs);
  const dimensions = query.dimensions ?? [];
  const rowLimit = Math.min(query.rowLimit ?? maxRows, maxRows) + 1;
  const response = await googleRequest<Response>(
    target.credential,
    SEARCH_CONSOLE_SCOPE,
    `${API}/sites/${encodeURIComponent(target.siteUrl)}/searchAnalytics/query`,
    {
      method: "POST",
      body: {
        startDate: query.startDate,
        endDate: query.endDate,
        dimensions,
        type: query.type ?? "web",
        aggregationType: query.aggregationType ?? "auto",
        dataState: query.dataState ?? "final",
        dimensionFilterGroups: query.filters?.length ? [{ groupType: "and", filters: query.filters }] : undefined,
        rowLimit: Math.min(rowLimit, 25_000),
      },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    },
  );
  const rows = (response.rows ?? []).slice(0, maxRows).map((row) => ({
    ...Object.fromEntries(dimensions.map((dimension, i) => [dimension, row.keys?.[i] ?? null])),
    clicks: row.clicks,
    impressions: row.impressions,
    ctr: row.ctr,
    position: row.position,
  }));
  return {
    columns: [...dimensions, "clicks", "impressions", "ctr", "position"],
    rows,
    truncated: (response.rows?.length ?? 0) > maxRows,
  };
}

/** Checks the account can read the property: one aggregate row over the last week. */
export async function testSearchConsole(target: SearchConsoleConfig & { credential: string }): Promise<void> {
  const day = (offset: number) => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
  await querySearchAnalytics(target, { startDate: day(10), endDate: day(3) }, 1);
}

import "server-only";

import { z } from "zod";

import { config as appConfig } from "@/config";

import type { ConnectionSource, QueryResult, SourceTool } from "../types";

import { posthogCatalog, type PostHogConfig } from "./catalog";
import { PostHogError, runHogQLQuery, testConnection } from "./client";

export const apiKeySchema = z
  .string()
  .trim()
  .regex(/^phx_[A-Za-z0-9_-]{16,200}$/, "Personal API keys start with phx_.");


async function hogql(
  connection: { config: PostHogConfig; credential: string },
  query: string,
  maxRows: number,
  signal: AbortSignal,
): Promise<QueryResult> {
  const { results, columns } = await runHogQLQuery(
    { hostKind: connection.config.hostKind, projectId: connection.config.projectId, apiKey: connection.credential },
    query,
    { signal, timeoutMs: appConfig().posthog.queryTimeoutMs },
  );
  const rows = results.slice(0, maxRows).map((row) =>
    Array.isArray(row) ? Object.fromEntries(columns.map((column, i) => [column, row[i] ?? null])) : { value: row },
  );
  return { columns, rows, truncated: results.length > maxRows };
}

const queryTool: SourceTool<PostHogConfig, { hogql: string }> = {
  name: "posthog_query",
  description:
    "Run a read-only HogQL query (PostHog's SQL) on the project: tables events, persons, sessions, groups. " +
    "Read event properties as properties.$current_url, person properties as person.properties.email. " +
    "PostHog returns 100 rows unless the query has its own LIMIT (up to 50000). " +
    "Returns { columns, rows: [{ column: value }], truncated }.",
  parameters: z.object({ hogql: z.string().min(1).describe("One HogQL SELECT statement.") }),
  output: {
    columns: ["day", "events"],
    rows: [
      { day: "2026-10-30", events: 15234 },
      { day: "2026-10-31", events: 14987 },
    ],
    truncated: false,
  },
  callers: ["agent", "dashboard"],
  execute: (connection, { hogql: query }, { signal, caller }) => hogql(connection, query, appConfig().posthog.maxRows[caller], signal),
};

const eventsTool: SourceTool<PostHogConfig, { days?: number }> = {
  name: "posthog_event_names",
  description: "The project's event names with their counts over the last N days (default 30), most frequent first.",
  parameters: z.object({ days: z.number().int().min(1).max(365).optional() }),
  output: { columns: ["event", "count"], rows: [{ event: "$pageview", count: 120345 }], truncated: false },
  callers: ["agent"],
  execute: (connection, { days = 30 }, { signal }) =>
    hogql(
      connection,
      `SELECT event, count() AS count FROM events WHERE timestamp > now() - INTERVAL ${days} DAY GROUP BY event ORDER BY count DESC LIMIT 200`,
      200,
      signal,
    ),
};

export const posthogSource: ConnectionSource<PostHogConfig> = {
  ...posthogCatalog,
  credential: {
    field: "apiKey",
    schema: apiKeySchema,
    purpose: "posthog-api-key",
    hint: (key) => `${key.slice(0, 4)}…${key.slice(-4)}`,
  },
  async test(config, credential, signal) {
    await testConnection({ hostKind: config.hostKind, projectId: config.projectId, apiKey: credential }, { signal });
    return [];
  },
  toError(error) {
    if (!(error instanceof PostHogError)) return null;
    switch (error.code) {
      case "invalid_key":
        return {
          status: "invalid",
          error: {
            code: "invalid_key",
            field: "apiKey",
            message: "PostHog didn't accept this key. Check that it's a personal API key that hasn't been revoked.",
          },
        };
      case "missing_scope":
        return {
          status: "invalid",
          error: {
            code: "missing_scope",
            field: "apiKey",
            message: "This key doesn't have the Query Read permission. Create a key with Query Read for this project.",
          },
        };
      case "project_forbidden":
        return {
          status: "invalid",
          error: {
            code: "project_forbidden",
            field: "projectId",
            message: "This key can't access that project. Check the project ID, or scope the key to this project.",
          },
        };
      case "project_not_found":
        return {
          status: "invalid",
          error: {
            code: "project_not_found",
            field: "projectId",
            message: "There's no project with this ID in this region. Check the ID and the region.",
          },
        };
      case "rate_limited":
        return {
          status: "unavailable",
          error: { code: "rate_limited", message: "PostHog is rate-limiting requests right now. Try again in a minute." },
        };
      case "bad_query":
        return {
          status: "unavailable",
          error: {
            code: "bad_query",
            message: error.detail ? `HogQL error: ${queryProblem(error.detail)}` : "PostHog rejected the query.",
          },
        };
      case "timeout":
        return {
          status: "unavailable",
          error: {
            code: "timeout",
            message: "The query took too long. Narrow the date range, or aggregate before joining persons.",
          },
        };
      case "unavailable":
        return { status: "unavailable", error: { code: "posthog_unavailable", message: "Couldn't reach PostHog. Try again." } };
      case "unexpected":
        return {
          status: "unavailable",
          error: { code: "posthog_unexpected", message: "PostHog sent an unexpected response. Try again." },
        };
    }
  },
  tools: [queryTool, eventsTool],
};

/**
 * PostHog's reason a query failed, without the expanded SQL it appends ("In
 * query SELECT …"), which repeats internal joins and the project id and can
 * run to thousands of characters. The full detail goes to the server log.
 */
export function queryProblem(detail: string): string {
  const reason = detail.split(/\s+In query\s/)[0]?.trim() || detail;
  return reason.length > 300 ? `${reason.slice(0, 300)}…` : reason;
}

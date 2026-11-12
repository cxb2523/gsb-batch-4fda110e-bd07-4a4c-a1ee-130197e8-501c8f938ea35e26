import "server-only";

import { z } from "zod";

import { config as appConfig } from "@/config";

import { GoogleApiError } from "../google/api";
import { readServiceAccountKey, serviceAccountKeySchema } from "../google/credential";
import type { ConnectionSource, SourceError, SourceTool } from "../types";

import { searchConsoleCatalog, type SearchConsoleConfig } from "./catalog";
import {
  DIMENSIONS,
  FILTER_DIMENSIONS,
  OPERATORS,
  querySearchAnalytics,
  SEARCH_TYPES,
  testSearchConsole,
  type SearchAnalyticsQuery,
} from "./client";

const target = (connection: { config: SearchConsoleConfig; credential: string }) => ({ ...connection.config, credential: connection.credential });

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const queryTool: SourceTool<SearchConsoleConfig, SearchAnalyticsQuery> = {
  name: "searchconsole_query",
  description:
    "Google Search performance for the connection's Search Console property: clicks, impressions, ctr (a fraction, 0.05 = 5%) " +
    "and average position (1 = top), for a date range, broken down by any of date, query, page, country (ISO 3166-1 alpha-3, " +
    "lowercase, e.g. usa), device (DESKTOP, MOBILE, TABLET) and searchAppearance. Data runs 2–3 days behind and goes back " +
    "16 months. Rare queries are left out for privacy, so per-query rows don't add up to the site total: for totals, query " +
    "without the query dimension. Returns { columns, rows, truncated }, rows ordered by clicks.",
  parameters: z.object({
    startDate: z.string().regex(DATE).describe("First day, YYYY-MM-DD (Pacific time)."),
    endDate: z.string().regex(DATE).describe("Last day, YYYY-MM-DD, inclusive."),
    dimensions: z.array(z.enum(DIMENSIONS)).max(5).optional().describe("Group by these, in this order. None: one total row."),
    filters: z
      .array(z.object({ dimension: z.enum(FILTER_DIMENSIONS), operator: z.enum(OPERATORS), expression: z.string().min(1).max(4_096) }))
      .max(10)
      .optional()
      .describe("All must match. Regex filters use RE2 syntax."),
    type: z.enum(SEARCH_TYPES).optional().describe("Which Google surface. Default web."),
    aggregationType: z.enum(["auto", "byPage", "byProperty"]).optional(),
    dataState: z.enum(["final", "all"]).optional().describe("all: include the latest, still-changing days."),
    rowLimit: z.number().int().min(1).max(25_000).optional(),
  }),
  output: {
    columns: ["date", "clicks", "impressions", "ctr", "position"],
    rows: [
      { date: "2026-11-01", clicks: 1204, impressions: 38211, ctr: 0.0315, position: 8.4 },
      { date: "2026-11-02", clicks: 1188, impressions: 37640, ctr: 0.0316, position: 8.2 },
    ],
    truncated: false,
  },
  callers: ["agent", "dashboard"],
  execute: (connection, query, { caller, signal }) =>
    querySearchAnalytics(target(connection), query, appConfig().searchConsole.maxRows[caller], signal),
};

const invalid = (error: SourceError) => ({ status: "invalid" as const, error });
const unavailable = (error: SourceError) => ({ status: "unavailable" as const, error });

export const searchConsoleSource: ConnectionSource<SearchConsoleConfig> = {
  ...searchConsoleCatalog,
  credential: {
    field: "serviceAccountKey",
    schema: serviceAccountKeySchema,
    purpose: "searchconsole-service-account",
    hint: (credential) => readServiceAccountKey(credential).client_email,
  },
  async test(config, credential) {
    await testSearchConsole({ ...config, credential });
    return [];
  },
  toError(error) {
    if (!(error instanceof GoogleApiError)) return null;
    switch (error.code) {
      case "key_rejected":
        return invalid({
          code: "key_rejected",
          field: "serviceAccountKey",
          message: "Google didn't accept this key. It may have been deleted or disabled; create a new key for the service account.",
        });
      case "access_denied":
        return invalid({
          code: "access_denied",
          field: "siteUrl",
          message:
            "The service account can't read this property. In Search Console, open the property → Settings → Users and permissions, and add the account's email (Restricted is enough).",
        });
      case "not_found":
        return invalid({
          code: "not_found",
          field: "siteUrl",
          message: "Search Console has no such property for this account. Check it's written exactly as Search Console shows it (sc-domain:example.com, or https://www.example.com/).",
        });
      case "not_enabled":
        return invalid({
          code: "not_enabled",
          field: "serviceAccountKey",
          message: `The Google Search Console API isn't enabled in the service account's Google Cloud project.${error.activationUrl ? ` Enable it at ${error.activationUrl}` : " Enable it in APIs & Services, then try again."}`,
        });
      case "bad_request":
        return unavailable({ code: "bad_request", message: `Search Console rejected the query: ${error.detail ?? "invalid request"}.` });
      case "rate_limited":
        return unavailable({
          code: "rate_limited",
          message: "Search Console's quota for this property ran out for now. Ask for fewer dimensions or a shorter date range, and try again in a minute.",
        });
      case "timeout":
        return unavailable({ code: "timeout", message: "Search Console took too long to answer. Try a shorter date range or fewer dimensions." });
      case "unavailable":
        return unavailable({ code: "searchconsole_unavailable", message: "Couldn't reach Search Console. Try again." });
      case "unexpected":
        return unavailable({ code: "searchconsole_unexpected", message: "Search Console sent an unexpected response. Try again." });
    }
  },
  tools: [queryTool],
};

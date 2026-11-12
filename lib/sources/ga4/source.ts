import "server-only";

import { z } from "zod";

import { config as appConfig } from "@/config";

import { GoogleApiError } from "../google/api";
import { readServiceAccountKey, serviceAccountKeySchema } from "../google/credential";
import type { ConnectionSource, SourceError, SourceTool } from "../types";

import { ga4Catalog, type Ga4Config } from "./catalog";
import { FIELD_NAME, listGa4Fields, runGa4Report, testGa4, type Ga4Report } from "./client";

const target = (connection: { config: Ga4Config; credential: string }) => ({ ...connection.config, credential: connection.credential });

/** YYYY-MM-DD, or GA4's relative dates: today, yesterday, NdaysAgo. */
const GA_DATE = /^(\d{4}-\d{2}-\d{2}|today|yesterday|\d{1,4}daysAgo)$/;
const field = z.string().regex(FIELD_NAME, "Use the API name, e.g. sessionDefaultChannelGroup or customEvent:plan.");
const filterExpression = z.record(z.string(), z.unknown());

const reportTool: SourceTool<Ga4Config, Ga4Report> = {
  name: "ga4_report",
  description:
    "Run a Google Analytics 4 report on the connection's property (the Data API's runReport). Use API names for dimensions " +
    "and metrics (e.g. date, sessionDefaultChannelGroup, pagePath, country, deviceCategory; activeUsers, sessions, " +
    "screenPageViews, engagementRate, conversions, totalRevenue); call ga4_fields first when unsure, especially for custom " +
    "dimensions (customEvent:…). Not every dimension works with every metric; GA4 says which in its error. Dates are " +
    "YYYY-MM-DD or relative (today, yesterday, 30daysAgo); date values come back as YYYY-MM-DD. Filters are GA4 " +
    'FilterExpression JSON, e.g. { "filter": { "fieldName": "country", "stringFilter": { "value": "India" } } }. ' +
    "Returns { columns, rows, truncated, notes }; notes say when GA4 sampled or withheld data.",
  parameters: z.object({
    startDate: z.string().regex(GA_DATE),
    endDate: z.string().regex(GA_DATE),
    dimensions: z.array(field).max(9).optional(),
    metrics: z.array(field).min(1).max(10),
    dimensionFilter: filterExpression.optional(),
    metricFilter: filterExpression.optional(),
    orderBys: z
      .array(z.object({ metric: field.optional(), dimension: field.optional(), desc: z.boolean().optional() }).refine((order) => !!order.metric !== !!order.dimension, "Order by one metric or one dimension."))
      .max(5)
      .optional(),
    limit: z.number().int().min(1).max(100_000).optional(),
  }),
  output: {
    columns: ["date", "sessionDefaultChannelGroup", "sessions", "activeUsers"],
    rows: [
      { date: "2026-11-01", sessionDefaultChannelGroup: "Organic Search", sessions: 1832, activeUsers: 1410 },
      { date: "2026-11-01", sessionDefaultChannelGroup: "Direct", sessions: 912, activeUsers: 760 },
    ],
    truncated: false,
    notes: [],
  },
  callers: ["agent", "dashboard"],
  execute: (connection, report, { caller, signal }) =>
    runGa4Report(target(connection), report, appConfig().googleAnalytics.maxRows[caller], signal),
};

const fieldsTool: SourceTool<Ga4Config, { kind?: "dimension" | "metric"; search?: string }> = {
  name: "ga4_fields",
  description: "The dimensions and metrics this GA4 property offers, with API names, including its custom dimensions and metrics. Filter by kind or a search term.",
  parameters: z.object({
    kind: z.enum(["dimension", "metric"]).optional(),
    search: z.string().min(1).max(80).optional().describe("Matches API name, UI name or category, e.g. revenue or campaign."),
  }),
  output: {
    columns: ["kind", "apiName", "uiName", "category", "custom"],
    rows: [{ kind: "metric", apiName: "activeUsers", uiName: "Active users", category: "User", custom: false }],
    truncated: false,
  },
  callers: ["agent"],
  execute: (connection, options, { signal }) => listGa4Fields(target(connection), options, signal),
};

const invalid = (error: SourceError) => ({ status: "invalid" as const, error });
const unavailable = (error: SourceError) => ({ status: "unavailable" as const, error });

export const ga4Source: ConnectionSource<Ga4Config> = {
  ...ga4Catalog,
  credential: {
    field: "serviceAccountKey",
    schema: serviceAccountKeySchema,
    purpose: "ga4-service-account",
    hint: (credential) => readServiceAccountKey(credential).client_email,
  },
  async test(config, credential) {
    await testGa4({ ...config, credential });
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
          field: "propertyId",
          message: "The service account can't read this property. In Google Analytics, open Admin → Property access management and add the account's email as a Viewer.",
        });
      case "not_found":
        return invalid({ code: "not_found", field: "propertyId", message: "There's no GA4 property with this ID, or the account can't see it." });
      case "not_enabled":
        return invalid({
          code: "not_enabled",
          field: "serviceAccountKey",
          message: `The Google Analytics Data API isn't enabled in the service account's Google Cloud project.${error.activationUrl ? ` Enable it at ${error.activationUrl}` : " Enable it in APIs & Services, then try again."}`,
        });
      case "bad_request":
        return unavailable({
          code: "bad_request",
          message: `GA4 rejected the report: ${error.detail ?? "invalid request"}. Check the names with ga4_fields; some dimensions and metrics can't be combined.`,
        });
      case "rate_limited":
        return unavailable({
          code: "rate_limited",
          message: "This GA4 property's API quota ran out for now (GA4 limits tokens per hour and per day). Use fewer dimensions or a shorter date range, and try again later.",
        });
      case "timeout":
        return unavailable({ code: "timeout", message: "GA4 took too long to answer. Try a shorter date range or fewer dimensions." });
      case "unavailable":
        return unavailable({ code: "ga4_unavailable", message: "Couldn't reach Google Analytics. Try again." });
      case "unexpected":
        return unavailable({ code: "ga4_unexpected", message: "Google Analytics sent an unexpected response. Try again." });
    }
  },
  tools: [reportTool, fieldsTool],
};

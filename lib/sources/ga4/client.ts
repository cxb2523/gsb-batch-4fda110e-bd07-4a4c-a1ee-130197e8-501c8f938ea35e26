import "server-only";

import { config as appConfig } from "@/config";

import { googleRequest } from "../google/api";
import type { QueryResult } from "../types";

import type { Ga4Config } from "./catalog";

/**
 * Google Analytics 4's Data API, as a service account the user added to
 * their property as a Viewer. Read-only by construction: the token's scope
 * (analytics.readonly) can't change anything, and only Google's fixed API
 * host is called.
 */

const API = "https://analyticsdata.googleapis.com/v1beta";
export const GA4_SCOPE = "https://www.googleapis.com/auth/analytics.readonly";

type Target = Ga4Config & { credential: string };

/** Dimension and metric API names: "sessionSource", "customEvent:plan". */
export const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]*(?::[A-Za-z0-9_]+)?$/;

export type Ga4Report = {
  startDate: string;
  endDate: string;
  dimensions?: string[];
  metrics: string[];
  /** A GA4 FilterExpression, passed through as the API documents it. */
  dimensionFilter?: Record<string, unknown>;
  metricFilter?: Record<string, unknown>;
  orderBys?: { metric?: string; dimension?: string; desc?: boolean }[];
  limit?: number;
};

type ReportResponse = {
  dimensionHeaders?: { name: string }[];
  metricHeaders?: { name: string; type?: string }[];
  rows?: { dimensionValues?: { value?: string }[]; metricValues?: { value?: string }[] }[];
  rowCount?: number;
  metadata?: { dataLossFromOtherRow?: boolean; samplingMetadatas?: unknown[]; subjectToThresholding?: boolean };
};

const signalFor = (signal?: AbortSignal) => {
  const timeout = AbortSignal.timeout(appConfig().googleAnalytics.requestTimeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
};

/** "20261101" → "2026-11-01", so dates chart as dates. Other dimensions as GA4 sends them. */
function dimensionValue(name: string, value: string | undefined): string | null {
  if (value === undefined) return null;
  if (name === "date" && /^\d{8}$/.test(value)) return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}`;
  if (name === "dateHour" && /^\d{10}$/.test(value)) return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)} ${value.slice(8)}:00`;
  return value;
}

/** Turns a Data API report into rows. Exported for tests. */
export function toReportResult(response: ReportResponse, maxRows: number): QueryResult & { notes: string[] } {
  const dimensions = (response.dimensionHeaders ?? []).map((header) => header.name);
  const metrics = (response.metricHeaders ?? []).map((header) => header.name);
  const rows = (response.rows ?? []).slice(0, maxRows).map((row) => ({
    ...Object.fromEntries(dimensions.map((name, i) => [name, dimensionValue(name, row.dimensionValues?.[i]?.value)])),
    ...Object.fromEntries(
      metrics.map((name, i) => {
        const value = Number(row.metricValues?.[i]?.value);
        return [name, Number.isFinite(value) ? value : null];
      }),
    ),
  }));
  // What GA4 says about the numbers, so the agent can say it too.
  const notes: string[] = [];
  if (response.metadata?.samplingMetadatas?.length) notes.push("GA4 sampled this report: numbers are estimates.");
  if (response.metadata?.subjectToThresholding) notes.push("GA4 withheld some rows with few users (thresholding), so totals may be low.");
  if (response.metadata?.dataLossFromOtherRow) notes.push('Some values were grouped into "(other)" because the dimensions have too many distinct values.');
  return {
    columns: [...dimensions, ...metrics],
    rows,
    truncated: (response.rowCount ?? rows.length) > maxRows,
    notes,
  };
}

/** Runs one report and returns at most `maxRows` rows. */
export async function runGa4Report(target: Target, report: Ga4Report, maxRows: number, signal?: AbortSignal) {
  const response = await googleRequest<ReportResponse>(target.credential, GA4_SCOPE, `${API}/properties/${target.propertyId}:runReport`, {
    method: "POST",
    body: {
      dateRanges: [{ startDate: report.startDate, endDate: report.endDate }],
      dimensions: (report.dimensions ?? []).map((name) => ({ name })),
      metrics: report.metrics.map((name) => ({ name })),
      dimensionFilter: report.dimensionFilter,
      metricFilter: report.metricFilter,
      orderBys: report.orderBys?.map((order) =>
        order.metric ? { metric: { metricName: order.metric }, desc: order.desc ?? false } : { dimension: { dimensionName: order.dimension }, desc: order.desc ?? false },
      ),
      limit: Math.min(report.limit ?? maxRows, maxRows) + 1,
    },
    signal: signalFor(signal),
  });
  return toReportResult(response, maxRows);
}

type MetadataResponse = {
  dimensions?: { apiName: string; uiName?: string; category?: string; customDefinition?: boolean }[];
  metrics?: { apiName: string; uiName?: string; category?: string; type?: string; customDefinition?: boolean }[];
};

/** The dimensions and metrics this property offers, custom ones included, optionally filtered. */
export async function listGa4Fields(target: Target, options: { kind?: "dimension" | "metric"; search?: string }, signal?: AbortSignal): Promise<QueryResult> {
  const response = await googleRequest<MetadataResponse>(target.credential, GA4_SCOPE, `${API}/properties/${target.propertyId}/metadata`, {
    method: "GET",
    signal: signalFor(signal),
  });
  const search = options.search?.toLowerCase();
  const all = [
    ...(options.kind === "metric" ? [] : (response.dimensions ?? []).map((field) => ({ kind: "dimension", ...field }))),
    ...(options.kind === "dimension" ? [] : (response.metrics ?? []).map((field) => ({ kind: "metric", ...field }))),
  ].filter((field) => !search || `${field.apiName} ${field.uiName ?? ""} ${field.category ?? ""}`.toLowerCase().includes(search));
  const limit = 300;
  const rows = all.slice(0, limit).map((field) => ({
    kind: field.kind,
    apiName: field.apiName,
    uiName: field.uiName ?? null,
    category: field.category ?? null,
    custom: field.customDefinition === true,
  }));
  return { columns: ["kind", "apiName", "uiName", "category", "custom"], rows, truncated: all.length > limit };
}

/** Checks the account can read the property: active users over the last week. */
export async function testGa4(target: Target): Promise<void> {
  await runGa4Report(target, { startDate: "7daysAgo", endDate: "yesterday", metrics: ["activeUsers"] }, 1);
}

import "server-only";

import { randomUUID } from "node:crypto";

import { config as appConfig } from "@/config";

import { googleAccessToken, GoogleAuthError } from "../google/auth";
import type { QueryResult } from "../types";

import { DATASET_ID, PROJECT_ID, type BigqueryConfig } from "./catalog";
import { BigqueryError, fromApiError, toBigqueryError } from "./errors";

/**
 * BigQuery over its REST API, with a service account key. Queries run in
 * Google's cloud, nothing runs here. What keeps it safe:
 *
 * - Only service account keys are accepted, and tokens are only requested
 *   from Google's fixed token endpoint (see ../google/).
 * - Every query is dry-run first: anything but a single SELECT is refused
 *   before it runs, and so is one that would scan more than the byte limit.
 * - The real run carries maximumBytesBilled too, so BigQuery itself refuses
 *   to bill past the limit.
 * - A query that outlives our wait is cancelled.
 */

const API = "https://bigquery.googleapis.com/bigquery/v2";
/** Read data and run queries; nothing that manages datasets or IAM. */
const SCOPE = "https://www.googleapis.com/auth/bigquery";

export type BigqueryTarget = BigqueryConfig & { credential: string };

/** Values for @name parameters. */
export type BigqueryParams = Record<string, string | number | boolean | null>;

const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** Turns a failed sign-in into this source's error. */
async function accessToken(credential: string, signal: AbortSignal): Promise<string> {
  try {
    return await googleAccessToken(credential, SCOPE, signal);
  } catch (error) {
    if (error instanceof GoogleAuthError) throw new BigqueryError(error.code, error.detail);
    throw error;
  }
}

async function api<T>(target: BigqueryTarget, method: "GET" | "POST", path: string, body: unknown, signal: AbortSignal): Promise<T> {
  const token = await accessToken(target.credential, signal);
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      cache: "no-store",
      signal,
    });
  } catch (error) {
    throw toBigqueryError(error);
  }
  const json: unknown = await response.json().catch(() => null);
  if (!response.ok) throw fromApiError(response.status, json);
  return json as T;
}

const projectPath = (projectId: string) => `/projects/${encodeURIComponent(projectId)}`;

function queryParameters(params: BigqueryParams) {
  return Object.entries(params).map(([name, value]) => {
    if (!PARAM_NAME.test(name)) throw new BigqueryError("bad_query", `"${name}" isn't a valid parameter name.`);
    const type =
      typeof value === "boolean" ? "BOOL" : typeof value === "number" ? (Number.isInteger(value) ? "INT64" : "FLOAT64") : "STRING";
    return { name, parameterType: { type }, parameterValue: value === null ? {} : { value: String(value) } };
  });
}

type FieldSchema = { name: string; type: string; mode?: string; fields?: FieldSchema[] };
type Cell = { v: unknown };
type Row = { f: Cell[] };
type QueryResponse = {
  jobComplete?: boolean;
  jobReference?: { projectId: string; jobId: string; location?: string };
  schema?: { fields: FieldSchema[] };
  rows?: Row[];
  totalRows?: string;
  pageToken?: string;
};

/** A cell as JSON: numbers as numbers, timestamps as ISO strings, records as objects. */
function cellValue(field: FieldSchema, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (field.mode === "REPEATED") {
    return (value as Cell[]).map((item) => cellValue({ ...field, mode: "NULLABLE" }, item.v));
  }
  switch (field.type) {
    case "INTEGER":
    case "INT64":
    case "FLOAT":
    case "FLOAT64":
    case "NUMERIC":
    case "BIGNUMERIC": {
      const number = Number(value);
      return Number.isFinite(number) ? number : value;
    }
    case "BOOLEAN":
    case "BOOL":
      return value === "true";
    case "TIMESTAMP": {
      // Seconds since the epoch, as a string; newer APIs may send microseconds.
      const seconds = Number(value);
      return Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : value;
    }
    case "RECORD":
    case "STRUCT":
      return Object.fromEntries((field.fields ?? []).map((sub, i) => [sub.name, cellValue(sub, (value as Row).f[i]?.v)]));
    default:
      return value;
  }
}

export function toResult(response: QueryResponse, maxRows: number): QueryResult {
  const fields = response.schema?.fields ?? [];
  const rows = (response.rows ?? []).slice(0, maxRows).map((row) => Object.fromEntries(fields.map((field, i) => [field.name, cellValue(field, row.f[i]?.v)])));
  const total = Number(response.totalRows ?? rows.length);
  return { columns: fields.map((field) => field.name), rows, truncated: total > maxRows || (response.rows?.length ?? 0) > maxRows };
}

/**
 * Dry-runs, then runs one query and returns at most `maxRows` rows. Values are
 * named parameters (@name), never pasted into the SQL.
 */
export async function queryBigquery(
  target: BigqueryTarget,
  sql: string,
  params: BigqueryParams,
  maxRows: number,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<QueryResult> {
  const settings = appConfig().bigquery;
  const timeoutMs = options.timeoutMs ?? settings.queryTimeoutMs;
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs + 5_000)]) : AbortSignal.timeout(timeoutMs + 5_000);
  const deadline = Date.now() + timeoutMs;
  const query = {
    query: sql.trim().replace(/;\s*$/, ""),
    useLegacySql: false,
    parameterMode: "NAMED",
    queryParameters: queryParameters(params),
  };

  // 1. Dry run: what kind of statement is it, and what would it scan?
  const dry = await api<{ statistics?: { query?: { statementType?: string; totalBytesProcessed?: string } } }>(
    target,
    "POST",
    `${projectPath(target.projectId)}/jobs`,
    {
      configuration: { dryRun: true, query },
      jobReference: { projectId: target.projectId, location: target.location },
    },
    signal,
  );
  const statementType = dry.statistics?.query?.statementType;
  if (statementType !== "SELECT") {
    throw new BigqueryError("read_only", `Only a single SELECT is allowed; this is ${statementType ? `a ${statementType}` : "not a query"}.`);
  }
  const wouldScan = Number(dry.statistics?.query?.totalBytesProcessed ?? 0);
  if (wouldScan > settings.maxBytesBilled) {
    throw new BigqueryError("too_expensive", undefined, { wouldScan, limit: settings.maxBytesBilled });
  }

  // 2. Run it, capped at the same limit server side.
  let response = await api<QueryResponse>(
    target,
    "POST",
    `${projectPath(target.projectId)}/queries`,
    {
      ...query,
      location: target.location,
      maximumBytesBilled: String(settings.maxBytesBilled),
      maxResults: maxRows + 1,
      timeoutMs: Math.min(timeoutMs, 10_000),
      requestId: randomUUID(),
      labels: { client: "opendashboards" },
    },
    signal,
  );

  // 3. Long queries finish later: wait for them until our deadline, then cancel.
  while (!response.jobComplete) {
    const job = response.jobReference;
    if (!job) throw new BigqueryError("unexpected", "BigQuery didn't say which job to wait for.");
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      const location = job.location ? `?location=${encodeURIComponent(job.location)}` : "";
      await api(target, "POST", `${projectPath(job.projectId)}/jobs/${encodeURIComponent(job.jobId)}/cancel${location}`, undefined, AbortSignal.timeout(5_000)).catch(() => {});
      throw new BigqueryError("timeout", `The query didn't finish within ${timeoutMs / 1000} seconds and was cancelled.`);
    }
    const search = new URLSearchParams({ maxResults: String(maxRows + 1), timeoutMs: String(Math.min(remaining, 10_000)) });
    if (job.location) search.set("location", job.location);
    response = await api<QueryResponse>(target, "GET", `${projectPath(job.projectId)}/queries/${encodeURIComponent(job.jobId)}?${search}`, undefined, signal);
  }
  return toResult(response, maxRows);
}

/** Checks the key works and can run a query in the project. */
export async function testBigqueryConnection(target: BigqueryTarget): Promise<void> {
  await queryBigquery(target, "SELECT 1 AS ok", {}, 1, { timeoutMs: appConfig().bigquery.checkTimeoutMs });
}

/** Datasets in a project: the connection's own, or another such as bigquery-public-data. */
export async function listBigqueryDatasets(target: BigqueryTarget, projectId?: string): Promise<QueryResult> {
  const project = projectId ?? target.projectId;
  if (!PROJECT_ID.test(project)) throw new BigqueryError("bad_query", `"${project}" isn't a project ID.`);
  const response = await api<{ datasets?: { datasetReference: { projectId: string; datasetId: string }; location?: string }[] }>(
    target,
    "GET",
    `${projectPath(project)}/datasets?maxResults=1000`,
    undefined,
    AbortSignal.timeout(appConfig().bigquery.checkTimeoutMs),
  );
  const rows = (response.datasets ?? []).map(({ datasetReference, location }) => ({
    project: datasetReference.projectId,
    dataset: datasetReference.datasetId,
    location: location ?? null,
  }));
  return { columns: ["project", "dataset", "location"], rows, truncated: false };
}

/** Tables in a dataset, with their columns and types. */
export function listBigqueryTables(target: BigqueryTarget, dataset: string, projectId?: string): Promise<QueryResult> {
  const project = projectId ?? target.projectId;
  if (!PROJECT_ID.test(project)) throw new BigqueryError("bad_query", `"${project}" isn't a project ID.`);
  if (!DATASET_ID.test(dataset)) throw new BigqueryError("bad_query", `"${dataset}" isn't a dataset ID.`);
  return queryBigquery(
    target,
    `SELECT table_name AS \`table\`,
            STRING_AGG(CONCAT(column_name, ' ', data_type), ', ' ORDER BY ordinal_position) AS columns
     FROM \`${project}.${dataset}.INFORMATION_SCHEMA.COLUMNS\`
     GROUP BY table_name
     ORDER BY table_name`,
    {},
    500,
  );
}

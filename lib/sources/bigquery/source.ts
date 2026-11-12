import "server-only";

import { z } from "zod";

import { config as appConfig } from "@/config";

import type { ConnectionSource, SourceError, SourceTool } from "../types";

import { bigqueryCatalog, type BigqueryConfig } from "./catalog";
import { listBigqueryDatasets, listBigqueryTables, queryBigquery, testBigqueryConnection, type BigqueryParams } from "./client";
import { readServiceAccountKey, serviceAccountKeySchema } from "../google/credential";
import { BigqueryError } from "./errors";

const target = (connection: { config: BigqueryConfig; credential: string }) => ({ ...connection.config, credential: connection.credential });

const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(bytes < 10 * 1024 ** 3 ? 1 : 0)} GB`;

const queryTool: SourceTool<BigqueryConfig, { sql: string; params?: BigqueryParams }> = {
  name: "bigquery_query",
  description:
    "Run one read-only SELECT in BigQuery (GoogleSQL: backtick-quoted `project.dataset.table`, DATE_TRUNC, " +
    "TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY), APPROX_COUNT_DISTINCT). Pass filter values as params and " +
    "reference them as @name. BigQuery bills by bytes scanned and OpenDashboards refuses queries over a per-query limit: " +
    "select only the columns you need and filter on partition columns (often a date). " +
    "Returns { columns, rows: [{ column: value }], truncated }.",
  parameters: z.object({
    sql: z.string().min(1).describe("One SELECT (or WITH … SELECT) statement in GoogleSQL."),
    params: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
      .optional()
      .describe("Values for @name parameters, by name."),
  }),
  output: {
    columns: ["day", "sessions"],
    rows: [
      { day: "2026-10-30", sessions: 18245 },
      { day: "2026-10-31", sessions: 17902 },
    ],
    truncated: false,
  },
  callers: ["agent", "dashboard"],
  execute: (connection, { sql, params = {} }, { caller, signal }) =>
    queryBigquery(target(connection), sql, params, appConfig().bigquery.maxRows[caller], { signal }),
};

const datasetsTool: SourceTool<BigqueryConfig, { projectId?: string }> = {
  name: "bigquery_datasets",
  description:
    "The datasets in the connection's project, or in another project the service account can read (for example bigquery-public-data).",
  parameters: z.object({ projectId: z.string().min(1).optional().describe("Another project. Defaults to the connection's.") }),
  output: { columns: ["project", "dataset", "location"], rows: [{ project: "my-project", dataset: "analytics", location: "US" }], truncated: false },
  callers: ["agent"],
  execute: (connection, { projectId }) => listBigqueryDatasets(target(connection), projectId),
};

const tablesTool: SourceTool<BigqueryConfig, { dataset: string; projectId?: string }> = {
  name: "bigquery_tables",
  description: "The tables and views in one dataset, with their columns and types.",
  parameters: z.object({
    dataset: z.string().min(1).describe("The dataset ID."),
    projectId: z.string().min(1).optional().describe("The dataset's project. Defaults to the connection's."),
  }),
  output: { columns: ["table", "columns"], rows: [{ table: "events", columns: "event_date STRING, user_id STRING" }], truncated: false },
  callers: ["agent"],
  execute: (connection, { dataset, projectId }) => listBigqueryTables(target(connection), dataset, projectId),
};

const invalid = (error: SourceError) => ({ status: "invalid" as const, error });
const unavailable = (error: SourceError) => ({ status: "unavailable" as const, error });

export const bigquerySource: ConnectionSource<BigqueryConfig> = {
  ...bigqueryCatalog,
  credential: {
    field: "serviceAccountKey",
    schema: serviceAccountKeySchema,
    purpose: "bigquery-service-account",
    // The account's address, never anything of the key.
    hint: (credential) => readServiceAccountKey(credential).client_email,
  },
  async test(config, credential) {
    await testBigqueryConnection({ ...config, credential });
    return [];
  },
  toError(error) {
    if (!(error instanceof BigqueryError)) return null;
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
          message: `The service account is missing a permission: ${error.detail ?? "access denied"}. It needs BigQuery Job User on the project and BigQuery Data Viewer on the data.`,
        });
      case "not_found":
        return invalid({ code: "not_found", message: `Not found: ${error.detail ?? "the project, dataset or table doesn't exist, or this account can't see it"}.` });
      case "not_enabled":
        return invalid({
          code: "not_enabled",
          field: "projectId",
          message: `BigQuery isn't ready on this project: ${error.detail ?? "enable the BigQuery API"}.`,
        });
      case "too_expensive":
        return unavailable({
          code: "too_expensive",
          message: error.bytes
            ? `This query would scan ${gb(error.bytes.wouldScan)}, over the ${gb(error.bytes.limit)} per-query limit. Select fewer columns, filter on the partition column (usually a date), or query a smaller table.`
            : `This query would scan more than the per-query limit. Select fewer columns or filter on the partition column.`,
        });
      case "read_only":
        return unavailable({ code: "read_only", message: `Queries are read-only. ${error.detail ?? "Only SELECT is allowed."}` });
      case "timeout":
        return unavailable({
          code: "timeout",
          message: `The query took longer than ${appConfig().bigquery.queryTimeoutMs / 1000} seconds and was cancelled. Filter to a shorter date range or aggregate more.`,
        });
      case "rate_limited":
        return unavailable({ code: "rate_limited", message: `BigQuery is limiting requests: ${error.detail ?? "quota exceeded"}. Try again shortly.` });
      case "too_heavy":
        return unavailable({
          code: "too_heavy",
          message: `The query needs more resources than BigQuery allows: ${error.detail ?? "resources exceeded"}. Aggregate more, or avoid ORDER BY without LIMIT on large results.`,
        });
      case "bad_query":
        return unavailable({ code: "bad_query", message: `SQL error: ${error.detail ?? "the query was rejected."}` });
      case "unavailable":
        return unavailable({ code: "bigquery_unavailable", message: "Couldn't reach BigQuery. Try again." });
      case "unexpected":
        return unavailable({ code: "bigquery_unexpected", message: "BigQuery sent an unexpected response. Try again." });
    }
  },
  tools: [queryTool, datasetsTool, tablesTool],
};

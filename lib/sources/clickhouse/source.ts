import "server-only";

import { z } from "zod";

import { config as appConfig } from "@/config";

import { passwordHint } from "../password-hint";
import type { ConnectionSource, SourceError, SourceTool } from "../types";

import { clickhouseCatalog, clickhousePasswordSchema, type ClickhouseConfig } from "./catalog";
import { listClickhouseTables, queryClickhouse, testClickhouseConnection, type ClickhouseParams } from "./client";
import { ClickhouseError } from "./errors";

const target = (connection: { config: ClickhouseConfig; credential: string }) => ({ ...connection.config, password: connection.credential });

const queryTool: SourceTool<ClickhouseConfig, { sql: string; params?: ClickhouseParams }> = {
  name: "clickhouse_query",
  description:
    "Run one read-only SELECT on ClickHouse (ClickHouse SQL: toStartOfDay, toStartOfMonth, now() - INTERVAL 30 DAY, " +
    "countIf, uniq, quantile(0.95)(x)). Pass filter values as params and reference them as typed placeholders, " +
    "e.g. WHERE event = {event:String} AND ts >= {since:DateTime}. Returns { columns, rows: [{ column: value }], truncated }. " +
    "Aggregate in the query: tables are often billions of rows.",
  parameters: z.object({
    sql: z.string().min(1).describe("One SELECT (or WITH … SELECT) statement."),
    params: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
      .optional()
      .describe("Values for {name:Type} placeholders, by name."),
  }),
  output: {
    columns: ["day", "events"],
    rows: [
      { day: "2026-10-30", events: 1824512 },
      { day: "2026-10-31", events: 1790233 },
    ],
    truncated: false,
  },
  callers: ["agent", "dashboard"],
  execute: (connection, { sql, params = {} }, { caller, signal }) =>
    queryClickhouse(target(connection), sql, params, appConfig().clickhouse.maxRows[caller], signal),
};

const tablesTool: SourceTool<ClickhouseConfig, { database?: string }> = {
  name: "clickhouse_tables",
  description:
    "The tables in the connection's database (or another database), with their engine, approximate row count, and columns with types.",
  parameters: z.object({ database: z.string().min(1).optional().describe("Another database. Defaults to the connection's.") }),
  output: {
    columns: ["database", "table", "engine", "total_rows", "columns"],
    rows: [{ database: "default", table: "events", engine: "MergeTree", total_rows: 1200000000, columns: "ts DateTime, event String" }],
    truncated: false,
  },
  callers: ["agent"],
  execute: (connection, { database }) => listClickhouseTables(target(connection), database),
};

const invalid = (error: SourceError) => ({ status: "invalid" as const, error });
const unavailable = (error: SourceError) => ({ status: "unavailable" as const, error });

export const clickhouseSource: ConnectionSource<ClickhouseConfig> = {
  ...clickhouseCatalog,
  credential: {
    field: "password",
    schema: clickhousePasswordSchema,
    purpose: "clickhouse-password",
    hint: passwordHint,
  },
  async test(config, credential) {
    const check = await testClickhouseConnection({ ...config, password: credential });
    return check.canWrite ? ["can_write"] : [];
  },
  toError(error) {
    if (!(error instanceof ClickhouseError)) return null;
    switch (error.code) {
      case "auth_failed":
        return invalid({
          code: "auth_failed",
          field: "password",
          message: "ClickHouse didn't accept this user and password. If they're right, the user may not be allowed to connect from OpenDashboards' address.",
        });
      case "database_not_found":
        return invalid({ code: "database_not_found", field: "database", message: "There's no database with this name on the server." });
      case "host_blocked":
        return invalid({
          code: "host_blocked",
          field: "host",
          message: "This host points to a private or reserved address. OpenDashboards only connects to servers reachable on the public internet.",
        });
      case "host_not_found":
        return invalid({ code: "host_not_found", field: "host", message: "This host name doesn't resolve. Check it for typos." });
      case "unreachable":
        return unavailable({
          code: "unreachable",
          field: "host",
          message: "Couldn't reach ClickHouse. Check the host, and that the port is its HTTPS interface (8443 on ClickHouse Cloud).",
        });
      case "tls_failed":
        return invalid({
          code: "tls_failed",
          field: "sslMode",
          message: "Couldn't set up HTTPS. Check the port serves HTTPS (not 8123, which is plain HTTP). If the certificate can't be verified, choose \"Encrypt only\".",
        });
      case "timeout":
        return unavailable({
          code: "timeout",
          message: `The query took longer than ${appConfig().clickhouse.queryTimeoutMs / 1000} seconds and was stopped. Filter on the table's sorting key or a shorter time range, or aggregate more.`,
        });
      case "too_heavy":
        return unavailable({
          code: "too_heavy",
          message: `The query needs more memory or reads more than the server allows (${error.detail ?? "limit exceeded"}). Filter to a shorter time range, group by fewer keys, or use approximate functions like uniq.`,
        });
      case "too_large":
        return unavailable({ code: "too_large", message: "The result was too large to read. Aggregate in the query, select fewer columns, or add a LIMIT." });
      case "read_only":
        return unavailable({
          code: "read_only",
          message: "Queries are read-only: only SELECT is allowed, without table functions that reach outside (url, s3, remote, file…) and without SETTINGS changes.",
        });
      case "access_denied":
        return unavailable({ code: "access_denied", message: `This user can't read that: ${error.detail ?? "access denied"}.` });
      case "rate_limited":
        return unavailable({ code: "rate_limited", message: `ClickHouse is limiting queries right now (${error.detail ?? "too many queries or quota exceeded"}). Try again shortly.` });
      case "bad_query":
        return unavailable({ code: "bad_query", message: `SQL error: ${error.detail ?? "the query was rejected."}` });
      case "unexpected":
        return unavailable({ code: "clickhouse_unexpected", message: `ClickHouse sent an unexpected response. ${error.detail ?? ""}`.trim() });
    }
  },
  tools: [queryTool, tablesTool],
};

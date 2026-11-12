import "server-only";

import { z } from "zod";

import { config as appConfig } from "@/config";

import { passwordHint } from "../password-hint";
import type { ConnectionSource, SourceError, SourceTool } from "../types";

import { mysqlCatalog, mysqlPasswordSchema, type MysqlConfig } from "./catalog";
import { listMysqlTables, queryMysql, testMysqlConnection } from "./client";
import { MysqlError } from "./errors";

const target = (connection: { config: MysqlConfig; credential: string }) => ({ ...connection.config, password: connection.credential });

const queryTool: SourceTool<MysqlConfig, { sql: string; params?: (string | number | boolean | null)[] }> = {
  name: "mysql_query",
  description:
    "Run one read-only SELECT on the MySQL or MariaDB database (MySQL SQL dialect: backtick identifiers, DATE_FORMAT, " +
    "DATE_SUB(NOW(), INTERVAL 30 DAY)). Pass filter values as params and reference them as ? placeholders, in order, " +
    "instead of writing them into the SQL. Returns { columns, rows: [{ column: value }], truncated }.",
  parameters: z.object({
    sql: z.string().min(1).describe("One SELECT (or WITH … SELECT) statement."),
    params: z
      .array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
      .optional()
      .describe("Values for the ? placeholders, in order."),
  }),
  output: {
    columns: ["day", "orders"],
    rows: [
      { day: "2026-10-30", orders: 412 },
      { day: "2026-10-31", orders: 398 },
    ],
    truncated: false,
  },
  callers: ["agent", "dashboard"],
  execute: (connection, { sql, params = [] }, { caller }) =>
    queryMysql(target(connection), sql, params, appConfig().mysql.maxRows[caller]),
};

const tablesTool: SourceTool<MysqlConfig, { schema?: string }> = {
  name: "mysql_tables",
  description:
    "The tables and views in the connection's database (or another database on the same server), with their columns and types.",
  parameters: z.object({ schema: z.string().min(1).optional().describe("Another database on the server. Defaults to the connection's.") }),
  output: {
    columns: ["schema", "table", "kind", "columns"],
    rows: [{ schema: "shop", table: "orders", kind: "BASE TABLE", columns: "id bigint unsigned, created_at datetime" }],
    truncated: false,
  },
  callers: ["agent"],
  execute: (connection, { schema }) => listMysqlTables(target(connection), schema),
};

const invalid = (error: SourceError) => ({ status: "invalid" as const, error });
const unavailable = (error: SourceError) => ({ status: "unavailable" as const, error });

export const mysqlSource: ConnectionSource<MysqlConfig> = {
  ...mysqlCatalog,
  credential: {
    field: "password",
    schema: mysqlPasswordSchema,
    purpose: "mysql-password",
    hint: passwordHint,
  },
  async test(config, credential) {
    const check = await testMysqlConnection({ ...config, password: credential });
    return check.canWrite ? ["can_write"] : [];
  },
  toError(error) {
    if (!(error instanceof MysqlError)) return null;
    switch (error.code) {
      case "auth_failed":
        return invalid({
          code: "auth_failed",
          field: "password",
          message: "MySQL didn't accept this user and password. If they're right, the user may not be allowed to log in from OpenDashboards' address (check its host part, e.g. 'dashboards_reader'@'%').",
        });
      case "database_not_found":
        return invalid({ code: "database_not_found", field: "database", message: "There's no database with this name on the server." });
      case "permission_denied":
        return invalid({ code: "permission_denied", field: "user", message: "This user isn't allowed to use that database." });
      case "host_blocked":
        return invalid({
          code: "host_blocked",
          field: "host",
          message: "This host points to a private or reserved address. OpenDashboards only connects to databases reachable on the public internet.",
        });
      case "host_not_found":
        return invalid({ code: "host_not_found", field: "host", message: "This host name doesn't resolve. Check it for typos." });
      case "unreachable":
        return unavailable({
          code: "unreachable",
          field: "host",
          message: "Couldn't reach the server, or it has no free connections. Check the host and port, and that it accepts connections from OpenDashboards.",
        });
      case "connect_timeout":
        return unavailable({
          code: "connect_timeout",
          field: "host",
          message: "The server didn't answer in time. Check the host and port, or allowlist OpenDashboards' address in your firewall.",
        });
      case "query_timeout":
        return unavailable({
          code: "timeout",
          message: `The query took longer than ${appConfig().mysql.statementTimeoutMs / 1000} seconds and was stopped. Filter to a shorter date range, use indexed columns in WHERE, or aggregate before joining.`,
        });
      case "tls_failed":
        return invalid({
          code: "tls_failed",
          field: "sslMode",
          message: "Couldn't set up an encrypted connection. OpenDashboards only connects over TLS. If the server's certificate can't be verified, choose \"Encrypt only\".",
        });
      case "read_only":
        return unavailable({ code: "read_only", message: `Queries are read-only. ${error.detail ?? "Only SELECT is allowed."}` });
      case "bad_query":
        return unavailable({ code: "bad_query", message: `SQL error: ${error.detail ?? "the query was rejected."}` });
      case "unexpected":
        return unavailable({ code: "mysql_unexpected", message: "MySQL returned an unexpected error. Try again." });
    }
  },
  tools: [queryTool, tablesTool],
};

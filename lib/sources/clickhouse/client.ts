import "server-only";

import { config as appConfig } from "@/config";
import { guardedHttpsRequest } from "@/lib/net/guarded-https";

import type { QueryResult } from "../types";

import type { ClickhouseConfig } from "./catalog";
import { ClickhouseError, fromResponse, toClickhouseError } from "./errors";

/**
 * ClickHouse over its HTTPS interface: the query runs on the user's server,
 * nothing runs here. What keeps it safe:
 *
 * - Requests only reach public addresses, never follow redirects, and the
 *   response is capped (lib/net/guarded-https.ts).
 * - Every request runs with readonly=1. The server then refuses writes, DDL,
 *   temporary tables, and with them every table function that reaches
 *   outside (url, s3, remote, file, executable, mysql, …), and a query can't
 *   change any setting, so it can't lift the limits below.
 * - max_execution_time stops the query on the server; max_result_rows stops
 *   reading rows past the limit.
 * - A user an admin already locked down in its profile refuses some of these
 *   (ClickHouse won't let a read-only session change settings). Then the
 *   profile's own restrictions apply instead: see `Lockdown`.
 * - Multiple statements are refused by ClickHouse itself.
 */

export type ClickhouseTarget = ClickhouseConfig & { password: string };

export type ClickhouseCheck = {
  serverVersion: string;
  /** The user holds grants that change data. Worth a warning. */
  canWrite: boolean;
};

type JsonCompact = {
  meta: { name: string; type: string }[];
  data: unknown[][];
  rows: number;
};

/** Values for `{name:Type}` placeholders, sent as `param_name`. */
export type ClickhouseParams = Record<string, string | number | boolean | null>;

const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/**
 * What we can set per request, which depends on the user's profile:
 * - "full": an ordinary user. We set readonly=1 and the limits.
 * - "profile-readonly-2": the profile says readonly=2 (reads and settings only), so
 *   readonly can't be changed; we still set the limits.
 * - "profile-readonly-1": the profile says readonly=1, so no setting can change; the
 *   server is read-only and its own limits apply. Our timeout and response cap still hold.
 */
export type Lockdown = "full" | "profile-readonly-2" | "profile-readonly-1";

// What each server and user turned out to accept, so later requests don't retry.
const lockdowns = new Map<string, Lockdown>();

/** The request URL: where, and the settings every query runs under. Exported for tests. */
export function clickhouseUrl(
  target: Pick<ClickhouseTarget, "host" | "port" | "database">,
  options: { params?: ClickhouseParams; maxRows: number; timeoutMs: number; lockdown?: Lockdown },
): URL {
  const lockdown = options.lockdown ?? "full";
  const url = new URL(`https://${target.host.includes(":") ? `[${target.host}]` : target.host}:${target.port}/`);
  const query: Record<string, string> = {
    database: target.database,
    default_format: "JSONCompact",
    // Buffer on the server so errors arrive as an error status, not mid-body.
    wait_end_of_query: "1",
    // Numbers as numbers: JSON readers chart them.
    output_format_json_quote_64bit_integers: "0",
    output_format_json_quote_decimals: "0",
  };
  if (lockdown !== "profile-readonly-2") query.readonly = "1";
  if (lockdown !== "profile-readonly-1") {
    Object.assign(query, {
      max_execution_time: String(Math.max(1, Math.floor(options.timeoutMs / 1000) - 2)),
      timeout_overflow_mode: "throw",
      max_result_rows: String(options.maxRows + 1),
      result_overflow_mode: "break",
      // Small blocks, so "break" stops close to the limit.
      max_block_size: String(Math.max(options.maxRows + 1, 100)),
    });
  }
  for (const [name, value] of Object.entries(options.params ?? {})) {
    if (!PARAM_NAME.test(name)) throw new ClickhouseError("bad_query", `"${name}" isn't a valid parameter name.`);
    query[`param_${name}`] = value === null ? "\\N" : String(value);
  }
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url;
}

async function request(
  target: ClickhouseTarget,
  sql: string,
  options: { params?: ClickhouseParams; maxRows: number; timeoutMs: number; signal?: AbortSignal },
): Promise<JsonCompact> {
  const key = `${target.host}:${target.port}:${target.user}`;
  let lockdown = lockdowns.get(key) ?? "full";
  for (;;) {
    try {
      const result = await send(target, sql, { ...options, lockdown });
      lockdowns.set(key, lockdown);
      return result;
    } catch (error) {
      // "Cannot modify 'x' setting in readonly mode": the profile is locked down further than we assumed.
      const setting = error instanceof ClickhouseError && error.serverCode === 164 ? /Cannot modify '(\w+)' setting/.exec(error.detail ?? "")?.[1] : undefined;
      const next: Lockdown | undefined =
        setting === "readonly" && lockdown === "full" ? "profile-readonly-2" : setting && setting !== "readonly" && lockdown !== "profile-readonly-1" ? "profile-readonly-1" : undefined;
      if (!next) throw error;
      lockdown = next;
    }
  }
}

async function send(
  target: ClickhouseTarget,
  sql: string,
  options: { params?: ClickhouseParams; maxRows: number; timeoutMs: number; signal?: AbortSignal; lockdown: Lockdown },
): Promise<JsonCompact> {
  const settings = appConfig().clickhouse;
  const url = clickhouseUrl(target, options);

  let response;
  try {
    response = await guardedHttpsRequest(url, {
      method: "POST",
      headers: {
        "X-ClickHouse-User": target.user,
        "X-ClickHouse-Key": target.password,
        "Content-Type": "text/plain; charset=utf-8",
        "User-Agent": "opendashboards",
      },
      body: sql,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      maxBytes: settings.maxResponseBytes,
      rejectUnauthorized: target.sslMode === "verify-full",
    });
  } catch (error) {
    throw toClickhouseError(error);
  }

  if (response.status !== 200 || response.headers["x-clickhouse-exception-code"]) {
    throw fromResponse(response.status, response.headers["x-clickhouse-exception-code"], response.body);
  }
  let body: unknown;
  try {
    body = JSON.parse(response.body);
  } catch {
    throw new ClickhouseError("unexpected", "The response wasn't JSON. Check the port is ClickHouse's HTTPS interface.");
  }
  const result = body as Partial<JsonCompact>;
  if (!Array.isArray(result.meta) || !Array.isArray(result.data)) {
    throw new ClickhouseError("unexpected", "The response wasn't ClickHouse's JSON format.");
  }
  return result as JsonCompact;
}

/** Runs one query and returns at most `maxRows` rows. */
export async function queryClickhouse(
  target: ClickhouseTarget,
  sql: string,
  params: ClickhouseParams,
  maxRows: number,
  signal?: AbortSignal,
): Promise<QueryResult> {
  const statement = sql.trim().replace(/;\s*$/, "");
  const result = await request(target, statement, { params, maxRows, timeoutMs: appConfig().clickhouse.queryTimeoutMs, signal });
  const columns = result.meta.map((column) => column.name);
  const rows = result.data.slice(0, maxRows).map((values) => Object.fromEntries(columns.map((name, i) => [name, values[i]])));
  return { columns, rows, truncated: result.data.length > maxRows };
}

/** Privileges that change data or schema. */
const WRITE_GRANT = /\bGRANT\s+(?:[^O]*?\b)?(ALL|INSERT|ALTER|CREATE|DROP|TRUNCATE|OPTIMIZE|SYSTEM|KILL QUERY|ACCESS MANAGEMENT)\b/i;

/** Checks the user can log in and read, and whether it could write. */
export async function testClickhouseConnection(target: ClickhouseTarget): Promise<ClickhouseCheck> {
  const timeoutMs = appConfig().clickhouse.checkTimeoutMs;
  const version = await request(target, "SELECT version()", { maxRows: 1, timeoutMs });
  let canWrite = false;
  try {
    const grants = await request(target, "SHOW GRANTS", { maxRows: 1_000, timeoutMs });
    canWrite = grants.data.some(([statement]) => typeof statement === "string" && WRITE_GRANT.test(statement));
  } catch {
    // Not every user may read its own grants; that's no reason to refuse the connection.
  }
  return { serverVersion: String(version.data[0]?.[0] ?? "unknown"), canWrite };
}

/** Tables and views in a database, with their columns, for the agent to explore. */
export function listClickhouseTables(target: ClickhouseTarget, database?: string): Promise<QueryResult> {
  return queryClickhouse(
    target,
    `SELECT c.database AS database, c.table AS table, any(t.engine) AS engine, any(t.total_rows) AS total_rows,
            arrayStringConcat(groupArray(concat(c.name, ' ', c.type)), ', ') AS columns
     FROM (SELECT database, table, name, type, position FROM system.columns
           WHERE database = coalesce({database:Nullable(String)}, currentDatabase())
           ORDER BY database, table, position) AS c
     LEFT JOIN system.tables AS t ON t.database = c.database AND t.name = c.table
     GROUP BY c.database, c.table
     ORDER BY c.table`,
    { database: database ?? null },
    500,
  );
}

import "server-only";

import type { ConnectionOptions } from "node:tls";

import pg from "pg";

import { config as appConfig } from "@/config";
import { createGuardedSocket } from "@/lib/net/guarded-socket";

import type { QueryResult } from "../types";

import type { PostgresConfig, SslMode } from "./catalog";
import { toPostgresError } from "./errors";

export type PostgresTarget = PostgresConfig & { password: string };

export type PostgresCheck = {
  /** e.g. "16.4". */
  serverVersion: string;
  /** The role can change data (superuser, or write rights on a table). Worth a warning. */
  canWrite: boolean;
};


/** Does the role have any way to change data? Owners have every right, so they count. */
const WRITE_ACCESS_SQL = `
  SELECT r.rolsuper OR EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p')
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg_toast%'
      AND (has_table_privilege(c.oid, 'INSERT')
        OR has_table_privilege(c.oid, 'UPDATE')
        OR has_table_privilege(c.oid, 'DELETE'))
  ) AS can_write
  FROM pg_roles r
  WHERE r.rolname = current_user`;

/**
 * Driver settings for a user's server, without the socket. Exported for tests.
 *
 * The password is a function on purpose. Given a string, pg treats an empty
 * one as missing and falls back to the PGPASSWORD environment variable, then
 * ~/.pgpass, which on our servers can hold the password to OUR database. It
 * would then send it to whatever server the user named. A function is never
 * second-guessed: the server gets exactly the user's stored password, empty or not.
 */
export function postgresClientConfig(target: PostgresTarget): pg.ClientConfig {
  // pg fills an empty host, user or database from PGHOST, PGUSER, PGDATABASE: ours. Validation already
  // refuses empty ones; this makes sure no path around it can reach the driver.
  if (!target.host || !target.user || !target.database) throw new Error("Postgres host, user and database must be set");
  return {
    host: target.host,
    port: target.port,
    database: target.database,
    user: target.user,
    password: () => target.password,
    ssl: sslOptions(target.sslMode),
    connectionTimeoutMillis: appConfig().postgres.connectTimeoutMs,
    statement_timeout: appConfig().postgres.statementTimeoutMs,
    query_timeout: appConfig().postgres.statementTimeoutMs + 2_000,
    application_name: "opendashboards",
  };
}

/**
 * Opens a connection, runs `fn` inside a READ ONLY transaction, rolls back and
 * disconnects. The socket only reaches public addresses (see
 * lib/net/guarded-socket.ts), and TLS follows the SSL mode.
 */
async function withReadOnly<T>(target: PostgresTarget, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ ...postgresClientConfig(target), stream: () => createGuardedSocket() });
  // A dropped connection emits 'error' on the client; without a listener it would crash the process.
  client.on("error", () => {});

  try {
    await client.connect();
    await client.query("BEGIN READ ONLY");
    const result = await fn(client);
    await client.query("ROLLBACK");
    return result;
  } catch (error) {
    throw toPostgresError(error);
  } finally {
    await client.end().catch(() => {});
  }
}

/** Connects, runs a read-only check, and disconnects. */
export function testPostgresConnection(target: PostgresTarget): Promise<PostgresCheck> {
  return withReadOnly(target, async (client) => {
    const version = await client.query<{ server_version: string }>("SHOW server_version");
    const access = await client.query<{ can_write: boolean | null }>(WRITE_ACCESS_SQL);
    return {
      serverVersion: version.rows[0]?.server_version.split(" ")[0] ?? "unknown",
      canWrite: access.rows[0]?.can_write === true,
    };
  });
}

/** Postgres types whose text form JSON should carry as a number (bigint, numeric, …). */
const NUMERIC_TYPE_IDS = new Set([20, 21, 23, 700, 701, 1700]);

/**
 * Runs one read-only query and returns at most `maxRows` rows. It goes
 * through a cursor, which Postgres only accepts for SELECT or VALUES: writes,
 * DDL and transaction control are refused by the server itself. Values are
 * bound parameters ($1, $2, …), never pasted into the SQL.
 */
export function queryPostgres(
  target: PostgresTarget,
  sql: string,
  params: readonly unknown[],
  maxRows: number,
): Promise<QueryResult> {
  const statement = sql.trim().replace(/;\s*$/, "");
  return withReadOnly(target, async (client) => {
    // The extended protocol (forced by passing values) refuses multiple statements.
    await client.query({ text: `DECLARE dashboards_cursor NO SCROLL CURSOR FOR ${statement}`, values: [...params], queryMode: "extended" } as pg.QueryConfig);
    const fetched = await client.query(`FETCH ${maxRows + 1} FROM dashboards_cursor`);
    const numeric = new Set(fetched.fields.filter((field) => NUMERIC_TYPE_IDS.has(field.dataTypeID)).map((field) => field.name));
    const rows = fetched.rows.slice(0, maxRows).map((row: Record<string, unknown>) => {
      for (const name of numeric) {
        const value = row[name];
        if (typeof value === "string" && value !== "" && Number.isFinite(Number(value))) row[name] = Number(value);
      }
      return row;
    });
    return { columns: fetched.fields.map((field) => field.name), rows, truncated: fetched.rows.length > maxRows };
  });
}

/** Tables and views the user can read, with their columns, for the agent to explore. */
export function listPostgresTables(target: PostgresTarget, schema?: string): Promise<QueryResult> {
  return queryPostgres(
    target,
    `SELECT c.table_schema AS schema, c.table_name AS table, t.table_type AS kind,
            string_agg(c.column_name || ' ' || c.data_type, ', ' ORDER BY c.ordinal_position) AS columns
     FROM information_schema.columns c
     JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
     WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema')
       AND ($1::text IS NULL OR c.table_schema = $1::text)
     GROUP BY c.table_schema, c.table_name, t.table_type
     ORDER BY c.table_schema, c.table_name`,
    [schema ?? null],
    500,
  );
}

function sslOptions(mode: SslMode): ConnectionOptions {
  switch (mode) {
    case "verify-full":
      // Certificate chain and hostname checked; pg sets servername from the host.
      return { rejectUnauthorized: true };
    case "require":
      return { rejectUnauthorized: false };
  }
}

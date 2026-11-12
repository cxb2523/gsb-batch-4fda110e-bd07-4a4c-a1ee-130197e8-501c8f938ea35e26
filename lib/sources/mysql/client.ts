import "server-only";

import mysql, { type Connection, type ConnectionOptions, type FieldPacket } from "mysql2";

import { config as appConfig } from "@/config";
import { createGuardedSocket } from "@/lib/net/guarded-socket";

import type { QueryResult } from "../types";

import type { MysqlConfig } from "./catalog";
import { MysqlError, toMysqlError } from "./errors";

/**
 * MySQL and MariaDB, over their own wire protocol to the user's server.
 * Nothing runs on OpenDashboards' side but the driver. What keeps it safe:
 *
 * - The socket only reaches public addresses (lib/net/guarded-socket.ts).
 * - TLS is required; "verify-full" also checks the certificate.
 * - LOCAL_FILES is off: a hostile server can otherwise ask the client to
 *   upload any file it names ("LOAD DATA LOCAL INFILE").
 * - One statement per query (no MULTI_STATEMENTS), and only reads: the
 *   session is READ ONLY, so even a statement that commits implicitly can't
 *   write afterwards, and the query must start with SELECT/WITH/SHOW/….
 * - The server stops a query at the time limit, and we stop reading rows at
 *   the row limit.
 */

export type MysqlTarget = MysqlConfig & { password: string };

export type MysqlCheck = {
  /** e.g. "8.0.32", "11.4.2-MariaDB". */
  serverVersion: string;
  /** The user holds a privilege that changes data or files. Worth a warning. */
  canWrite: boolean;
};

/** Privileges that change data, schema or files on the server. */
const WRITE_PRIVILEGES = [
  "INSERT",
  "UPDATE",
  "DELETE",
  "CREATE",
  "DROP",
  "ALTER",
  "INDEX",
  "CREATE VIEW",
  "CREATE ROUTINE",
  "ALTER ROUTINE",
  "EVENT",
  "TRIGGER",
  "FILE",
  "SUPER",
];

/** Privileges granted to the current account, at any level. Roles in use count through CURRENT_ROLE in MySQL 8. */
export const WRITE_ACCESS_SQL = `
  SELECT EXISTS (
    SELECT 1 FROM (
      SELECT GRANTEE, PRIVILEGE_TYPE FROM information_schema.USER_PRIVILEGES
      UNION ALL SELECT GRANTEE, PRIVILEGE_TYPE FROM information_schema.SCHEMA_PRIVILEGES
      UNION ALL SELECT GRANTEE, PRIVILEGE_TYPE FROM information_schema.TABLE_PRIVILEGES
    ) p
    WHERE p.GRANTEE = CONCAT("'", SUBSTRING_INDEX(CURRENT_USER(), '@', 1), "'@'", SUBSTRING_INDEX(CURRENT_USER(), '@', -1), "'")
      AND p.PRIVILEGE_TYPE IN (${WRITE_PRIVILEGES.map((p) => `'${p}'`).join(", ")})
  ) AS can_write`;

/** First keywords a read can start with. Anything else is refused before it reaches the server. */
const READ_STATEMENT = /^(SELECT|WITH|SHOW|DESCRIBE|DESC|EXPLAIN)\b/i;

/**
 * Refuses what isn't a single read, before sending it. Defense in depth: the
 * read-only session is what actually stops writes.
 */
export function checkReadOnlySql(sql: string): string {
  const statement = sql.trim().replace(/;\s*$/, "");
  // /*! … */ and /*M! … */ are executed by MySQL and MariaDB, not ignored.
  if (/\/\*[M]?!/.test(statement)) throw new MysqlError("read_only", "Executable comments (/*! … */) aren't allowed.");
  const body = statement.replace(/^(\s+|--[^\n]*\n?|#[^\n]*\n?|\/\*[\s\S]*?\*\/|\()+/, "");
  if (!READ_STATEMENT.test(body)) {
    throw new MysqlError("read_only", "Queries are read-only: start with SELECT or WITH.");
  }
  if (/\bINTO\s+(OUTFILE|DUMPFILE)\b/i.test(statement)) {
    throw new MysqlError("read_only", "SELECT … INTO OUTFILE writes a file on the server, which isn't allowed.");
  }
  if (/\bFOR\s+(UPDATE|SHARE)\b|\bLOCK\s+IN\s+SHARE\s+MODE\b/i.test(statement)) {
    throw new MysqlError("read_only", "Locking reads (FOR UPDATE, FOR SHARE) aren't allowed.");
  }
  return statement;
}

/** Driver options, without the socket. Exported for tests, which connect to a local server. */
export function mysqlConnectionOptions(target: MysqlTarget): ConnectionOptions {
  return {
    host: target.host,
    port: target.port,
    user: target.user,
    password: target.password,
    database: target.database,
    ssl: { rejectUnauthorized: target.sslMode === "verify-full" },
    flags: ["-LOCAL_FILES", "-MULTI_STATEMENTS"],
    multipleStatements: false,
    connectTimeout: appConfig().mysql.connectTimeoutMs,
    // Values as JSON carries them: exact decimals as numbers, dates as the server wrote them.
    decimalNumbers: true,
    supportBigNumbers: true,
    dateStrings: true,
    charset: "utf8mb4",
    connectAttributes: { program_name: "opendashboards" },
  };
}

/** Makes the session read-only and time-limited. Exported for tests. */
export function readOnlySessionStatements(version: string, timeoutMs: number): string[] {
  return [
    // Session-wide, so even after a statement that commits implicitly nothing can write.
    "SET SESSION TRANSACTION READ ONLY",
    /mariadb/i.test(version) ? `SET SESSION max_statement_time = ${timeoutMs / 1000}` : `SET SESSION max_execution_time = ${Math.floor(timeoutMs)}`,
    "START TRANSACTION READ ONLY",
  ];
}

function open(target: MysqlTarget): Promise<Connection> {
  return new Promise((resolve, reject) => {
    const connection = mysql.createConnection({
      ...mysqlConnectionOptions(target),
      stream: () => {
        const socket = createGuardedSocket();
        socket.connect(target.port, target.host);
        return socket;
      },
    });
    // A dropped connection emits 'error'; without a listener it would crash the process.
    connection.on("error", () => {});
    connection.connect((error) => (error ? reject(error) : resolve(connection)));
  });
}

function run<T = unknown>(connection: Connection, sql: string, values: readonly unknown[] = []): Promise<T> {
  return new Promise((resolve, reject) => {
    connection.query({ sql, values: [...values], timeout: appConfig().mysql.statementTimeoutMs + 2_000 }, (error, rows) =>
      error ? reject(error) : resolve(rows as T),
    );
  });
}

/** Opens a session that can only read, runs `fn`, and always disconnects. */
async function withReadOnly<T>(target: MysqlTarget, fn: (connection: Connection, version: string) => Promise<T>): Promise<T> {
  let connection: Connection | undefined;
  try {
    connection = await open(target);
    const [{ version }] = await run<{ version: string }[]>(connection, "SELECT VERSION() AS version");
    for (const statement of readOnlySessionStatements(version, appConfig().mysql.statementTimeoutMs)) {
      await run(connection, statement);
    }
    return await fn(connection, version);
  } catch (error) {
    throw toMysqlError(error);
  } finally {
    connection?.destroy();
  }
}

/** Connects, reads the version and the user's privileges, and disconnects. */
export function testMysqlConnection(target: MysqlTarget): Promise<MysqlCheck> {
  return withReadOnly(target, async (connection, version) => {
    const [access] = await run<{ can_write: number }[]>(connection, WRITE_ACCESS_SQL);
    return { serverVersion: version, canWrite: access?.can_write === 1 };
  });
}

/** Raw values JSON can't carry well (BLOBs, BIT) become hex strings. */
function jsonSafe(value: unknown): unknown {
  if (Buffer.isBuffer(value)) {
    const hex = value.subarray(0, 64).toString("hex");
    return `0x${hex}${value.length > 64 ? "…" : ""}`;
  }
  return value;
}

/**
 * Runs one read and returns at most `maxRows` rows. Rows stream in, and the
 * connection is closed as soon as one more than the limit arrives, so a huge
 * result never sits in memory. Values are bound (`?`), never pasted into the SQL.
 */
export function queryMysql(target: MysqlTarget, sql: string, params: readonly unknown[], maxRows: number): Promise<QueryResult> {
  const statement = checkReadOnlySql(sql);
  return withReadOnly(target, (connection) => readRows(connection, statement, params, maxRows));
}

export function readRows(connection: Connection, sql: string, params: readonly unknown[], maxRows: number): Promise<QueryResult> {
  return new Promise((resolve, reject) => {
    const rows: Record<string, unknown>[] = [];
    let columns: string[] = [];
    let truncated = false;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve({ columns, rows, truncated });
    };

    const query = connection.query({ sql, values: [...params], timeout: appConfig().mysql.statementTimeoutMs + 2_000 });
    query.on("fields", (fields: FieldPacket[]) => {
      // A second result set would mean a second statement; there can't be one, but keep the first.
      if (!columns.length) columns = fields.map((field) => field.name);
    });
    query.on("result", (row: Record<string, unknown>) => {
      if (settled) return;
      if (rows.length >= maxRows) {
        truncated = true;
        finish();
        connection.destroy();
        return;
      }
      for (const key of Object.keys(row)) row[key] = jsonSafe(row[key]);
      rows.push(row);
    });
    query.on("error", (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    query.on("end", finish);
  });
}

/** Tables and views the user can read, with their columns, for the agent to explore. */
export function listMysqlTables(target: MysqlTarget, schema?: string): Promise<QueryResult> {
  return withReadOnly(target, async (connection) => {
    // The column lists can be long; the default cap is 1 KB.
    await run(connection, "SET SESSION group_concat_max_len = 65535");
    return readRows(
      connection,
      `SELECT c.TABLE_SCHEMA AS \`schema\`, c.TABLE_NAME AS \`table\`, t.TABLE_TYPE AS kind,
              GROUP_CONCAT(CONCAT(c.COLUMN_NAME, ' ', c.COLUMN_TYPE) ORDER BY c.ORDINAL_POSITION SEPARATOR ', ') AS columns
       FROM information_schema.COLUMNS c
       JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
       WHERE c.TABLE_SCHEMA = COALESCE(?, DATABASE())
       GROUP BY c.TABLE_SCHEMA, c.TABLE_NAME, t.TABLE_TYPE
       ORDER BY c.TABLE_NAME`,
      [schema ?? null],
      500,
    );
  });
}

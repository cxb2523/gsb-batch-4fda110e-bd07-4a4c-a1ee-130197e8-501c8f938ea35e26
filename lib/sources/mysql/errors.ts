import { BlockedAddressError } from "@/lib/net/guarded-socket";

export type MysqlErrorCode =
  /** Wrong user or password, or the server refuses logins from OpenDashboards' address. */
  | "auth_failed"
  /** No database with that name. */
  | "database_not_found"
  /** The user may not use this database. */
  | "permission_denied"
  /** The host resolves to a private, loopback or otherwise blocked address. */
  | "host_blocked"
  /** DNS has no such host. */
  | "host_not_found"
  /** Nothing answered, the connection was refused, or the server is full. */
  | "unreachable"
  /** Connecting took too long. */
  | "connect_timeout"
  /** A query ran past the time limit. */
  | "query_timeout"
  /** TLS failed: no TLS on the server, or a certificate we couldn't verify. */
  | "tls_failed"
  /** The query tried to change something. */
  | "read_only"
  /** The SQL itself failed (syntax, unknown table or column, no access to a table…); `detail` says why. */
  | "bad_query"
  /** Anything else. */
  | "unexpected";

export class MysqlError extends Error {
  constructor(
    readonly code: MysqlErrorCode,
    /** The server's or driver's message. Shown to the query's author for bad_query; logs only otherwise. */
    readonly detail?: string,
  ) {
    super(`MySQL request failed: ${code}${detail ? ` (${detail})` : ""}`);
    this.name = "MysqlError";
  }
}

const NETWORK_UNREACHABLE = new Set(["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ECONNRESET", "EPIPE", "PROTOCOL_CONNECTION_LOST"]);
const TLS_CODES = /^(ERR_TLS_|ERR_SSL_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_|CERT_|HOSTNAME_MISMATCH|HANDSHAKE_NO_SSL_SUPPORT)/;

/** Server error numbers, MySQL and MariaDB. */
const ER = {
  ACCESS_DENIED: 1045,
  DB_ACCESS_DENIED: 1044,
  BAD_DB: 1049,
  TOO_MANY_CONNECTIONS: 1040,
  TOO_MANY_USER_CONNECTIONS: 1203,
  HOST_NOT_PRIVILEGED: 1130,
  HOST_BLOCKED: 1129,
  QUERY_INTERRUPTED: 1317,
  MYSQL_QUERY_TIMEOUT: 3024,
  MARIADB_STATEMENT_TIMEOUT: 1969,
  READ_ONLY_TRANSACTION: 1792,
  READ_ONLY_SERVER: 1290,
} as const;

/** Classifies whatever mysql2, Node's net/tls/dns, or our address guard threw. */
export function toMysqlError(error: unknown): MysqlError {
  if (error instanceof MysqlError) return error;

  for (let e: unknown = error; e; e = (e as { cause?: unknown }).cause) {
    if (e instanceof BlockedAddressError) return new MysqlError("host_blocked", e.message);
  }

  const err = error as { code?: unknown; errno?: unknown; sqlState?: unknown; message?: unknown; fatal?: unknown };
  const code = typeof err?.code === "string" ? err.code : "";
  const errno = typeof err?.errno === "number" ? err.errno : 0;
  const sqlState = typeof err?.sqlState === "string" ? err.sqlState : "";
  const message = typeof err?.message === "string" ? err.message : String(error);

  switch (errno) {
    case ER.ACCESS_DENIED:
    case ER.HOST_NOT_PRIVILEGED:
      return new MysqlError("auth_failed", message);
    case ER.DB_ACCESS_DENIED:
      return new MysqlError("permission_denied", message);
    case ER.BAD_DB:
      return new MysqlError("database_not_found", message);
    case ER.TOO_MANY_CONNECTIONS:
    case ER.TOO_MANY_USER_CONNECTIONS:
    case ER.HOST_BLOCKED:
      return new MysqlError("unreachable", message);
    case ER.QUERY_INTERRUPTED:
    case ER.MYSQL_QUERY_TIMEOUT:
    case ER.MARIADB_STATEMENT_TIMEOUT:
      return new MysqlError("query_timeout", message);
    case ER.READ_ONLY_TRANSACTION:
    case ER.READ_ONLY_SERVER:
      return new MysqlError("read_only", message);
  }

  switch (code) {
    case "ENOTFOUND":
    case "EAI_AGAIN":
    case "EAI_NONAME":
      return new MysqlError("host_not_found", message);
    case "ETIMEDOUT":
      return new MysqlError("connect_timeout", message);
    case "PROTOCOL_SEQUENCE_TIMEOUT":
      return new MysqlError("query_timeout", message);
  }
  if (NETWORK_UNREACHABLE.has(code)) return new MysqlError("unreachable", message);
  if (TLS_CODES.test(code) || /secure connection|certificate|self[- ]signed|SSL|TLS/i.test(message)) {
    return new MysqlError("tls_failed", message);
  }
  // A server error about the statement itself: syntax, unknown objects, table or column access.
  if (errno && (sqlState.startsWith("42") || sqlState.startsWith("22") || sqlState.startsWith("HY") || sqlState.startsWith("0A"))) {
    return new MysqlError("bad_query", message);
  }
  return new MysqlError("unexpected", message);
}

import { BlockedAddressError } from "@/lib/net/guarded-socket";
import { ResponseTooLargeError } from "@/lib/net/guarded-https";

export type ClickhouseErrorCode =
  | "auth_failed"
  | "database_not_found"
  | "host_blocked"
  | "host_not_found"
  | "unreachable"
  | "timeout"
  | "tls_failed"
  /** The query tried to change something, or used something OpenDashboards doesn't allow. */
  | "read_only"
  /** The user may not read a table or use a function. */
  | "access_denied"
  /** The query needs more memory, rows or bytes than the server allows. */
  | "too_heavy"
  /** Too many queries at once, or a quota ran out. */
  | "rate_limited"
  /** The response was bigger than OpenDashboards reads. */
  | "too_large"
  /** The SQL itself failed: syntax, unknown table, column or function, type errors…; `detail` says why. */
  | "bad_query"
  /** The server answered with something that isn't ClickHouse's JSON. */
  | "unexpected";

export class ClickhouseError extends Error {
  constructor(
    readonly code: ClickhouseErrorCode,
    /** The server's message, without its stack trace. */
    readonly detail?: string,
    /** ClickHouse's numeric error code, when it sent one. */
    readonly serverCode?: number,
  ) {
    super(`ClickHouse request failed: ${code}${serverCode ? ` [${serverCode}]` : ""}${detail ? ` (${detail})` : ""}`);
    this.name = "ClickhouseError";
  }
}

/** ClickHouse error codes (src/Common/ErrorCodes.cpp). */
const CODES: Record<number, ClickhouseErrorCode> = {
  516: "auth_failed", // AUTHENTICATION_FAILED
  192: "auth_failed", // UNKNOWN_USER
  193: "auth_failed", // WRONG_PASSWORD
  194: "auth_failed", // REQUIRED_PASSWORD
  195: "auth_failed", // IP_ADDRESS_NOT_ALLOWED
  81: "database_not_found", // UNKNOWN_DATABASE
  497: "access_denied", // ACCESS_DENIED
  164: "read_only", // READONLY
  159: "timeout", // TIMEOUT_EXCEEDED
  394: "timeout", // QUERY_WAS_CANCELLED
  241: "too_heavy", // MEMORY_LIMIT_EXCEEDED
  158: "too_heavy", // TOO_MANY_ROWS
  307: "too_heavy", // TOO_MANY_BYTES
  396: "too_heavy", // TOO_MANY_ROWS_OR_BYTES
  202: "rate_limited", // TOO_MANY_SIMULTANEOUS_QUERIES
  201: "rate_limited", // QUOTA_EXCEEDED
};

/**
 * ClickHouse's message without the noise: "Code: 60. DB::Exception: Unknown
 * table … (UNKNOWN_TABLE) (version 25.8…)" becomes "Unknown table … (UNKNOWN_TABLE)".
 */
export function serverMessage(body: string): string {
  const firstLine = body.trim().split("\n")[0] ?? "";
  return firstLine
    .replace(/^Code:\s*\d+\.\s*/, "")
    .replace(/^DB::Exception:\s*/, "")
    .replace(/\s*\(version [^()]*(?:\([^)]*\))?\)\s*$/, "")
    .replace(/\.?\s*Stack trace:[\s\S]*$/, "")
    .slice(0, 1_000);
}

/** Classifies a ClickHouse error response by its code. */
export function fromResponse(status: number, codeHeader: string | undefined, body: string): ClickhouseError {
  const fromBody = /^Code:\s*(\d+)/.exec(body.trim())?.[1];
  const serverCode = Number(codeHeader ?? fromBody) || undefined;
  const detail = serverMessage(body) || `HTTP ${status}`;
  if (serverCode !== undefined) return new ClickhouseError(CODES[serverCode] ?? "bad_query", detail, serverCode);
  if (status === 401 || status === 403) return new ClickhouseError("auth_failed", detail);
  if (status === 429) return new ClickhouseError("rate_limited", detail);
  if (status >= 500) return new ClickhouseError("unreachable", detail);
  return new ClickhouseError("unexpected", detail);
}

const NETWORK_UNREACHABLE = new Set(["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ECONNRESET", "EPIPE"]);
const TLS_CODES = /^(ERR_TLS_|ERR_SSL_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_|CERT_|HOSTNAME_MISMATCH|EPROTO)/;

/** Classifies a failure to talk to the server at all. */
export function toClickhouseError(error: unknown): ClickhouseError {
  if (error instanceof ClickhouseError) return error;
  for (let e: unknown = error; e; e = (e as { cause?: unknown }).cause) {
    if (e instanceof BlockedAddressError) return new ClickhouseError("host_blocked", e.message);
    if (e instanceof ResponseTooLargeError) return new ClickhouseError("too_large", e.message);
  }
  const err = error as { code?: unknown; message?: unknown; name?: unknown };
  const code = typeof err?.code === "string" ? err.code : "";
  const message = typeof err?.message === "string" ? err.message : String(error);
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "EAI_NONAME") return new ClickhouseError("host_not_found", message);
  if (code === "ETIMEDOUT" || err?.name === "AbortError") return new ClickhouseError("timeout", message);
  if (NETWORK_UNREACHABLE.has(code)) return new ClickhouseError("unreachable", message);
  if (TLS_CODES.test(code) || /certificate|self[- ]signed|SSL|TLS/i.test(message)) return new ClickhouseError("tls_failed", message);
  return new ClickhouseError("unexpected", message);
}

import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError as ProtocolError } from "@modelcontextprotocol/sdk/types.js";

import { OriginNotAllowedError, RedirectRefusedError, ResponseTooLargeError } from "@/lib/net/guarded-fetch";
import { BlockedAddressError } from "@/lib/net/guarded-socket";

export type McpErrorCode =
  | "host_blocked"
  | "host_not_found"
  | "unreachable"
  | "tls_failed"
  /** The server redirected, which is never followed. */
  | "redirected"
  /** Something tried to send a request outside the server's origin. */
  | "origin_refused"
  /** The server wants a key and none was given, or it wants OAuth. */
  | "auth_required"
  /** The key was refused. */
  | "key_rejected"
  /** The key works but isn't allowed this. */
  | "access_denied"
  /** Not an MCP endpoint (404, 405, not JSON-RPC, no tools). */
  | "not_mcp"
  /** A later page of the tool list failed: the tools returned so far are only part of the server's. */
  | "list_incomplete"
  /** The arguments didn't fit the tool, or there's no such tool. */
  | "bad_arguments"
  /** The tool ran and reported a failure. */
  | "tool_error"
  | "too_large"
  | "timeout"
  | "unavailable"
  | "unexpected";

export class McpError extends Error {
  constructor(
    readonly code: McpErrorCode,
    /** The server's message, trimmed. Shown to the agent for tool and argument errors; logs otherwise. */
    readonly detail?: string,
  ) {
    super(`MCP request failed: ${code}${detail ? ` (${detail})` : ""}`);
    this.name = "McpError";
  }
}

const NETWORK_UNREACHABLE = new Set(["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ECONNRESET", "EPIPE", "UND_ERR_SOCKET"]);
const TLS_CODES = /^(ERR_TLS_|ERR_SSL_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_|CERT_|HOSTNAME_MISMATCH)/;

const trim = (text: string | undefined) => text?.replace(/\s+/g, " ").trim().slice(0, 500) || undefined;

/**
 * Classifies whatever the SDK, undici or our guards threw. The SDK wraps
 * transport failures, so the cause chain is searched for the real reason.
 */
export function toMcpError(error: unknown, { hasKey }: { hasKey: boolean }): McpError {
  const chain: unknown[] = [];
  for (let e: unknown = error, depth = 0; e && depth < 8; e = (e as { cause?: unknown }).cause, depth++) chain.push(e);

  for (const e of chain) {
    if (e instanceof McpError) return e;
    if (e instanceof BlockedAddressError) return new McpError("host_blocked", e.message);
    if (e instanceof OriginNotAllowedError) return new McpError("origin_refused");
    if (e instanceof RedirectRefusedError) return new McpError("redirected", e.message);
    if (e instanceof ResponseTooLargeError) return new McpError("too_large", e.message);
  }
  for (const e of chain) {
    if (e instanceof UnauthorizedError) return new McpError(hasKey ? "key_rejected" : "auth_required", trim(e.message));
    if (e instanceof StreamableHTTPError) {
      if (e.code === 401) return new McpError(hasKey ? "key_rejected" : "auth_required", trim(e.message));
      if (e.code === 403) return new McpError("access_denied", trim(e.message));
      if (e.code === 404 || e.code === 405 || e.code === 406 || e.code === 415) return new McpError("not_mcp", trim(e.message));
      if (e.code === 429) return new McpError("unavailable", "The server is rate-limiting requests.");
      if (e.code !== undefined && e.code >= 500) return new McpError("unavailable", trim(e.message));
    }
    if (e instanceof ProtocolError) {
      switch (e.code) {
        case ErrorCode.RequestTimeout:
          return new McpError("timeout", trim(e.message));
        case ErrorCode.MethodNotFound:
          return new McpError("not_mcp", "The server doesn't offer tools.");
        case ErrorCode.InvalidParams:
          return new McpError("bad_arguments", trim(e.message));
        case ErrorCode.ConnectionClosed:
          return new McpError("unavailable", trim(e.message));
        case ErrorCode.ParseError:
        case ErrorCode.InvalidRequest:
          return new McpError("not_mcp", trim(e.message));
        default:
          return new McpError("tool_error", trim(e.message));
      }
    }
  }
  for (const e of chain) {
    const err = e as { code?: unknown; name?: unknown; message?: unknown };
    const code = typeof err?.code === "string" ? err.code : "";
    const message = typeof err?.message === "string" ? err.message : "";
    if (err?.name === "TimeoutError" || err?.name === "AbortError" || code === "UND_ERR_CONNECT_TIMEOUT" || code === "ETIMEDOUT") {
      return new McpError("timeout");
    }
    if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "EAI_NONAME") return new McpError("host_not_found");
    if (TLS_CODES.test(code)) return new McpError("tls_failed", message);
    if (NETWORK_UNREACHABLE.has(code)) return new McpError("unreachable", message);
    if (err?.name === "SyntaxError") return new McpError("not_mcp", "The server's reply wasn't JSON.");
  }
  const message = error instanceof Error ? error.message : String(error);
  return new McpError("unexpected", trim(message));
}

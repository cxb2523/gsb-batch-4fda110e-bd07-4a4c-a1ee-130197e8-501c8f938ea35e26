import "server-only";

import https from "node:https";
import net from "node:net";

import { BlockedAddressError, createGuardedLookup, isPublicAddress } from "./guarded-socket";

/**
 * HTTPS to a host a user typed in (a ClickHouse server, say), with the same
 * SSRF rules as the guarded socket: only public addresses, checked on the
 * addresses actually connected to. Plain HTTP is refused, redirects are never
 * followed, and the response is capped so a server can't exhaust our memory.
 */

export type GuardedResponse = {
  status: number;
  headers: Record<string, string | undefined>;
  body: string;
};

/** The response was bigger than we're willing to hold. */
export class ResponseTooLargeError extends Error {
  constructor(readonly limitBytes: number) {
    super(`The response was larger than ${limitBytes} bytes`);
    this.name = "ResponseTooLargeError";
  }
}

export type GuardedRequest = {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  /** Gives up after this long, connecting included. */
  timeoutMs: number;
  /** Largest response body we'll read. */
  maxBytes: number;
  /** Check the server's certificate. Defaults to true; false only for a user's explicit "encrypt only". */
  rejectUnauthorized?: boolean;
};

export function guardedHttpsRequest(target: URL, request: GuardedRequest): Promise<GuardedResponse> {
  return new Promise((resolve, reject) => {
    if (target.protocol !== "https:") {
      reject(new Error("Only https:// URLs are allowed"));
      return;
    }
    const hostname = target.hostname.replace(/^\[(.*)\]$/, "$1");
    // Node skips the lookup for IP literals, so check those directly.
    if (net.isIP(hostname) && !isPublicAddress(hostname)) {
      reject(new BlockedAddressError(hostname, hostname));
      return;
    }

    const req = https.request(
      target,
      {
        method: request.method ?? "GET",
        headers: request.headers,
        lookup: createGuardedLookup() as net.LookupFunction,
        signal: request.signal,
        timeout: request.timeoutMs,
        rejectUnauthorized: request.rejectUnauthorized ?? true,
        // No shared connection pool: every request does its own guarded lookup.
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > request.maxBytes) {
            req.destroy(new ResponseTooLargeError(request.maxBytes));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          const headers: Record<string, string | undefined> = {};
          for (const [name, value] of Object.entries(res.headers)) {
            headers[name] = Array.isArray(value) ? value.join(", ") : value;
          }
          resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks).toString("utf8") });
        });
        res.on("error", reject);
      },
    );
    // A single deadline for the whole exchange, not just idle time.
    const deadline = setTimeout(
      () => req.destroy(Object.assign(new Error("Request timed out"), { code: "ETIMEDOUT" })),
      request.timeoutMs,
    );
    req.on("timeout", () => req.destroy(Object.assign(new Error("Request timed out"), { code: "ETIMEDOUT" })));
    req.on("error", (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    req.on("close", () => clearTimeout(deadline));
    req.end(request.body);
  });
}

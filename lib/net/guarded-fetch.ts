import "server-only";

import dns from "node:dns";
import net from "node:net";

import { Agent, fetch as undiciFetch, type Dispatcher } from "undici";

import { BlockedAddressError, createGuardedLookup, isPublicAddress } from "./guarded-socket";
import { isOwnHost } from "./own-hosts";

/**
 * A `fetch` for servers a user named (an MCP server, say), with the same
 * SSRF rules as the guarded socket, for libraries that take a custom fetch:
 *
 * - Only the one origin it was made for: scheme, host and port. Anything
 *   else (another host a server pointed to, a path elsewhere) is refused, so
 *   credentials in its headers can't travel.
 * - HTTPS only, certificates checked; no user info in URLs.
 * - Every connection goes through the guarded lookup: public unicast
 *   addresses only, checked on the addresses actually connected to (no DNS
 *   rebinding), and never our own infrastructure. IP literals are checked
 *   directly, after URL parsing has normalized forms like 0x7f.1.
 * - Its own dispatcher, so proxy environment variables never route it
 *   elsewhere, and no connection is shared with anything else.
 * - Redirects are never followed: any 3xx is an error, whatever the caller asked.
 * - The body is capped as it streams; one deadline covers the whole request.
 */

export class ResponseTooLargeError extends Error {
  constructor(readonly limitBytes: number) {
    super(`The response was larger than ${limitBytes} bytes`);
    this.name = "ResponseTooLargeError";
  }
}

/** A request went somewhere this fetch isn't for. */
export class OriginNotAllowedError extends Error {
  constructor(readonly url: string) {
    super("Refusing a request outside the connection's origin");
    this.name = "OriginNotAllowedError";
  }
}

/** The server answered with a redirect, which is never followed. */
export class RedirectRefusedError extends Error {
  constructor(readonly status: number) {
    super(`Refusing to follow a redirect (HTTP ${status})`);
    this.name = "RedirectRefusedError";
  }
}

export type GuardedFetchOptions = {
  /** The only origin requests may go to: "https://mcp.example.com". */
  origin: string;
  /** Largest response body read, in bytes. */
  maxBytes: number;
  /** Overall deadline for each request, connecting and reading included. */
  timeoutMs: number;
  /** False only for a user's explicit "encrypt only". */
  rejectUnauthorized?: boolean;
};

/**
 * Tests only: reach a local test server. Never set by app code; the default
 * policy is the production one.
 */
export type GuardedFetchTestHooks = { allowAddress?: (address: string) => boolean; allowHttp?: boolean };

export type GuardedFetch = ((input: string | URL | Request, init?: RequestInit) => Promise<Response>) & {
  /** Closes its connections. */
  close(): Promise<void>;
};

export function createGuardedFetch(options: GuardedFetchOptions, testHooks: GuardedFetchTestHooks = {}): GuardedFetch {
  const allowed = new URL(options.origin);
  const allowHttp = testHooks.allowHttp === true;
  if (allowed.protocol !== "https:" && !(allowHttp && allowed.protocol === "http:")) {
    throw new OriginNotAllowedError(options.origin);
  }
  const isAllowedAddress = testHooks.allowAddress ?? isPublicAddress;
  const lookup = testHooks.allowAddress ? createTestLookup(testHooks.allowAddress) : createGuardedLookup();

  const dispatcher: Dispatcher = new Agent({
    connect: { lookup: lookup as net.LookupFunction, rejectUnauthorized: options.rejectUnauthorized ?? true },
    // One request at a time per connection; nothing pooled for long.
    keepAliveTimeout: 1_000,
    keepAliveMaxTimeout: 5_000,
  });

  const guarded = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== allowed.origin || url.username || url.password) throw new OriginNotAllowedError(url.href);
    const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
    if ((net.isIP(host) && !isAllowedAddress(host)) || isOwnHost(host)) throw new BlockedAddressError(host, host);

    const deadline = AbortSignal.timeout(options.timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
    const response = (await undiciFetch(url, {
      ...(init as Parameters<typeof undiciFetch>[1]),
      redirect: "manual",
      signal,
      dispatcher,
    })) as unknown as Response;

    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => {});
      throw new RedirectRefusedError(response.status);
    }
    return capBody(response, options.maxBytes);
  }) as GuardedFetch;
  guarded.close = () => dispatcher.close().catch(() => {});
  return guarded;
}

/** The same response, with a body that errors once it passes `maxBytes`. */
function capBody(response: Response, maxBytes: number): Response {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes) {
    void response.body?.cancel().catch(() => {});
    throw new ResponseTooLargeError(maxBytes);
  }
  if (!response.body) return response;
  let seen = 0;
  const limited = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > maxBytes) controller.error(new ResponseTooLargeError(maxBytes));
        else controller.enqueue(chunk);
      },
    }),
  );
  return new Response(limited, { status: response.status, statusText: response.statusText, headers: response.headers });
}

/** Tests only: a lookup that allows what the test's policy allows (a local server). */
function createTestLookup(allowAddress: (address: string) => boolean) {
  return (hostname: string, options: { all?: boolean }, callback: (error: Error | null, address: unknown, family?: number) => void) => {
    dns.lookup(hostname, { all: true }, (error, addresses) => {
      if (error) return callback(error, []);
      const blocked = addresses.find(({ address }) => !allowAddress(address));
      if (blocked) return callback(new BlockedAddressError(hostname, blocked.address), []);
      if (options.all) return callback(null, addresses);
      callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

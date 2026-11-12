import { config } from "@/config";

import { POSTHOG_HOSTS, type HostKind } from "./hosts";

export type PostHogErrorCode =
  /** The key is wrong, revoked, or its user was deleted (PostHog sends 401 or 403). */
  | "invalid_key"
  /** 403 permission error naming a scope: the key lacks the Query Read permission. */
  | "missing_scope"
  /** 403 permission error otherwise: the key can't access this project. */
  | "project_forbidden"
  /** 404: no such project on this host. */
  | "project_not_found"
  /** 429: PostHog's rate limit or hourly query budget. */
  | "rate_limited"
  /** 400: the HogQL didn't parse or run; `detail` says why. */
  | "bad_query"
  /** The query ran past the time allowed. */
  | "timeout"
  /** Network error or 5xx. */
  | "unavailable"
  /** Anything else PostHog answered that we don't expect. */
  | "unexpected";

export class PostHogError extends Error {
  constructor(
    readonly code: PostHogErrorCode,
    readonly status?: number,
    /** PostHog's explanation, for query errors. */
    readonly detail?: string,
    options?: { cause?: unknown },
  ) {
    super(`PostHog request failed: ${code}${status ? ` (HTTP ${status})` : ""}`, options);
    this.name = "PostHogError";
  }
}

export type PostHogTarget = { hostKind: HostKind; projectId: string; apiKey: string };


/**
 * Runs a HogQL query through `POST /api/projects/:id/query/`. The host comes
 * from the host kind, never from a caller-supplied URL.
 */
export async function runHogQLQuery(
  target: PostHogTarget,
  query: string,
  options: { signal?: AbortSignal; timeoutMs?: number; fetch?: typeof fetch } = {},
): Promise<{ results: unknown[]; columns: string[] }> {
  const { url } = POSTHOG_HOSTS[target.hostKind];
  const timeout = AbortSignal.timeout(options.timeoutMs ?? config().posthog.checkTimeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(
      `${url}/api/projects/${encodeURIComponent(target.projectId)}/query/`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${target.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: { kind: "HogQLQuery", query }, name: "opendashboards" }),
        redirect: "error",
        cache: "no-store",
        signal,
      },
    );
  } catch (error) {
    // A caller's own abort is theirs to handle; a timeout or network error isn't.
    if (options.signal?.aborted) throw error;
    throw new PostHogError(timeout.aborted ? "timeout" : "unavailable", undefined, undefined, { cause: error });
  }

  if (!response.ok) {
    const body = await errorBody(response.clone());
    throw new PostHogError(await classify(response), response.status, body.detail || undefined);
  }

  const body: unknown = await response.json().catch(() => null);
  if (!isRecord(body) || !Array.isArray(body.results)) {
    throw new PostHogError("unexpected", response.status);
  }
  const columns = Array.isArray(body.columns) ? body.columns.map(String) : [];
  return { results: body.results, columns };
}

/** Checks a key and project with the cheapest possible query. */
export async function testConnection(
  target: PostHogTarget,
  options: { signal?: AbortSignal; fetch?: typeof fetch } = {},
): Promise<void> {
  await runHogQLQuery(target, "SELECT 1", options);
}

async function classify(response: Response): Promise<PostHogErrorCode> {
  switch (response.status) {
    case 401:
    case 403: {
      // PostHog answers a bad key with 403 too, so the body decides:
      // {"type":"authentication_error","code":"authentication_failed",...}
      const body = await errorBody(response);
      if (response.status === 401 || body.type === "authentication_error") return "invalid_key";
      return /scope/i.test(body.detail) ? "missing_scope" : "project_forbidden";
    }
    case 404:
      return "project_not_found";
    case 429:
      return "rate_limited";
    case 400:
      return "bad_query";
    default: {
      if (response.status < 500) return "unexpected";
      // A query that ran out of time comes back as a 504 too, and is the
      // query's problem, not PostHog being down.
      const { detail } = await errorBody(response);
      return /max execution time|timed? ?out/i.test(detail) ? "timeout" : "unavailable";
    }
  }
}

async function errorBody(response: Response): Promise<{ type: string; detail: string }> {
  const body: unknown = await response.json().catch(() => null);
  if (!isRecord(body)) return { type: "", detail: "" };
  return {
    type: typeof body.type === "string" ? body.type : "",
    detail: typeof body.detail === "string" ? body.detail : "",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

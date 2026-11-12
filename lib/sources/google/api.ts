import "server-only";

import { googleAccessToken, GoogleAuthError } from "./auth";

/**
 * Calls a Google REST API (Search Console, Analytics Data) as a service
 * account, and classifies failures the same way for each. Only fixed
 * Google hosts are called; redirects are refused.
 */

export type GoogleErrorCode =
  /** Google refused the key: deleted, disabled, or not a real key. */
  | "key_rejected"
  /** The account hasn't been given access to the property or site. */
  | "access_denied"
  /** The API isn't enabled in the service account's Google Cloud project. */
  | "not_enabled"
  /** The property or site doesn't exist, or the account can't see it. */
  | "not_found"
  /** The request itself is wrong: an unknown field, an incompatible combination, a bad date… */
  | "bad_request"
  /** A quota ran out, or too many requests. */
  | "rate_limited"
  | "timeout"
  /** Google's side failed, or the network did. */
  | "unavailable"
  | "unexpected";

export class GoogleApiError extends Error {
  constructor(
    readonly code: GoogleErrorCode,
    /** Google's message. Shown to the agent for bad requests; logs otherwise. */
    readonly detail?: string,
    /** For not_enabled: where to switch the API on, when Google said. */
    readonly activationUrl?: string,
  ) {
    super(`Google API request failed: ${code}${detail ? ` (${detail})` : ""}`);
    this.name = "GoogleApiError";
  }
}

type GoogleErrorBody = {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    errors?: { reason?: string; message?: string }[];
    details?: { "@type"?: string; reason?: string; metadata?: { activationUrl?: string } }[];
  };
};

/** Classifies an error response: google.rpc status first, then the older `errors[].reason`, then HTTP status. */
export function fromGoogleError(status: number, body: unknown): GoogleApiError {
  const error = (body as GoogleErrorBody)?.error;
  const message = (error?.message ?? `HTTP ${status}`).slice(0, 1_000);
  const info = error?.details?.find((detail) => detail["@type"]?.endsWith("google.rpc.ErrorInfo"));
  if (info?.reason === "SERVICE_DISABLED" || /has not been used in project|is disabled|not been enabled/i.test(message)) {
    return new GoogleApiError("not_enabled", message, info?.metadata?.activationUrl);
  }
  const reason = error?.errors?.[0]?.reason ?? "";
  if (/quota|rateLimit/i.test(reason)) return new GoogleApiError("rate_limited", message);
  switch (error?.status) {
    case "UNAUTHENTICATED":
      return new GoogleApiError("key_rejected", message);
    case "PERMISSION_DENIED":
      return new GoogleApiError("access_denied", message);
    case "NOT_FOUND":
      return new GoogleApiError("not_found", message);
    case "INVALID_ARGUMENT":
    case "FAILED_PRECONDITION":
    case "OUT_OF_RANGE":
      return new GoogleApiError("bad_request", message);
    case "RESOURCE_EXHAUSTED":
      return new GoogleApiError("rate_limited", message);
    case "DEADLINE_EXCEEDED":
      return new GoogleApiError("timeout", message);
    case "UNAVAILABLE":
    case "INTERNAL":
      return new GoogleApiError("unavailable", message);
  }
  if (status === 401) return new GoogleApiError("key_rejected", message);
  if (status === 403) return new GoogleApiError("access_denied", message);
  if (status === 404) return new GoogleApiError("not_found", message);
  if (status === 400) return new GoogleApiError("bad_request", message);
  if (status === 429) return new GoogleApiError("rate_limited", message);
  if (status >= 500) return new GoogleApiError("unavailable", message);
  return new GoogleApiError("unexpected", message);
}

/** One authenticated JSON request. */
export async function googleRequest<T>(
  credential: string,
  scope: string,
  url: string,
  init: { method: "GET" | "POST"; body?: unknown; signal: AbortSignal },
): Promise<T> {
  let token: string;
  try {
    token = await googleAccessToken(credential, scope, init.signal);
  } catch (error) {
    if (error instanceof GoogleAuthError) {
      throw new GoogleApiError(error.code === "key_rejected" ? "key_rejected" : "unavailable", error.detail);
    }
    throw error;
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      redirect: "error",
      cache: "no-store",
      signal: init.signal,
    });
  } catch (error) {
    const name = (error as { name?: string })?.name;
    throw new GoogleApiError(name === "TimeoutError" || name === "AbortError" ? "timeout" : "unavailable", (error as Error)?.message);
  }
  const json: unknown = await response.json().catch(() => null);
  if (!response.ok) throw fromGoogleError(response.status, json);
  return json as T;
}

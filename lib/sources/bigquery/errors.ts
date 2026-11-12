export type BigqueryErrorCode =
  /** Google refused the key: deleted, disabled, or not a real key. */
  | "key_rejected"
  /** The service account lacks a role or permission. */
  | "access_denied"
  /** The project, dataset or table doesn't exist (or isn't visible to this account). */
  | "not_found"
  /** The BigQuery API isn't enabled on the project, or billing isn't set up for what was asked. */
  | "not_enabled"
  /** The query would scan more than OpenDashboards allows for one query. */
  | "too_expensive"
  /** The query tried to change something, or isn't a single SELECT. */
  | "read_only"
  /** The query took too long; it was cancelled. */
  | "timeout"
  /** Too many requests, or a quota ran out. */
  | "rate_limited"
  /** The query needs more resources than BigQuery gives it. */
  | "too_heavy"
  /** The SQL itself failed: syntax, unknown column, type errors…; `detail` says why. */
  | "bad_query"
  /** Google's side failed, or the network did. */
  | "unavailable"
  | "unexpected";

export class BigqueryError extends Error {
  constructor(
    readonly code: BigqueryErrorCode,
    /** Google's message. Shown to the query's author for query errors; logs only otherwise. */
    readonly detail?: string,
    /** For too_expensive: bytes the query would scan, and the limit. */
    readonly bytes?: { wouldScan: number; limit: number },
  ) {
    super(`BigQuery request failed: ${code}${detail ? ` (${detail})` : ""}`);
    this.name = "BigqueryError";
  }
}

/** An error body from BigQuery's REST API. */
type ApiError = { error?: { code?: number; message?: string; status?: string; errors?: { reason?: string; message?: string }[] } };

/** Classifies a BigQuery API error by its reason (cloud.google.com/bigquery/docs/error-messages). */
export function fromApiError(status: number, body: unknown): BigqueryError {
  const error = (body as ApiError)?.error;
  const reason = error?.errors?.[0]?.reason ?? "";
  const message = (error?.errors?.[0]?.message ?? error?.message ?? `HTTP ${status}`).slice(0, 1_000);
  switch (reason) {
    case "accessDenied":
      if (/has not been used|is disabled|not enabled/i.test(message)) return new BigqueryError("not_enabled", message);
      return new BigqueryError("access_denied", message);
    case "notFound":
      return new BigqueryError("not_found", message);
    case "billingNotEnabled":
    case "billingTierLimitExceeded":
      return new BigqueryError("not_enabled", message);
    case "bytesBilledLimitExceeded":
      return new BigqueryError("too_expensive", message);
    case "rateLimitExceeded":
    case "quotaExceeded":
      return new BigqueryError("rate_limited", message);
    case "resourcesExceeded":
    case "responseTooLarge":
      return new BigqueryError("too_heavy", message);
    case "timeout":
    case "stopped":
      return new BigqueryError("timeout", message);
    case "invalidQuery":
    case "invalid":
      return new BigqueryError("bad_query", message);
    case "backendError":
    case "internalError":
      return new BigqueryError("unavailable", message);
  }
  if (status === 401) return new BigqueryError("key_rejected", message);
  if (status === 403) {
    if (/has not been used|is disabled|SERVICE_DISABLED/i.test(message + (error?.status ?? ""))) return new BigqueryError("not_enabled", message);
    return new BigqueryError("access_denied", message);
  }
  if (status === 404) return new BigqueryError("not_found", message);
  if (status === 429) return new BigqueryError("rate_limited", message);
  if (status === 400) return new BigqueryError("bad_query", message);
  if (status >= 500) return new BigqueryError("unavailable", message);
  return new BigqueryError("unexpected", message);
}

/** Classifies a network failure. */
export function toBigqueryError(error: unknown): BigqueryError {
  if (error instanceof BigqueryError) return error;
  const err = error as { name?: unknown; message?: unknown };
  const message = typeof err?.message === "string" ? err.message : String(error);
  if (err?.name === "TimeoutError" || err?.name === "AbortError") return new BigqueryError("timeout", message);
  return new BigqueryError("unavailable", message);
}

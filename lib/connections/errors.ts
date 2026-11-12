import type { z } from "zod";

import type { ConnectionStatus } from "@/lib/db/schema";
import {
  SecretProviderMismatchError,
  SecretStorageNotConfiguredError,
  SecretStorageUnavailableError,
  SecretUnreadableError,
} from "@/lib/secrets";
import { ALL_SOURCES } from "@/lib/sources";
import type { SourceError } from "@/lib/sources/types";

/**
 * Errors from the connection service. Source-specific failures (a bad API key,
 * an unknown database) come from each source's own `toError`; this file only
 * knows the shared ones.
 */

/** A form field name: shared ("name") or a source's own ("apiKey", "host", …). */
export type ConnectionField = string;

export type ConnectionError = SourceError & {
  /** For `in_use`: the apps that use the connection. */
  apps?: { id: string; name: string }[];
};

export type Result<T = undefined> = { ok: true; data: T } | { ok: false; error: ConnectionError };

export const ok = <T>(data: T): Result<T> => ({ ok: true, data });
export const fail = (error: ConnectionError): Result<never> => ({ ok: false, error });

export const notFound = (): Result<never> =>
  fail({ code: "not_found", message: "This connection doesn't exist or was deleted." });

/** `fieldFor` maps a schema path to a form field when they differ (a credential). */
export function fromValidation(
  error: z.ZodError,
  fieldFor: (path: PropertyKey | undefined) => string | undefined = (path) =>
    typeof path === "string" ? path : undefined,
): Result<never> {
  const issue = error.issues[0];
  return fail({
    code: "validation",
    message: issue?.message ?? "Check the form and try again.",
    field: fieldFor(issue?.path[0]),
  });
}

/** Turns a failed check into a user-facing error and the status to record, or null if unknown. */
export function fromCheckError(error: unknown): { error: ConnectionError; status: Exclude<ConnectionStatus, "ok"> } | null {
  for (const source of ALL_SOURCES) {
    const known = source.toError(error);
    if (known) return known;
  }
  if (error instanceof SecretProviderMismatchError || error instanceof SecretUnreadableError) {
    return {
      status: "invalid",
      error: {
        code: "key_reentry_required",
        message: "This credential was stored by a different setup and can't be used here. Enter it again.",
      },
    };
  }
  if (error instanceof SecretStorageNotConfiguredError) {
    return {
      status: "unavailable",
      error: {
        code: "secret_storage_unavailable",
        message: "Secret storage isn't set up on this server yet, so credentials can't be saved or used.",
      },
    };
  }
  if (error instanceof SecretStorageUnavailableError) {
    return {
      status: "unavailable",
      error: {
        code: "secret_storage_unavailable",
        message: "Secret storage is unavailable right now, so credentials can't be saved or used. Try again shortly.",
      },
    };
  }
  return null;
}

export const internalError = (): Result<never> =>
  fail({ code: "internal", message: "Something went wrong. Try again." });

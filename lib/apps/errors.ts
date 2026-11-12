import type { z } from "zod";

export type AppErrorCode =
  | "validation"
  | "not_found"
  | "thread_conflict"
  | "internal";

export type AppError = { code: AppErrorCode; message: string; field?: string };

export type AppResult<T = undefined> = { ok: true; data: T } | { ok: false; error: AppError };

export const ok = <T>(data: T): AppResult<T> => ({ ok: true, data });
export const fail = (error: AppError): AppResult<never> => ({ ok: false, error });

export const notFound = (): AppResult<never> =>
  fail({ code: "not_found", message: "This app doesn't exist or was deleted." });

export const internalError = (): AppResult<never> =>
  fail({ code: "internal", message: "Something went wrong. Try again." });

export function fromValidation(error: z.ZodError): AppResult<never> {
  const issue = error.issues[0];
  const field = issue?.path[0];
  return fail({
    code: "validation",
    message: issue?.message ?? "Check the form and try again.",
    field: typeof field === "string" ? field : undefined,
  });
}

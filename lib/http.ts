import "server-only";

import { requireUser, UnauthorizedError, type CurrentUser } from "@/lib/auth/user";
import { config } from "@/config";
import type { AppErrorCode, AppResult } from "@/lib/apps/errors";
import { withLogContext } from "@/lib/log";

const MAX_JSON_BYTES = 16 * 1024;

const STATUS: Record<AppErrorCode, number> = {
  validation: 400,
  not_found: 404,
  thread_conflict: 409,
  internal: 500,
};

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Wraps a Route Handler: authenticates the user, tags the request's logs with
 * them, and for anything but GET refuses cross-site requests. Unlike Server Actions, Route Handlers get no
 * built-in Origin check, and the gateway attaches the user to any request
 * that carries their session.
 */
export function route<Ctx>(
  handler: (request: Request, user: CurrentUser, ctx: Ctx) => Promise<Response>,
) {
  return async (request: Request, ctx: Ctx): Promise<Response> => {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") assertSameOrigin(request);
      const user = await requireUser();
      return await withLogContext({ user: user.id }, () => handler(request, user, ctx));
    } catch (error) {
      if (error instanceof UnauthorizedError) return Response.json({ error: "Unauthorized" }, { status: 401 });
      if (error instanceof HttpError) return Response.json({ error: error.message }, { status: error.status });
      throw error;
    }
  };
}

/** Reads a small JSON body; only `application/json` is accepted. */
export async function readJson(request: Request, { maxBytes = MAX_JSON_BYTES } = {}): Promise<unknown> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "Expected application/json");
  }
  const text = await request.text();
  if (Buffer.byteLength(text) > maxBytes) throw new HttpError(413, "Request body too large");
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}

/** Turns a service result into a response: data as JSON, or the error with its status. */
export function respond<T>(result: AppResult<T>, { emptyOk = false } = {}): Response {
  if (result.ok) {
    return emptyOk ? new Response(null, { status: 204 }) : Response.json(result.data);
  }
  return Response.json({ error: result.error }, { status: STATUS[result.error.code] });
}

function assertSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) throw new HttpError(403, "Missing Origin");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new HttpError(403, "Invalid Origin");
  }
  // Behind the gateway the forwarded host may be the gateway's own, not the one in the browser.
  if (originHost !== config().auth.publicHost && originHost !== host) {
    throw new HttpError(403, "Cross-site request refused");
  }
}

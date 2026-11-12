import "server-only";

import { headers } from "next/headers";
import { connection } from "next/server";
import { cache } from "react";

import { getAuthProvider, type AuthUser } from ".";

export type CurrentUser = AuthUser;

export class UnauthorizedError extends Error {
  constructor() {
    super("Unauthorized");
    this.name = "UnauthorizedError";
  }
}

/**
 * The signed-in user, as the configured auth provider sees it. Call it in every page, Server
 * Action and Route Handler that touches user data: `proxy.ts` already rejects
 * unauthenticated requests, and this re-checks close to the data.
 *
 * It reads request headers, so with Cache Components it must run inside a
 * `<Suspense>` boundary when called from a page or layout.
 */
export const requireUser = cache(async (): Promise<CurrentUser> => {
  // Checking a token's expiry reads the clock, which only happens at request time.
  await connection();
  const result = await getAuthProvider().authenticate(await headers());
  if (!result.ok) throw new UnauthorizedError();
  return result.user;
});

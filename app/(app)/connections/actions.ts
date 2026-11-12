"use server";

import { refresh } from "next/cache";

import { track } from "@/lib/analytics";
import { requireUser } from "@/lib/auth/user";
import { getConnectionService } from "@/lib/connections";
import type { Result } from "@/lib/connections/errors";
import { withLogContext } from "@/lib/log";

/*
 * Each action is a public POST endpoint: it authenticates itself, and the
 * service validates the input and scopes everything to the signed-in user.
 * Inputs are typed `unknown` on purpose: nothing from the client is trusted.
 */

async function run<T>(
  call: (userId: string) => Promise<Result<T>>,
  { refreshOnFailure = false } = {},
): Promise<Result<T>> {
  const user = await requireUser();
  const result = await withLogContext({ user: user.id }, () => call(user.id));
  if (result.ok || refreshOnFailure) refresh();
  return result;
}

export async function createConnectionAction(input: unknown) {
  return run(async (userId) => {
    const result = await getConnectionService().create(userId, input);
    const type = (input as { type?: unknown } | null)?.type;
    trackConnection(userId, typeof type === "string" ? type : "unknown", false, result);
    return result;
  });
}

/** Refreshes on failure too: the check records the new status either way. */
export async function retestConnectionAction(input: unknown) {
  return run((userId) => getConnectionService().retest(userId, input), {
    refreshOnFailure: true,
  });
}

/** A new API key (PostHog) or password (Postgres) for a saved connection. */
export async function replaceCredentialAction(input: unknown) {
  return run((userId) => getConnectionService().replaceCredential(userId, input));
}

export async function renameConnectionAction(input: unknown) {
  return run((userId) => getConnectionService().rename(userId, input));
}

export async function deleteConnectionAction(input: unknown) {
  return run((userId) => getConnectionService().remove(userId, input));
}

/** Installs a demo dataset: a connection of the user's that points at it. */
export async function installDemoAction(input: unknown) {
  return run(async (userId) => {
    const result = await getConnectionService().installDemo(userId, input);
    trackConnection(userId, "postgres", true, result);
    return result;
  });
}

/** Uninstalls a demo dataset, unless an app uses it. */
export async function uninstallDemoAction(input: unknown) {
  return run((userId) => getConnectionService().uninstallDemo(userId, input));
}

function trackConnection(userId: string, sourceType: string, isDemo: boolean, result: Result<unknown>) {
  if (result.ok) track(userId, "connection_created", { source_type: sourceType, is_demo: isDemo });
  else track(userId, "connection_failed", { source_type: sourceType, is_demo: isDemo, error_code: result.error.code });
}

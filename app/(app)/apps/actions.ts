"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { config } from "@/config";
import { DISCOVERY_PROMPT } from "@/components/onboarding/discovery-prompt";
import { track } from "@/lib/analytics";
import { requireUser } from "@/lib/auth/user";
import { getAppService } from "@/lib/apps";
import { getConnectionService } from "@/lib/connections";
import { fail, type AppResult } from "@/lib/apps/errors";
import { deleteAppDashboardsInCloud, deleteDashboard, getDashboardService } from "@/lib/dashboards";

/*
 * Public POST endpoints like every Server Action: each authenticates itself,
 * and the service validates input and scopes everything to the user.
 *
 * Successful changes revalidate the shared layout, not just the page: the
 * sidebar's "Recent" list shows app names too.
 */

const revalidateShell = () => revalidatePath("/", "layout");

/** Creates the app and opens it. Returns only on failure. */
export async function createAppAction(input: unknown): Promise<AppResult<never>> {
  const user = await requireUser();
  const result = await getAppService().create(user.id, input);
  if (!result.ok) return result;
  const { prompt, connectionIds } = input as { prompt: string; connectionIds: string[] };
  const connections = (await getConnectionService().list(user.id)).filter((connection) => connectionIds.includes(connection.id));
  track(user.id, "app_created", {
    app_id: result.data.id,
    connection_count: connections.length,
    source_types: [...new Set(connections.map((connection) => connection.type))],
    uses_demo_data: connections.some((connection) => connection.demo),
    prompt_kind:
      prompt.trim() === DISCOVERY_PROMPT
        ? "discovery"
        : config().demoData.datasets.some((dataset) => dataset.prompts.includes(prompt.trim()))
          ? "suggested"
          : "custom",
  });
  revalidateShell();
  redirect(`/apps/${result.data.id}`);
}

export async function renameAppAction(input: unknown): Promise<AppResult> {
  const user = await requireUser();
  const result = await getAppService().rename(user.id, input);
  if (result.ok) revalidateShell();
  return result;
}

/** Adds one of the user's connections to an app. */
export async function addAppConnectionAction(input: unknown): Promise<AppResult> {
  const user = await requireUser();
  const result = await getAppService().addConnection(user.id, input);
  if (result.ok) revalidateShell();
  return result;
}

/** Deletes the app and goes back to the list. Returns only on failure. */
export async function deleteAppAction(input: unknown): Promise<AppResult<never>> {
  const user = await requireUser();
  // Its dashboards live in OpenUI Cloud; delete them first so none are left behind.
  const appId = (input as { id?: unknown } | null)?.id;
  if (typeof appId === "string" && z.uuid().safeParse(appId).success) {
    if (!(await deleteAppDashboardsInCloud(user.id, appId))) {
      return fail({ code: "internal", message: "OpenUI Cloud couldn't delete the app's dashboards. Try again." });
    }
  }
  const result = await getAppService().remove(user.id, input);
  if (!result.ok) return result;
  revalidateShell();
  redirect("/apps");
}

/**
 * The prompt the app was created with, taken once so it's sent exactly once:
 * the Build chat sends it as its first message, naming the data sources the
 * user picked.
 */
export async function takePendingPromptAction(appId: string): Promise<string | null> {
  const user = await requireUser();
  const pending = await getAppService().takePendingPrompt(user.id, appId);
  if (!pending) return null;
  const connections = (await getConnectionService().list(user.id)).filter((connection) =>
    pending.connectionIds.includes(connection.id),
  );
  if (!connections.length) return pending.prompt;
  const names = connections.map((connection) => `${connection.name} (${connection.id})`).join(", ");
  return `${pending.prompt}\n\nUse these data sources: ${names}`;
}

const updateDashboardSchema = z
  .object({
    appId: z.uuid(),
    dashboardId: z.uuid(),
    title: z.string().trim().min(1, "Enter a name.").max(120, "Keep the name under 120 characters.").optional(),
    // Empty clears it.
    description: z.string().trim().max(300, "Keep the description under 300 characters.").optional(),
  })
  .strict();

/** Renames one of an app's dashboards, or changes its description. */
export async function updateDashboardAction(input: unknown): Promise<AppResult> {
  const user = await requireUser();
  const parsed = updateDashboardSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path[0];
    return field === "title" || field === "description"
      ? fail({ code: "validation", message: issue!.message, field })
      : fail({ code: "not_found", message: "This dashboard doesn't exist or was deleted." });
  }
  const { appId, dashboardId, title, description } = parsed.data;
  const changes = {
    ...(title !== undefined ? { title } : {}),
    ...(description !== undefined ? { description: description || null } : {}),
  };
  if (!(await getDashboardService().update(user.id, appId, dashboardId, changes))) {
    return fail({ code: "not_found", message: "This dashboard doesn't exist or was deleted." });
  }
  revalidateShell();
  return { ok: true, data: undefined };
}

const deleteDashboardSchema = z.object({ appId: z.uuid(), dashboardId: z.uuid() }).strict();

/** Deletes one dashboard of an app, in OpenUI Cloud and in the sidebar. */
export async function deleteDashboardAction(input: unknown): Promise<AppResult> {
  const user = await requireUser();
  const parsed = deleteDashboardSchema.safeParse(input);
  if (!parsed.success) return fail({ code: "not_found", message: "This dashboard doesn't exist or was deleted." });
  const { appId, dashboardId } = parsed.data;

  const dashboard = (await getDashboardService().list(user.id, appId)).find((row) => row.id === dashboardId);
  if (!dashboard) return fail({ code: "not_found", message: "This dashboard doesn't exist or was deleted." });

  const result = await deleteDashboard(user.id, appId, dashboard.artifactId);
  if (!result.ok) {
    return result.reason === "not_found"
      ? fail({ code: "not_found", message: "This dashboard doesn't exist or was deleted." })
      : fail({ code: "internal", message: "OpenUI Cloud couldn't delete the dashboard. Try again." });
  }
  revalidateShell();
  return { ok: true, data: undefined };
}

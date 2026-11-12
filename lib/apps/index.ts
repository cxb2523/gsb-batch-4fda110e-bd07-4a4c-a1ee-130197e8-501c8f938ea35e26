import "server-only";

import { cache } from "react";

import { requireUser } from "@/lib/auth/user";
import { getDb } from "@/lib/db";

import { createAppService, type AppService } from "./service";
import { createThreadService, type ThreadService } from "./threads";

export type { AppDetail, AppSummary, AppTreeNode } from "./service";
export type { AppThread } from "./threads";

let appService: AppService | undefined;
let threadService: ThreadService | undefined;

export function getAppService(): AppService {
  appService ??= createAppService({ db: getDb() });
  return appService;
}

export function getThreadService(): ThreadService {
  threadService ??= createThreadService({ db: getDb() });
  return threadService;
}

/**
 * The signed-in user's app, or null. Cached per request, so the app layout
 * and the dashboard page share one lookup.
 */
export const getCurrentUserApp = cache(async (appId: string) => {
  const user = await requireUser();
  return getAppService().get(user.id, appId);
});

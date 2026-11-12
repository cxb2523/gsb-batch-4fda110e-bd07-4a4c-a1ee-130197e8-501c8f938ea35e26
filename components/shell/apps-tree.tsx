import { getAppService } from "@/lib/apps";
import { requireUser } from "@/lib/auth/user";

import { AppsTreeNav } from "./apps-tree-nav";

/**
 * Every app under "Apps", newest first, each with its dashboards nested
 * below. The sidebar gives this list the leftover height and scrolls it.
 * Reads the request, so it renders behind Suspense.
 */
export async function AppsTree() {
  const user = await requireUser();
  const apps = await getAppService().tree(user.id);

  if (!apps.length) {
    return <p className="py-1.5 pl-7 text-xs text-muted-foreground">No apps yet</p>;
  }
  return <AppsTreeNav apps={apps} />;
}

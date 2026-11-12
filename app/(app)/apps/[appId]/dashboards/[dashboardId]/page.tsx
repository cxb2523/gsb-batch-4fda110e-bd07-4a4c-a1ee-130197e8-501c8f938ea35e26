import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";

import { LiveDashboard } from "@/components/apps/live-dashboard";
import { getCurrentUserApp } from "@/lib/apps";
import { appPath } from "@/lib/apps/paths";

type Params = Promise<{ appId: string; dashboardId: string }>;

/** The tab shows the dashboard's title. */
export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { appId, dashboardId } = await params;
  const app = await getCurrentUserApp(appId);
  const dashboard = app?.dashboards.find((candidate) => candidate.id === dashboardId);
  return dashboard ? { title: dashboard.title } : {};
}

/**
 * One dashboard of an app. Only dashboards of the user's own app resolve. A
 * dashboard that's gone (deleted, by the user or the agent, or a stale link)
 * leads to the app's home rather than a 404 that would hide the Build panel.
 */
export default function DashboardPage({ params }: { params: Params }) {
  return (
    <Suspense fallback={null}>
      <Dashboard params={params} />
    </Suspense>
  );
}

async function Dashboard({ params }: { params: Params }) {
  const { appId, dashboardId } = await params;
  const app = await getCurrentUserApp(appId);
  if (!app) notFound();
  const dashboard = app.dashboards.find((candidate) => candidate.id === dashboardId);
  if (!dashboard) redirect(appPath(app.id));

  return <LiveDashboard key={dashboard.id} appId={app.id} dashboard={dashboard} />;
}

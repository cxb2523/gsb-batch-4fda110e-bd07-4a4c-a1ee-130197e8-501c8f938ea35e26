"use client";

import { OpenUICloudProvider } from "@openuidev/react-ui/cloud";
import { ChevronLeftIcon, PanelRightCloseIcon, PanelRightOpenIcon, SparklesIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, use, useCallback, useMemo, useState } from "react";

import { renameAppAction } from "@/app/(app)/apps/actions";
import { InlineRename } from "@/components/inline-rename";
import { Button } from "@/components/ui/button";
import { appPath, dashboardPath, parseAppPath } from "@/lib/apps/paths";
import { cn } from "@/lib/utils";

type Dashboard = { id: string; title: string };

const BuildPanelContext = createContext<{ open: boolean; setOpen: (open: boolean) => void } | null>(null);

type DashboardResponses = {
  responses: Readonly<Record<string, string>>;
  publish: (artifactId: string, response: string) => void;
};

const DashboardResponsesContext = createContext<DashboardResponses | null>(null);

function useDashboardResponses() {
  const context = use(DashboardResponsesContext);
  if (!context) throw new Error("Dashboard responses are only available inside AppWorkspace");
  return context;
}

/**
 * The latest create/edit response OpenUI Cloud gave for a dashboard in this
 * session. Passed to its renderer as `response`, it carries the new version,
 * so an open dashboard follows an edit as it's built.
 */
export function useDashboardResponse(artifactId: string): string | undefined {
  return useDashboardResponses().responses[artifactId];
}

/** For the Build chat: hands a create/edit response to the dashboard it's for. */
export function usePublishDashboardResponse() {
  return useDashboardResponses().publish;
}

const RenameAppContext = createContext<(() => void) | null>(null);

/** Starts renaming the app in place, in the header: for the app's menu. */
export function useRenameApp() {
  const context = use(RenameAppContext);
  if (!context) throw new Error("useRenameApp must be used inside AppWorkspace");
  return context;
}

/** The Build panel's open state, for content inside the workspace. */
export function useBuildPanel() {
  const context = use(BuildPanelContext);
  if (!context) throw new Error("useBuildPanel must be used inside AppWorkspace");
  return context;
}

/**
 * The app's name in the header. Clicking it (or Rename in the app's menu)
 * edits it in place; the new name shows straight away.
 */
function AppTitle({
  appId,
  name,
  renaming,
  onRenamingChange,
}: {
  appId: string;
  name: string;
  renaming: boolean;
  onRenamingChange: (renaming: boolean) => void;
}) {
  // A saved name shows until the server's copy catches up.
  const [saved, setSaved] = useState<{ from: string; to: string } | null>(null);
  const shown = saved && saved.from === name ? saved.to : name;

  if (renaming) {
    return (
      <h1 className="min-w-0 flex-1 sm:max-w-sm">
        <InlineRename
          value={shown}
          label="App name"
          maxLength={80}
          onSave={(next) => renameAppAction({ id: appId, name: next })}
          onDone={(next) => {
            setSaved(next === name ? null : { from: name, to: next });
            onRenamingChange(false);
          }}
          className="h-7 w-full text-sm font-semibold"
        />
      </h1>
    );
  }
  return (
    <h1 className="min-w-0">
      <button
        type="button"
        onClick={() => onRenamingChange(true)}
        title="Rename"
        className="block max-w-full cursor-text truncate rounded-md px-1.5 py-1 text-left text-sm font-semibold transition-colors hover:bg-neutral-100 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        {shown}
      </button>
    </h1>
  );
}

/**
 * An app's workspace, shared by all its dashboards: the header, the selected
 * dashboard (the page, as children), and the Build panel on the right, where
 * you ask OpenDashboards to build. The app's dashboards are listed in the main sidebar.
 *
 * It lives in the app's layout, so moving between dashboards keeps the Build
 * panel as it was. It starts open when there's nothing to look at yet, and
 * collapsed once there is.
 */
export function AppWorkspace({
  appId,
  name,
  badges,
  menu,
  builder,
  dashboards,
  children,
}: {
  appId: string;
  name: string;
  badges: React.ReactNode;
  menu: React.ReactNode;
  builder: React.ReactNode;
  dashboards: Dashboard[];
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(dashboards.length === 0);
  const [responses, setResponses] = useState<Record<string, string>>({});
  const publish = useCallback(
    (artifactId: string, response: string) =>
      setResponses((current) => (current[artifactId] === response ? current : { ...current, [artifactId]: response })),
    [],
  );
  const dashboardResponses = useMemo(() => ({ responses, publish }), [responses, publish]);
  const [renaming, setRenaming] = useState(false);
  const startRename = useCallback(() => setRenaming(true), []);

  return (
    // One Cloud connection for the workspace: the chat and the dashboard
    // share its token and artifact cache.
    <OpenUICloudProvider token="/api/frontend-token">
    <DashboardResponsesContext value={dashboardResponses}>
    <BuildPanelContext value={{ open, setOpen }}>
    <RenameAppContext value={startRename}>
      <div className="flex h-full flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-2">
          <Link
            href="/apps"
            aria-label="All apps"
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-neutral-100 hover:text-foreground"
          >
            <ChevronLeftIcon className="size-4" aria-hidden />
          </Link>
          <AppTitle appId={appId} name={name} renaming={renaming} onRenamingChange={setRenaming} />
          <div className="ml-1 hidden min-w-0 flex-1 items-center gap-1.5 overflow-hidden sm:flex">{badges}</div>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <Button
              variant={open ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setOpen(!open)}
              aria-expanded={open}
              aria-controls="app-builder"
            >
              {open ? <PanelRightCloseIcon aria-hidden /> : <PanelRightOpenIcon aria-hidden />}
              Build
            </Button>
            {menu}
          </div>
        </header>

        <div className="relative flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            <MobileDashboardTabs appId={appId} dashboards={dashboards} />
            {children}
          </div>

          <aside
            id="app-builder"
            aria-label="Build"
            className={cn(
              "min-h-0 flex-col border-l bg-background",
              // Beside the dashboard on wide screens, over it below 1024px.
              "absolute inset-y-0 right-0 z-10 w-full shadow-xl sm:w-[380px] lg:static lg:shadow-none",
              open ? "flex" : "hidden",
            )}
          >
            <div className="flex h-11 shrink-0 items-center justify-between border-b pr-1.5 pl-4">
              <span className="flex items-center gap-2 text-sm font-medium">
                <SparklesIcon className="size-4 text-muted-foreground" aria-hidden />
                Build
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setOpen(false)}
                aria-label="Collapse the Build panel"
              >
                <PanelRightCloseIcon aria-hidden />
              </Button>
            </div>
            {builder}
          </aside>
        </div>
      </div>
    </RenameAppContext>
    </BuildPanelContext>
    </DashboardResponsesContext>
    </OpenUICloudProvider>
  );
}

/** Below md there's no sidebar, so the app's dashboards show as a strip of tabs. */
function MobileDashboardTabs({ appId, dashboards }: { appId: string; dashboards: Dashboard[] }) {
  const { dashboardId } = parseAppPath(usePathname());
  if (!dashboards.length) return null;
  const activeId = dashboardId ?? dashboards[0].id;

  return (
    <nav
      aria-label="Dashboards"
      className="flex shrink-0 gap-1 overflow-x-auto border-b px-3 py-2 [scrollbar-width:none] md:hidden"
    >
      {dashboards.map((dashboard, index) => (
        <Link
          key={dashboard.id}
          href={index === 0 ? appPath(appId) : dashboardPath(appId, dashboard.id)}
          aria-current={dashboard.id === activeId ? "page" : undefined}
          className="shrink-0 rounded-md px-3 py-1 text-sm text-muted-foreground aria-[current=page]:bg-neutral-100 aria-[current=page]:font-medium aria-[current=page]:text-foreground"
        >
          {dashboard.title}
        </Link>
      ))}
    </nav>
  );
}

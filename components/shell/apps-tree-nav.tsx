"use client";

import { ChevronRightIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense, useState } from "react";

import { renameAppAction, updateDashboardAction } from "@/app/(app)/apps/actions";
import { InlineRename } from "@/components/inline-rename";
import type { AppTreeNode } from "@/lib/apps";
import { appPath, dashboardPath, parseAppPath } from "@/lib/apps/paths";
import { cn } from "@/lib/utils";

import { DashboardMenu } from "./dashboard-menu";

/**
 * The sidebar's app tree. The open app is expanded; others expand with their
 * chevron. The highlight reads the URL, so the tree prerenders without it and
 * the highlight streams in.
 */
export function AppsTreeNav({ apps }: { apps: AppTreeNode[] }) {
  return (
    <Suspense fallback={<Tree apps={apps} pathname={null} />}>
      <ActiveTree apps={apps} />
    </Suspense>
  );
}

function ActiveTree({ apps }: { apps: AppTreeNode[] }) {
  return <Tree apps={apps} pathname={usePathname()} />;
}

function Tree({ apps, pathname }: { apps: AppTreeNode[]; pathname: string | null }) {
  const { appId: activeAppId, dashboardId } = parseAppPath(pathname);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(activeAppId ? [activeAppId] : []));

  // Opening an app (from a card, a link, or this tree) expands it.
  const [lastActive, setLastActive] = useState(activeAppId);
  if (activeAppId !== lastActive) {
    setLastActive(activeAppId);
    if (activeAppId && !expanded.has(activeAppId)) setExpanded(new Set(expanded).add(activeAppId));
  }

  // Renaming in place: which row is being edited, and names saved but not yet
  // back from the server (keyed by id, with the name they replace).
  const [editing, setEditing] = useState<string | null>(null);
  const [saved, setSaved] = useState<Record<string, { from: string; to: string }>>({});
  const shown = (id: string, name: string) => (saved[id]?.from === name ? saved[id].to : name);
  const done = (id: string, name: string) => (next: string) => {
    setSaved((current) => ({ ...current, [id]: { from: name, to: next } }));
    setEditing(null);
  };

  function toggle(id: string) {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpanded(next);
  }

  return (
    <ul aria-label="Your apps" className="flex flex-col gap-0.5">
      {apps.map((app) => {
        const isActiveApp = app.id === activeAppId;
        const isOpen = expanded.has(app.id) && app.dashboards.length > 0;
        // On the app's own page, its first dashboard is the one showing.
        const activeDashboardId = isActiveApp ? (dashboardId ?? app.dashboards[0]?.id) : undefined;

        return (
          <li key={app.id}>
            {/*
              The chevron sits in the nav's icon column; names start right
              after it, so as much of the width as possible goes to them.
            */}
            <div className="group relative">
              {editing === app.id ? (
                <div className="flex h-8 items-center pr-1 pl-[1.375rem]">
                  <InlineRename
                    value={shown(app.id, app.name)}
                    label="App name"
                    maxLength={80}
                    onSave={(name) => renameAppAction({ id: app.id, name })}
                    onDone={done(app.id, app.name)}
                    className="h-7 w-full text-sm"
                  />
                </div>
              ) : (
              <Link
                href={appPath(app.id)}
                onDoubleClick={(event) => {
                  event.preventDefault();
                  setEditing(app.id);
                }}
                aria-current={isActiveApp && !app.dashboards.length ? "page" : undefined}
                title={app.name}
                className={cn(
                  "flex h-8 items-center rounded-lg pr-2 pl-7 text-sm text-foreground/70 transition-colors",
                  "hover:bg-black/[0.04] hover:text-foreground",
                  "focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
                  isActiveApp && "font-medium text-foreground",
                  isActiveApp && !app.dashboards.length && "bg-black/[0.06]",
                )}
              >
                <span className="truncate">{shown(app.id, app.name)}</span>
              </Link>
              )}
              {app.dashboards.length > 0 && (
                <button
                  type="button"
                  onClick={() => toggle(app.id)}
                  aria-expanded={isOpen}
                  aria-label={`${isOpen ? "Collapse" : "Expand"} ${app.name}`}
                  className={cn(
                    "absolute top-1.5 left-1.5 flex size-5 items-center justify-center rounded-md text-muted-foreground transition-colors",
                    "hover:bg-black/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
                  )}
                >
                  <ChevronRightIcon className={cn("size-3.5 transition-transform", isOpen && "rotate-90")} aria-hidden />
                </button>
              )}
            </div>

            {isOpen && (
              <ul
                aria-label={`${app.name} dashboards`}
                // A guide line down the chevron's column ties the dashboards to their app.
                className="relative mt-0.5 mb-1 flex flex-col gap-0.5 before:absolute before:inset-y-0 before:left-4 before:w-px before:bg-border"
              >
                {app.dashboards.map((dashboard) => {
                  const active = dashboard.id === activeDashboardId;
                  return (
                    <li key={dashboard.id} className="group/dashboard relative">
                      {editing === dashboard.id ? (
                        <div className="flex h-8 items-center pr-1 pl-[1.375rem]">
                          <InlineRename
                            value={shown(dashboard.id, dashboard.title)}
                            label="Dashboard name"
                            maxLength={120}
                            onSave={(title) => updateDashboardAction({ appId: app.id, dashboardId: dashboard.id, title })}
                            onDone={done(dashboard.id, dashboard.title)}
                            className="h-7 w-full text-[0.8125rem]"
                          />
                        </div>
                      ) : (
                      <>
                      <Link
                        onDoubleClick={(event) => {
                          event.preventDefault();
                          setEditing(dashboard.id);
                        }}
                        href={dashboardPath(app.id, dashboard.id)}
                        aria-current={active ? "page" : undefined}
                        title={dashboard.title}
                        className={cn(
                          "flex h-8 items-center rounded-lg pr-8 pl-7 text-[0.8125rem] text-foreground/65 transition-colors",
                          "hover:bg-black/[0.04] hover:text-foreground",
                          "focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
                          active && "bg-black/[0.06] font-medium text-foreground",
                        )}
                      >
                        <span className="truncate">{shown(dashboard.id, dashboard.title)}</span>
                      </Link>
                      <DashboardMenu
                        appId={app.id}
                        dashboard={{ id: dashboard.id, title: shown(dashboard.id, dashboard.title) }}
                        onRename={() => setEditing(dashboard.id)}
                        className="absolute top-1.5 right-1.5 opacity-0 group-hover/dashboard:opacity-100 focus-visible:opacity-100"
                      />
                      </>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}

"use client";

import { PanelRightOpenIcon, SparklesIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

import { useBuildPanel } from "./app-workspace";

/** An app with no dashboards yet. */
export function NoDashboards({ hasPendingPrompt }: { hasPendingPrompt: boolean }) {
  const buildPanel = useBuildPanel();
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 bg-neutral-50/60 p-8 text-center">
      <div className="mb-2 flex size-11 items-center justify-center rounded-xl border bg-background">
        <SparklesIcon className="size-5 text-muted-foreground" aria-hidden />
      </div>
      <p className="text-sm font-semibold">Build your first dashboard</p>
      <p className="max-w-sm text-sm text-muted-foreground">
        {hasPendingPrompt
          ? "OpenDashboards is working on your prompt in the Build panel. The dashboards it builds show up here, and you can keep refining them."
          : "Describe what you want to see in the Build panel. Dashboards show up here, and you can keep refining them by asking."}
      </p>
      {!buildPanel.open && (
        <Button variant="outline" size="sm" className="mt-3" onClick={() => buildPanel.setOpen(true)}>
          <PanelRightOpenIcon aria-hidden />
          Open Build panel
        </Button>
      )}
    </div>
  );
}

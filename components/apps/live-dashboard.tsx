"use client";

import { LiveArtifactRenderer, useArtifactRenderer } from "@openuidev/react-ui/cloud";
import { library } from "@openuidev/dashboard-library";
import { LoaderCircleIcon } from "lucide-react";
import { useState } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/utils";

import { useDashboardResponse } from "./app-workspace";
import { DashboardTitle } from "./dashboard-title";

const interpreter = { url: "/api/interpreter" };

/**
 * A live dashboard from OpenUI Cloud, drawn with @openuidev/dashboard-library, under
 * its title and description (OpenDashboards' own, not part of the program). Its data
 * loads fresh through our interpreter every time it opens. When the Build
 * chat creates or edits it, the renderer gets Cloud's response too, and
 * follows the new version as it's built.
 */
export function LiveDashboard({
  appId,
  dashboard,
}: {
  appId: string;
  dashboard: { id: string; artifactId: string; title: string; description: string | null };
}) {
  const response = useDashboardResponse(dashboard.artifactId);
  // Where the loading capsule draws: over the bottom of the dashboard, outside the part that scrolls.
  const [overlay, setOverlay] = useState<HTMLDivElement | null>(null);
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto bg-white">
        <DashboardTitle appId={appId} dashboard={dashboard} />
        <LiveArtifactRenderer
          id={dashboard.artifactId}
          response={response}
          preview={false}
          library={library}
          interpreter={interpreter}
          onError={(errors) => {
            if (errors.length) console.error("[dashboard]", JSON.stringify(errors));
          }}
        >
          <LiveArtifactRenderer.Chrome>
            <LiveArtifactRenderer.Content>
              {/* In place of the renderer's top-right pill, which sat on the filter bar. */}
              <LoadingCapsule container={overlay} />
              <LiveArtifactRenderer.Error />
            </LiveArtifactRenderer.Content>
          </LiveArtifactRenderer.Chrome>
        </LiveArtifactRenderer>
      </div>
      <div ref={setOverlay} className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center" />
    </div>
  );
}

/**
 * A small capsule at the bottom centre while the dashboard generates or its data loads. It
 * waits a moment before showing, so a quick reload doesn't flash it, and fades out when done.
 */
function LoadingCapsule({ container }: { container: HTMLElement | null }) {
  const { isLoading, isStreaming, error } = useArtifactRenderer();
  if (!container) return null;
  const shown = isLoading && !error;
  return createPortal(
    <div
      role="status"
      aria-hidden={!shown}
      className={cn(
        "flex items-center gap-1.5 rounded-full border bg-background/95 px-3 py-1.5 text-xs text-muted-foreground shadow-sm backdrop-blur transition-[opacity,translate] duration-200",
        shown ? "translate-y-0 opacity-100 delay-300" : "translate-y-2 opacity-0",
      )}
    >
      <LoaderCircleIcon className="size-3.5 animate-spin" aria-hidden />
      {isStreaming ? "Building your dashboard…" : "Loading data…"}
    </div>,
    container,
  );
}

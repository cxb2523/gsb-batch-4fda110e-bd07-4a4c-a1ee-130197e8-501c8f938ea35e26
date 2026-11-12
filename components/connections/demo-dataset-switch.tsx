"use client";

import { Loader2Icon } from "lucide-react";
import { useTransition } from "react";
import { toast } from "sonner";

import { installDemoAction, uninstallDemoAction } from "@/app/(app)/connections/actions";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * Installs or uninstalls a demo dataset. Locked while any app uses it, since
 * those apps' dashboards would break; a tooltip says why. The row itself
 * lists the apps (UsedBy).
 */
export function DemoDatasetSwitch({
  dataset,
  name,
  installed,
  apps,
}: {
  dataset: string;
  name: string;
  installed: boolean;
  apps: { id: string; name: string }[];
}) {
  const [pending, startTransition] = useTransition();
  const locked = installed && apps.length > 0;

  function toggle() {
    startTransition(async () => {
      const result = installed
        ? await uninstallDemoAction({ dataset })
        : await installDemoAction({ dataset });
      if (result.ok) toast.success(installed ? `${name} uninstalled` : `${name} installed`);
      else toast.error(result.error.message);
    });
  }

  const lockedReason =
    apps.length === 1
      ? `${apps[0].name} uses this dataset. Delete that app to uninstall it.`
      : `${apps.length} apps use this dataset. Delete them to uninstall it.`;

  const toggleSwitch = (
    <button
      type="button"
      role="switch"
      aria-checked={installed}
      aria-label={`${installed ? "Uninstall" : "Install"} ${name}`}
      disabled={pending || locked}
      onClick={toggle}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors",
        "focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
        installed ? "bg-neutral-900" : "bg-neutral-200",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "inline-block size-4 rounded-full bg-white shadow-sm transition-transform",
          installed ? "translate-x-[1.125rem]" : "translate-x-0.5",
        )}
      />
    </button>
  );

  return (
    <div className="flex shrink-0 items-center gap-2.5">
      {pending && <Loader2Icon className="size-3.5 animate-spin text-muted-foreground" aria-hidden />}
      {locked ? (
        // A disabled button gets no pointer events: the tooltip hangs off a wrapper.
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex" tabIndex={0}>
              {toggleSwitch}
            </span>
          </TooltipTrigger>
          <TooltipContent side="left">{lockedReason}</TooltipContent>
        </Tooltip>
      ) : (
        toggleSwitch
      )}
    </div>
  );
}

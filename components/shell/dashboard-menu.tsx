"use client";

import { EllipsisIcon, Loader2Icon, PencilIcon, Trash2Icon } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { deleteDashboardAction } from "@/app/(app)/apps/actions";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { appPath, parseAppPath } from "@/lib/apps/paths";
import { cn } from "@/lib/utils";

/** A dashboard's actions in the sidebar: renaming it in place, and deleting it. */
export function DashboardMenu({
  appId,
  dashboard,
  onRename,
  className,
}: {
  appId: string;
  dashboard: { id: string; title: string };
  onRename: () => void;
  className?: string;
}) {
  const [confirming, setConfirming] = useState(false);
  // Rename starts once the menu has closed: while open, it holds focus and
  // would pull it straight back out of the name being edited.
  const renameOnClose = useRef(false);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={`Actions for ${dashboard.title}`}
          className={cn(
            "flex size-5 shrink-0 items-center justify-center rounded text-foreground/50 hover:bg-black/[0.06] hover:text-foreground",
            "focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none data-[state=open]:opacity-100",
            className,
          )}
        >
          <EllipsisIcon className="size-3.5" aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          side="right"
          className="min-w-44"
          onCloseAutoFocus={(event) => {
            if (!renameOnClose.current) return;
            renameOnClose.current = false;
            event.preventDefault();
            onRename();
          }}
        >
          <DropdownMenuItem onSelect={() => (renameOnClose.current = true)}>
            <PencilIcon aria-hidden />
            Rename
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => setConfirming(true)}>
            <Trash2Icon aria-hidden />
            Delete dashboard
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <DeleteDashboardDialog appId={appId} dashboard={dashboard} open={confirming} onOpenChange={setConfirming} />
    </>
  );
}

function DeleteDashboardDialog({
  appId,
  dashboard,
  open,
  onOpenChange,
}: {
  appId: string;
  dashboard: { id: string; title: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function confirm() {
    startTransition(async () => {
      const result = await deleteDashboardAction({ appId, dashboardId: dashboard.id });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      onOpenChange(false);
      toast.success(`${dashboard.title} deleted`);
      // Leaving the deleted dashboard: the app's home shows its next one, or the empty state.
      if (parseAppPath(pathname).dashboardId === dashboard.id) router.push(appPath(appId));
    });
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        if (next) setError(null);
        onOpenChange(next);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {dashboard.title}?</AlertDialogTitle>
          <AlertDialogDescription>
            This deletes the dashboard from the app. It can&apos;t be undone. The app&apos;s other dashboards and
            your data connections aren&apos;t affected.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <Button variant="destructive" onClick={confirm} disabled={pending}>
            {pending && <Loader2Icon className="animate-spin" aria-hidden />}
            Delete dashboard
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

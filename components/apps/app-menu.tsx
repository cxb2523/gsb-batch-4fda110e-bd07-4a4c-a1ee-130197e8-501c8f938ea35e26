"use client";

import { EllipsisIcon, Loader2Icon, PencilIcon, Trash2Icon } from "lucide-react";
import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { deleteAppAction } from "@/app/(app)/apps/actions";
import { useRenameApp } from "@/components/apps/app-workspace";
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

type App = { id: string; name: string; dashboardCount: number };

export function AppMenu({ app }: { app: App }) {
  const [deleting, setDeleting] = useState(false);
  const rename = useRenameApp();
  // Rename starts once the menu has closed: while open, it holds focus and
  // would pull it straight back out of the name being edited.
  const renameOnClose = useRef(false);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${app.name}`}>
            <EllipsisIcon aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="w-40"
          onCloseAutoFocus={(event) => {
            if (!renameOnClose.current) return;
            renameOnClose.current = false;
            event.preventDefault();
            rename();
          }}
        >
          <DropdownMenuItem onSelect={() => (renameOnClose.current = true)}>
            <PencilIcon aria-hidden />
            Rename
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(true)}>
            <Trash2Icon aria-hidden />
            Delete app
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <DeleteDialog app={app} open={deleting} onOpenChange={setDeleting} />
    </>
  );
}

function DeleteDialog({
  app,
  open,
  onOpenChange,
}: {
  app: App;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function confirm() {
    startTransition(async () => {
      // Only returns when deleting failed; on success it navigates to /apps.
      const result = await deleteAppAction({ id: app.id });
      if (result && !result.ok) setError(result.error.message);
      else toast.success(`${app.name} deleted`);
    });
  }

  const dashboards =
    app.dashboardCount === 1 ? "its dashboard" : app.dashboardCount ? `its ${app.dashboardCount} dashboards` : null;

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
          <AlertDialogTitle>Delete {app.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            This deletes the app{dashboards ? `, ${dashboards}` : ""} and its build history. It can&apos;t be
            undone. Your data connections aren&apos;t affected.
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
            Delete app
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

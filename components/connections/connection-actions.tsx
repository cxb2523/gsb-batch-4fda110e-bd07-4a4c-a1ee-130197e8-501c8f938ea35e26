"use client";

import { EllipsisIcon, KeyRoundIcon, Loader2Icon, PencilIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { useId, useState, useTransition } from "react";
import { toast } from "sonner";

import {
  deleteConnectionAction,
  renameConnectionAction,
  retestConnectionAction,
} from "@/app/(app)/connections/actions";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { ConnectionType } from "@/lib/sources/catalog";

import { PostHogFormDialog, type SecretMode } from "./connection-form-dialog";
import { PostgresFormDialog } from "./postgres-form-dialog";
import { SourceFormDialog } from "./source-form-dialog";

type Connection = {
  id: string;
  name: string;
  type: ConnectionType;
  apps: { id: string; name: string }[];
};

type OpenDialog = "replace" | "rename" | "delete" | null;

export function ConnectionActions({
  connection,
  secretMode,
}: {
  connection: Connection;
  secretMode: SecretMode;
}) {
  const [dialog, setDialog] = useState<OpenDialog>(null);
  const [testing, startTest] = useTransition();

  function retest() {
    startTest(async () => {
      const result = await retestConnectionAction({ id: connection.id });
      if (result.ok) toast.success(`${connection.name} is connected`);
      else toast.error(result.error.message);
    });
  }

  const close = (open: boolean) => !open && setDialog(null);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${connection.name}`}>
            {testing ? <Loader2Icon className="animate-spin" aria-hidden /> : <EllipsisIcon aria-hidden />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem onSelect={retest} disabled={testing}>
            <RefreshCwIcon aria-hidden />
            Test again
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setDialog("replace")}>
            <KeyRoundIcon aria-hidden />
            {["posthog", "bigquery", "ga4", "searchconsole", "mcp"].includes(connection.type) ? "Replace key" : "Change password"}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setDialog("rename")}>
            <PencilIcon aria-hidden />
            Rename
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => setDialog("delete")}>
            <Trash2Icon aria-hidden />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {connection.type === "postgres" ? (
        <PostgresFormDialog
          mode="replace"
          connection={connection}
          open={dialog === "replace"}
          onOpenChange={close}
          secretMode={secretMode}
        />
      ) : connection.type === "posthog" ? (
        <PostHogFormDialog
          mode="replace"
          connection={connection}
          open={dialog === "replace"}
          onOpenChange={close}
          secretMode={secretMode}
        />
      ) : (
        <SourceFormDialog
          type={connection.type}
          mode="replace"
          connection={connection}
          open={dialog === "replace"}
          onOpenChange={close}
          secretMode={secretMode}
        />
      )}
      <RenameDialog connection={connection} open={dialog === "rename"} onOpenChange={close} />
      <DeleteDialog connection={connection} open={dialog === "delete"} onOpenChange={close} />
    </>
  );
}

function RenameDialog({
  connection,
  open,
  onOpenChange,
}: {
  connection: Connection;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [name, setName] = useState(connection.name);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const id = useId();

  function submit(event: React.FormEvent) {
    event.preventDefault();
    startTransition(async () => {
      const result = await renameConnectionAction({ id: connection.id, name });
      if (result.ok) {
        toast.success("Connection renamed");
        onOpenChange(false);
      } else {
        setError(result.error.message);
      }
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        if (next) {
          setName(connection.name);
          setError(null);
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <form onSubmit={submit} noValidate>
          <DialogHeader>
            <DialogTitle>Rename connection</DialogTitle>
            <DialogDescription>Only the name changes. Apps keep using this connection.</DialogDescription>
          </DialogHeader>
          <Field className="my-6" data-invalid={!!error || undefined}>
            <FieldLabel htmlFor={id}>Name</FieldLabel>
            <Input
              id={id}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
              maxLength={80}
              autoComplete="off"
              aria-invalid={!!error || undefined}
              autoFocus
            />
            <FieldError>{error}</FieldError>
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending && <Loader2Icon className="animate-spin" aria-hidden />}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteDialog({
  connection,
  open,
  onOpenChange,
}: {
  connection: Connection;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  // The apps come from the page's latest data, never a copy: the page stays
  // mounted while hidden, so a copy would outlive apps deleted elsewhere. Only
  // the list the server sends back when it refuses is kept, until next open.
  const [refusedBy, setRefusedBy] = useState<Connection["apps"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const blockingApps = refusedBy ?? connection.apps;
  const blocked = blockingApps.length > 0;

  // Opened by the row menu through `open`, which doesn't call onOpenChange.
  // Reset while rendering when it opens, so the first frame is already fresh.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setRefusedBy(null);
      setError(null);
    }
  }

  function confirm() {
    startTransition(async () => {
      const result = await deleteConnectionAction({ id: connection.id });
      if (result.ok) {
        toast.success(`${connection.name} deleted`);
        onOpenChange(false);
      } else if (result.error.code === "in_use" && result.error.apps) {
        setRefusedBy(result.error.apps);
      } else {
        setError(result.error.message);
      }
    });
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        onOpenChange(next);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {blocked ? `${connection.name} is in use` : `Delete ${connection.name}?`}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div>
              {blocked ? (
                <>
                  <p>Dashboards in these apps use this connection. Delete those apps first.</p>
                  <ul className="mt-3 list-disc pl-5 text-foreground">
                    {blockingApps.map((app) => (
                      <li key={app.id}>{app.name}</li>
                    ))}
                  </ul>
                </>
              ) : (
                <p>This deletes the connection and its stored credential. It can&apos;t be undone.</p>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{blocked ? "Close" : "Cancel"}</AlertDialogCancel>
          {!blocked && (
            <Button variant="destructive" onClick={confirm} disabled={pending}>
              {pending && <Loader2Icon className="animate-spin" aria-hidden />}
              Delete
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

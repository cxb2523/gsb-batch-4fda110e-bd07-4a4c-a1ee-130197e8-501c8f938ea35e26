"use client";

import { PlusIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import type { SourceOption } from "@/lib/sources/catalog";

import { PostHogFormDialog, type SecretMode } from "./connection-form-dialog";
import { PostgresFormDialog } from "./postgres-form-dialog";
import { SourceFormDialog } from "./source-form-dialog";

export function AddConnectionButton({
  source,
  secretMode,
}: {
  source: Pick<SourceOption, "type" | "flavor">;
  secretMode: SecretMode;
}) {
  const [open, setOpen] = useState(false);
  const dialog = { mode: "create" as const, open, onOpenChange: setOpen, secretMode };
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <PlusIcon aria-hidden />
        Add connection
      </Button>
      {source.type === "postgres" ? (
        <PostgresFormDialog {...dialog} flavor={source.flavor} />
      ) : source.type === "posthog" ? (
        <PostHogFormDialog {...dialog} />
      ) : (
        <SourceFormDialog {...dialog} type={source.type} />
      )}
    </>
  );
}

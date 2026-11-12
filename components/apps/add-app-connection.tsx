"use client";

import { Loader2Icon, PlusIcon } from "lucide-react";
import Link from "next/link";
import { useTransition } from "react";
import { toast } from "sonner";

import { addAppConnectionAction } from "@/app/(app)/apps/actions";
import { SourceTile } from "@/components/connections/source-tile";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export type AddableConnection = { id: string; name: string; source: string; tile: string };

/**
 * The "+" after an app's data source badges: adds another of the user's
 * connections to the app, or goes to Data Connections to connect a new one.
 */
export function AddAppConnection({ appId, connections }: { appId: string; connections: AddableConnection[] }) {
  const [pending, startTransition] = useTransition();

  function add(connection: AddableConnection) {
    startTransition(async () => {
      const result = await addAppConnectionAction({ appId, connectionId: connection.id });
      if (result.ok) toast.success(`Added ${connection.name} to this app`);
      else toast.error(result.error.message);
    });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={pending}
        aria-label="Add a data source to this app"
        className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[0.6875rem] text-neutral-500 transition-colors outline-none hover:bg-neutral-100 hover:text-neutral-700 focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        {pending ? <Loader2Icon className="size-3 animate-spin" aria-hidden /> : <PlusIcon className="size-3" aria-hidden />}
        Add data source
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        {connections.length > 0 && (
          <>
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Add to this app</DropdownMenuLabel>
            {connections.map((connection) => (
              <DropdownMenuItem key={connection.id} onSelect={() => add(connection)}>
                <SourceTile label={connection.tile} className="size-6 rounded-md" />
                <span className="min-w-0 flex-1 truncate">{connection.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{connection.source}</span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem asChild>
          <Link href="/connections">
            <PlusIcon aria-hidden />
            Connect a new source
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

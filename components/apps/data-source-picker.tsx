"use client";

import { ChevronDownIcon, DatabaseIcon, PlusIcon } from "lucide-react";
import Link from "next/link";

import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/** `source` is a short label such as "PostHog US" or "Postgres". */
export type PickerConnection = { id: string; name: string; source: string };

/**
 * The composer's data source dropdown: pick which connections the prompt is
 * about, or go to Data Connections to add one (of any source type).
 */
export function DataSourcePicker({
  connections,
  selected,
  onToggle,
  disabled,
}: {
  connections: PickerConnection[];
  selected: Set<string>;
  onToggle: (id: string, checked: boolean) => void;
  disabled?: boolean;
}) {
  const chosen = connections.filter((connection) => selected.has(connection.id));

  const label =
    connections.length === 0
      ? "Add a data source"
      : chosen.length === 0
        ? "Choose data sources"
        : chosen.length === 1
          ? chosen[0].name
          : `${chosen.length} data sources`;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={disabled}
          className={cn(
            "flex h-8 max-w-[16rem] items-center gap-1.5 rounded-lg border px-2.5 text-xs transition-colors",
            "hover:bg-neutral-50 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
            "disabled:pointer-events-none disabled:opacity-50 data-[state=open]:bg-neutral-50",
            chosen.length ? "text-foreground/80" : "border-dashed text-muted-foreground",
          )}
        >
          <DatabaseIcon className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate">{label}</span>
          <ChevronDownIcon className="size-3.5 shrink-0 opacity-60" aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          {connections.length > 0 && (
            <>
              <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                Data sources for this app
              </DropdownMenuLabel>
              {connections.map((connection) => (
                <DropdownMenuCheckboxItem
                  key={connection.id}
                  checked={selected.has(connection.id)}
                  onCheckedChange={(checked) => onToggle(connection.id, checked === true)}
                  // Keep the menu open so several can be picked in a row.
                  onSelect={(event) => event.preventDefault()}
                >
                  <span className="min-w-0 flex-1 truncate">{connection.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {connection.source}
                  </span>
                </DropdownMenuCheckboxItem>
              ))}
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuItem asChild>
            <Link href="/connections">
              <PlusIcon aria-hidden />
              Add data source
            </Link>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

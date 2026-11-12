import { ChevronRightIcon, LayoutDashboardIcon } from "lucide-react";
import Link from "next/link";

/**
 * Which apps use a connection or demo dataset: a compact table under its
 * row, one line per app with an arrow that opens it. It's why the
 * connection can't be deleted. Long lists scroll inside the table.
 */
export function UsedBy({ apps }: { apps: { id: string; name: string }[] }) {
  if (!apps.length) return null;
  return (
    // Indented to line up with the row's text (the 2.5rem tile plus its gap), then out to the row's end.
    <div className="mt-2.5 ml-[3.25rem]">
      <p className="mb-1 text-[0.6875rem] font-medium tracking-wide text-muted-foreground uppercase">
        Used by {apps.length === 1 ? "1 app" : `${apps.length} apps`}
      </p>
      <ul className="max-h-[8.25rem] divide-y overflow-y-auto rounded-md border text-xs">
        {apps.map((app) => (
          <li key={app.id}>
            <Link
              href={`/apps/${app.id}`}
              className="flex items-center gap-2 px-2.5 py-1.5 transition-colors outline-none hover:bg-neutral-50 focus-visible:bg-neutral-50 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset"
            >
              <LayoutDashboardIcon className="size-3 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{app.name}</span>
              <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

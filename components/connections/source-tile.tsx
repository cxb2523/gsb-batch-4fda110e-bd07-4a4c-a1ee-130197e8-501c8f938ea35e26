import { DatabaseIcon } from "lucide-react";
import {
  siClickhouse,
  siGoogleanalytics,
  siGooglebigquery,
  siGooglesearchconsole,
  siModelcontextprotocol,
  siMysql,
  siNeon,
  siPostgresql,
  siPosthog,
  siSupabase,
  type SimpleIcon,
} from "simple-icons";

import { cn } from "@/lib/utils";

/** Each source's logo, by its tile code. Codes without a logo fall back to their letters. */
const LOGOS: Record<string, SimpleIcon> = {
  PH: siPosthog,
  PG: siPostgresql,
  SB: siSupabase,
  NE: siNeon,
  MY: siMysql,
  CH: siClickhouse,
  BQ: siGooglebigquery,
  GA: siGoogleanalytics,
  SC: siGooglesearchconsole,
  MC: siModelcontextprotocol,
};

/** The square tile at the start of a source or connection row: the source's logo. */
export function SourceTile({ label, className }: { label: string; className?: string }) {
  const logo = LOGOS[label];
  return (
    <div
      aria-hidden
      className={cn(
        "flex size-10 shrink-0 items-center justify-center rounded-lg border bg-neutral-50 text-xs font-bold tracking-tight text-neutral-700",
        className,
      )}
    >
      {logo ? (
        <svg viewBox="0 0 24 24" className="size-[56%]" fill={`#${logo.hex}`}>
          <path d={logo.path} />
        </svg>
      ) : label === "DM" ? (
        <DatabaseIcon className="size-[45%] text-neutral-500" />
      ) : (
        label
      )}
    </div>
  );
}

import Image from "next/image";

import { cn } from "@/lib/utils";

/** "Shiro / Dashboards": the OpenUI mascot, then the product. */
export function Brand({ className }: { className?: string }) {
  return (
    <span className={cn("flex items-center gap-2 text-sm font-medium", className)}>
      <Image src="/shiro-logo.svg" alt="Shiro" width={28} height={22} priority />
      <span className="text-muted-foreground" aria-hidden>
        /
      </span>
      Dashboards
    </span>
  );
}

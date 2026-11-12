import type { CSSProperties } from "react";

import { cn } from "@/lib/utils";

import type { Brand } from "./brands";

/** A brand's mark, painted in the element's background colour (black unless the caller says otherwise). */
export function BrandMark({ brand, className, style }: { brand: Brand; className?: string; style?: CSSProperties }) {
  return (
    <span
      aria-hidden
      className={cn("block shrink-0 bg-black [mask:var(--mark)_center/contain_no-repeat]", className)}
      style={{ "--mark": brand.mask, ...style } as CSSProperties}
    />
  );
}

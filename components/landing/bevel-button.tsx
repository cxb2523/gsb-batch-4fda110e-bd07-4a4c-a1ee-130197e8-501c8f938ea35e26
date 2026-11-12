import { ArrowUpRight } from "lucide-react";
import Link from "next/link";

import { cn } from "@/lib/utils";

const VARIANTS = {
  primary: {
    button:
      "border-white/12 bg-[#0a0a0a] text-white shadow-[inset_0_7px_12px_-6px_rgb(255_255_255/0.1),inset_0_-5px_8px_-2px_rgb(0_0_0/0.6)]",
    badge: "bg-white text-[#0a0a0a]",
  },
  secondary: {
    button:
      "border-black/8 bg-[#f7f7f8] text-[#0a0a0a] shadow-[inset_0_2px_1px_-0.5px_#fff,inset_0_-3px_6px_-1px_rgb(0_0_0/0.04)]",
    badge: "bg-[#0a0a0a] text-white",
  },
};

/**
 * The landing page's pill button. A link that leaves the site gets a round
 * arrow badge; one into the app is the label alone. Full width (up to 320px)
 * on phones.
 */
export function BevelButton({
  href,
  label,
  variant,
  external = false,
}: {
  href: string;
  label: string;
  variant: keyof typeof VARIANTS;
  external?: boolean;
}) {
  const styles = VARIANTS[variant];
  const className = cn(
    "inline-flex h-12 items-center gap-2.5 rounded-full border pl-5 font-(family-name:--font-display) text-base font-medium",
    "focus-visible:outline-2 focus-visible:outline-offset-[5px] focus-visible:outline-neutral-950",
    "max-md:w-full max-md:max-w-80",
    external ? "pr-2 max-md:justify-between" : "pr-5 justify-center",
    styles.button,
  );
  const content = (
    <>
      <span className="leading-6">{label}</span>
      {external && (
        <span aria-hidden className={cn("grid size-8 shrink-0 place-items-center rounded-full", styles.badge)}>
          <ArrowUpRight className="size-4" strokeWidth={2.25} />
        </span>
      )}
    </>
  );

  return external ? (
    <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
      {content}
    </a>
  ) : (
    // Into the app, which is behind sign-in: there's nothing to prefetch.
    <Link href={href} prefetch={false} className={className}>
      {content}
    </Link>
  );
}

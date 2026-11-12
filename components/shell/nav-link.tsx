"use client";

import { DatabaseIcon, SquarePenIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense } from "react";

import { cn } from "@/lib/utils";

/** Icons by name: Server Components can't pass component functions to this Client Component. */
const ICONS = { new: SquarePenIcon, connections: DatabaseIcon };

type Props = {
  href: string;
  label: string;
  icon?: keyof typeof ICONS;
  /** Active only on `href` itself, not on paths below it. */
  exact?: boolean;
  /** Smaller, for items nested under another one. */
  nested?: boolean;
};

/**
 * A sidebar link with an active highlight. The highlight reads the URL, which
 * on dynamic routes is only known at request time, so the link prerenders
 * without it and the highlight streams in.
 */
export function NavLink(props: Props) {
  return (
    <Suspense fallback={<NavLinkView {...props} active={false} />}>
      <ActiveNavLink {...props} />
    </Suspense>
  );
}

function ActiveNavLink(props: Props) {
  const pathname = usePathname();
  const active = props.exact
    ? pathname === props.href
    : pathname === props.href || pathname.startsWith(`${props.href}/`);
  return <NavLinkView {...props} active={active} />;
}

function NavLinkView({ href, label, icon, nested, active }: Props & { active: boolean }) {
  const Icon = icon ? ICONS[icon] : null;
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      title={nested ? label : undefined}
      className={cn(
        "flex items-center gap-2.5 rounded-lg px-2 text-sm transition-colors",
        "hover:bg-black/[0.04] hover:text-foreground",
        "focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
        nested ? "h-8 text-foreground/70" : "h-9 text-foreground/80",
        active && "bg-black/[0.06] font-medium text-foreground",
      )}
    >
      {Icon && <Icon className="size-4 shrink-0" aria-hidden />}
      <span className="truncate">{label}</span>
    </Link>
  );
}

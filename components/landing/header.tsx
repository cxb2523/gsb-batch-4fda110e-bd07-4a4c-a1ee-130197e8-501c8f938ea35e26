import Image from "next/image";
import Link from "next/link";
import { siGithub } from "simple-icons";

import { LINKS } from "./links";

/** The landing page's top bar: Shiro and the product name on the left, the GitHub star button and Sign Up on the right. */
export function Header() {
  return (
    <header className="sticky top-0 z-50 bg-white px-4">
      <div className="mx-auto flex min-h-16 max-w-390 items-center justify-between gap-4">
        <div className="flex items-center gap-0.5">
          {/* Shiro is OpenUI's mascot: it grows on hover and goes to OpenUI. */}
          <a
            href={LINKS.openui}
            aria-label="OpenUI"
            className="block rounded-full transition-[scale] duration-200 ease-[cubic-bezier(0.34,1.56,0.64,1)] hover:scale-[1.18] focus-visible:scale-[1.18] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-950"
          >
            <Image src="/shiro-logo.svg" alt="" width={32} height={32} className="size-8 object-contain" />
          </a>
          <Link
            href="/"
            className="rounded-sm font-(family-name:--font-geist) text-[15px] leading-6 font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-950"
          >
            OpenDashboards
          </Link>
        </div>
        <div className="flex items-center gap-2">
          <StarButton />
          {/* The app is behind sign-in: there's nothing to prefetch. */}
          <Link
            href={LINKS.app}
            prefetch={false}
            className="inline-flex h-10 items-center rounded-full whitespace-nowrap border border-black/8 bg-[#f7f7f8] px-3.5 text-[15px] font-medium text-[#0a0a0a] shadow-[inset_0_2px_1px_-0.5px_#fff,inset_0_-3px_6px_-1px_rgb(0_0_0/0.1)] focus-visible:outline-2 focus-visible:outline-offset-[5px] focus-visible:outline-neutral-950"
          >
            Sign Up
          </Link>
        </div>
      </div>
    </header>
  );
}

/** A black pill with a glowing GitHub mark: "Star". */
function StarButton() {
  return (
    <a
      href={LINKS.github}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Star OpenDashboards on GitHub"
      className="inline-flex h-10 items-center gap-1.5 rounded-full border border-white/14 whitespace-nowrap bg-[#0a0a0a] px-3.5 text-[15px] font-medium text-white shadow-[inset_0_7px_12px_-6px_rgb(255_255_255/0.16),inset_0_-5px_8px_-2px_rgb(0_0_0/0.6),inset_0_8px_12px_-6px_rgb(255_255_255/0.14)] focus-visible:outline-2 focus-visible:outline-offset-[5px] focus-visible:outline-neutral-950"
    >
      <svg
        aria-hidden
        viewBox="0 0 24 24"
        className="size-[18px] shrink-0 fill-white drop-shadow-[0_0_4px_rgb(255_255_255/0.5)]"
      >
        <path d={siGithub.path} />
      </svg>
      Star
    </a>
  );
}

import { ArrowUpRight } from "lucide-react";
import Image from "next/image";

import { ShiroMark } from "./shiro-mark";
import { svgPaths } from "./svg-paths";

/** What OpenDashboards is built with, each opening the product on openui.com. */
const BUILT_WITH = [
  {
    name: "OpenUI",
    line: "The open-source standard for generative UI.",
    href: "https://www.openui.com",
    mark: <ShiroMark className="block size-11 md:size-14" />,
    openSource: true,
  },
  {
    name: "OpenUI Dashboards",
    line: "Live, interactive dashboards from any model.",
    href: "https://www.openui.com/dashboards",
    mark: <DashboardsMark />,
    openSource: false,
  },
];

/** Each icon drawn in its own box, centred in a 24px square. */
const SOCIAL = [
  { label: "Twitter", href: "https://x.com/openuidev", viewBox: "0 0 24 24", path: svgPaths.pa1e7100, box: "top-1/2 left-1/2 size-5 -translate-1/2" },
  { label: "Discord", href: "https://discord.com/invite/Pbv5PsqUSv", viewBox: "0 0 21.9611 17", path: svgPaths.p3885cd00, box: "inset-0" },
  { label: "YouTube", href: "https://www.youtube.com/@thesysdev", viewBox: "0 0 22 15.4688", path: svgPaths.p23dbbd00, box: "top-1/2 left-1/2 h-[15.469px] w-[22px] -translate-1/2" },
  { label: "LinkedIn", href: "https://www.linkedin.com/showcase/openui-com/", viewBox: "0 0 19 19", path: svgPaths.p26fc3100, box: "top-1/2 left-1/2 size-[19px] -translate-1/2" },
];

const COPYRIGHT = "© 2026 Thesys Inc. All Rights Reserved";
const ADDRESS = "355 Bryant St, San Francisco, CA 94107";

/** The page's last fold: "Built with" cards, the Thesys mark, then the address, social links and copyright. */
export function Footer() {
  return (
    <footer className="px-5 pt-15 pb-4 lg:px-8">
      <div className="mx-auto max-w-300">
        <BuiltWith />

        <div className="pb-7">
          <a href="https://thesys.dev" target="_blank" rel="noopener noreferrer" aria-label="Thesys" className="relative block h-[2.625rem] w-[105px] text-neutral-950">
            <svg aria-hidden className="absolute block size-full" fill="none" viewBox="0 0 123.871 49.5484">
              <path d={svgPaths.p16775200} fill="currentColor" />
              <path clipRule="evenodd" d={svgPaths.p29abae30} fill="currentColor" fillRule="evenodd" />
              <path d={svgPaths.p318aaf80} fill="currentColor" />
              <path d={svgPaths.p3f22cf00} fill="currentColor" />
              <path d={svgPaths.p27013980} fill="currentColor" />
              <path d={svgPaths.p21b7f300} fill="currentColor" />
            </svg>
          </a>
        </div>

        <div className="border-t border-black/9 py-4">
          <div className="hidden items-center justify-between gap-2 text-[13px] leading-normal text-neutral-950/50 lg:flex">
            <p>{ADDRESS}</p>
            <SocialLinks />
            <p>{COPYRIGHT}</p>
          </div>
          <div className="flex flex-col items-center pt-10 pb-5 lg:hidden">
            <SocialLinks />
            <div className="mt-10 text-center text-[11px] leading-normal text-neutral-950/50">
              <p>{COPYRIGHT}</p>
              <p>{ADDRESS}</p>
            </div>
          </div>
        </div>
      </div>
    </footer>
  );
}

function BuiltWith() {
  return (
    <section aria-labelledby="built-with-title" className="mt-12 pb-16 md:mt-20">
      <h2
        id="built-with-title"
        className="font-(family-name:--font-display) text-xl leading-[1.1] font-semibold tracking-[-0.02em] text-balance md:text-2xl"
      >
        OpenDashboards is built with
      </h2>
      <ul className="mt-7 grid gap-3 md:grid-cols-2 md:gap-4">
        {BUILT_WITH.map((card) => (
          <li key={card.name}>
            <a
              href={card.href}
              target="_blank"
              rel="noopener noreferrer"
              className="group relative isolate flex h-full items-center gap-3.5 overflow-hidden rounded-2xl bg-[#f8f8f8] p-5 focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-neutral-950 md:gap-5 md:p-6"
            >
              {/* The hero's dither, mirrored and fading out to the left. */}
              <Image
                src="/landing/shaders/faded-dither-light-wide.webp"
                alt=""
                fill
                unoptimized
                className="pointer-events-none -z-1 -scale-x-100 object-cover opacity-70 brightness-[0.669] contrast-[3.14] [mask-image:linear-gradient(to_left,black_20px,transparent_96px)] md:[mask-image:linear-gradient(to_left,black_24px,transparent_112px)]"
              />
              <span aria-hidden className="grid h-11 shrink-0 place-items-center md:h-14">
                {card.mark}
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="flex items-center gap-1.5 font-(family-name:--font-display) text-lg leading-[1.2] font-semibold tracking-[-0.01em] md:gap-2 md:text-[22px]">
                  {card.name}
                  {card.openSource && (
                    <span className="rounded-[4px] border border-current px-[5px] pt-px pb-0.5 font-sans text-[11px] leading-none font-medium tracking-normal md:rounded-[5px] md:px-1.5 md:pt-0.5 md:pb-[3px] md:text-[13px]">
                      Open source
                    </span>
                  )}
                </span>
                <span className="text-sm leading-[1.45] text-neutral-950/60 md:text-base">{card.line}</span>
              </span>
              <ArrowUpRight
                aria-hidden
                strokeWidth={2.25}
                className="absolute top-3.5 right-3.5 size-4 text-neutral-950/60 transition group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-neutral-950 md:top-[18px] md:right-[18px] md:size-[18px]"
              />
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SocialLinks() {
  return (
    <div className="flex gap-6">
      {SOCIAL.map((link) => (
        <a
          key={link.label}
          href={link.href}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={link.label}
          className="relative size-6 text-neutral-950/50 transition-colors hover:text-neutral-950 focus-visible:text-neutral-950"
        >
          <span aria-hidden className={`absolute ${link.box}`}>
            <svg className="block size-full" fill="none" viewBox={link.viewBox}>
              <path d={link.path} fill="currentColor" />
            </svg>
          </span>
        </a>
      ))}
    </div>
  );
}

/* The OpenUI Dashboards mark: a pie chart drawn like Shiro (white inside,
   black lines, a white rim), its top-right slice pulling away and back. */
const PIE_BODY = "M22 12 A14 14 0 1 0 36 26 H22 Z";
const PIE_SLICE = "M22 12 A14 14 0 0 1 36 26 H22 Z";

function PiePiece({ d }: { d: string }) {
  return (
    <>
      <path d={d} stroke="white" strokeWidth="6" />
      <path d={d} fill="white" stroke="black" strokeWidth="2.25" />
    </>
  );
}

function DashboardsMark() {
  return (
    <svg className="block size-10 md:size-13" viewBox="0 0 48 48" fill="none" strokeLinejoin="round">
      {/* The slice is drawn first, so it tucks behind the rest of the pie. */}
      <g className="animate-[landing-slice_2.8s_ease-in-out_infinite] motion-reduce:translate-x-[7px] motion-reduce:-translate-y-[7px] motion-reduce:animate-none">
        <PiePiece d={PIE_SLICE} />
      </g>
      <PiePiece d={PIE_BODY} />
    </svg>
  );
}

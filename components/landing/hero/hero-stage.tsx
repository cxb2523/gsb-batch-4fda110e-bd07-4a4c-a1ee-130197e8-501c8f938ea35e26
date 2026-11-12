"use client";

import { ArrowUp, Check, ChevronLeft, ChevronRight, Database, PanelRightClose, Pause, Play, Plus } from "lucide-react";
import Image from "next/image";
import { useEffect, useRef, useState, type CSSProperties } from "react";

import { cn } from "@/lib/utils";

import { BrandMark } from "../brand-mark";
import type { Brand } from "../brands";
import { HERO_CASES, type HeroCase } from "./hero-cases";

/*
 * Each example plays once when its tab opens: the question pops in, the
 * sources pop in one by one, the dashboard blurs in, and the reply comes into
 * focus. The scene is keyed by example, so switching tabs restarts all of it.
 * With reduced motion every animation is off and everything simply shows.
 */
const POP = "animate-[landing-pop_0.35s_cubic-bezier(0.16,1,0.3,1)_both] motion-reduce:animate-none";
const delay = (seconds: number): CSSProperties => ({ animationDelay: `${seconds}s` });
/** When the i-th source chip (and its "Read" line) arrives. */
const sourceAt = (i: number) => 0.25 + i * 0.12;

/** A source's mark, white on its brand colour, as the app shows it in chips and the Build thread. */
function SourceLogo({ brand }: { brand: Brand }) {
  return (
    <span className="grid size-5 shrink-0 place-items-center rounded-full" style={{ background: brand.color }}>
      <BrandMark brand={brand} className="size-[11px] bg-white" />
    </span>
  );
}

/**
 * The hero's stage: the OpenDashboards app answering one question at a time,
 * on a light dither ground, with tabs under it that rotate through the
 * examples. The app is drawn on a fixed 1584×820 scene scaled to the stage's
 * width; phones zoom in on its left side.
 */
export function HeroStage() {
  const [active, setActive] = useState(0);
  const [paused, setPaused] = useState(false);
  const item = HERO_CASES[active];
  const go = (index: number) => setActive((index + HERO_CASES.length) % HERO_CASES.length);

  // Phones scroll the tab row: keep the active tab in its middle, at once on load and gliding after.
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const centred = useRef(false);
  useEffect(() => {
    const tab = tabRefs.current[active];
    const row = tab?.parentElement;
    if (!tab || !row || row.scrollWidth <= row.clientWidth) return;
    const t = tab.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    row.scrollTo({
      left: row.scrollLeft + t.left + t.width / 2 - (r.left + r.width / 2),
      behavior: centred.current ? "smooth" : "instant",
    });
    centred.current = true;
  }, [active]);

  return (
    <div className="relative" style={{ "--fill-play": paused ? "paused" : "running" } as CSSProperties}>
      <div
        role="img"
        aria-label={`OpenDashboards answering "${item.ask}" with a live ${item.label.toLowerCase()} dashboard built from ${item.sources.map((s) => s.name).join(", ")}`}
        className="relative aspect-[358/290] overflow-hidden rounded-xl border border-[#f8f8f8] bg-[#f4f4f5] [container-type:size] after:pointer-events-none after:absolute after:inset-x-0 after:bottom-0 after:z-1 after:h-[22%] after:bg-linear-to-b after:from-transparent after:to-[rgb(10_10_11/0.05)] md:aspect-[1584/820] md:rounded-3xl"
      >
        {/* Stills of a dither shader; served as they are, since recompressing would smear the pattern.
            Loaded up front: on phones this is the largest thing in the first screen, and each is a few KB. */}
        <Image src="/landing/shaders/faded-dither-light-compact.webp" alt="" fill unoptimized loading="eager" fetchPriority="high" className="object-cover md:hidden" />
        <Image src="/landing/shaders/faded-dither-light-wide.webp" alt="" fill unoptimized loading="eager" fetchPriority="high" className="object-cover max-md:hidden" />
        <div
          key={item.id}
          aria-hidden
          className="absolute top-0 left-0 z-1 h-205 w-396 origin-top-left [--k:tan(atan2(var(--stage-width),1584px))] [--stage-width:100cqw] [transform:scale(var(--k))] max-md:[--k:calc(tan(atan2(var(--stage-width),1280px))*1.3)] max-md:[transform:scale(var(--k))_translateX(calc(16px/var(--k)_-_202px))]"
        >
          <AppMock item={item} />
        </div>
      </div>

      <button
        type="button"
        aria-label={paused ? "Resume rotating the examples" : "Stop rotating the examples"}
        onClick={() => setPaused((value) => !value)}
        className="absolute bottom-2.5 left-2.5 z-3 grid size-7 place-items-center rounded-full border border-black/8 bg-white text-black/40 transition-colors hover:text-black/65 focus-visible:text-black/65"
      >
        {paused ? (
          <Play aria-hidden className="size-3" strokeWidth={0} fill="currentColor" />
        ) : (
          <Pause aria-hidden className="size-3" strokeWidth={0} fill="currentColor" />
        )}
      </button>

      <div className="pointer-events-none absolute inset-x-0 -bottom-[7px] z-2 flex translate-y-1/2 justify-center px-4">
        <StepButton label="Previous example" onClick={() => go(active - 1)}>
          <ChevronLeft aria-hidden className="size-[18px]" strokeWidth={2.25} />
        </StepButton>
        <div
          role="tablist"
          aria-label="Example questions"
          className="pointer-events-auto flex max-w-full gap-1 overflow-x-auto rounded-full bg-white p-1.5 shadow-[0_0_0_1px_rgb(0_0_0/0.04),0_1px_2px_1px_rgb(0_0_0/0.04),0_8px_20px_-6px_rgb(0_0_0/0.12)] [scrollbar-width:none] max-md:mx-2 max-md:min-w-0 max-md:flex-1 max-md:before:flex-[0_0_calc(50%-2.5rem)] max-md:after:flex-[0_0_calc(50%-2.5rem)]"
        >
          {HERO_CASES.map((c, i) => (
            <button
              key={c.id}
              type="button"
              role="tab"
              aria-selected={i === active}
              ref={(node) => {
                tabRefs.current[i] = node;
              }}
              onClick={() => go(i)}
              onAnimationEnd={(event) => {
                if (event.animationName === "landing-tab-fill") go(i + 1);
              }}
              className={cn(
                "relative shrink-0 overflow-hidden rounded-full px-3.5 py-1 text-sm leading-normal font-medium text-neutral-950/50 transition-colors hover:text-neutral-950 max-md:px-3 max-md:py-1.5 max-md:text-[13px]",
                // The active tab fills left to right over 8s, inverting its label as it goes, then hands over to the next.
                "aria-selected:isolate aria-selected:bg-neutral-100 aria-selected:text-neutral-950",
                "aria-selected:before:pointer-events-none aria-selected:before:absolute aria-selected:before:inset-0 aria-selected:before:origin-left aria-selected:before:bg-white aria-selected:before:mix-blend-difference aria-selected:before:[transform:scaleX(0)]",
                "aria-selected:before:animate-[landing-tab-fill_8s_linear_forwards] aria-selected:before:[animation-play-state:var(--fill-play)] motion-reduce:aria-selected:before:animate-none",
              )}
            >
              {c.label}
            </button>
          ))}
        </div>
        <StepButton label="Next example" onClick={() => go(active + 1)}>
          <ChevronRight aria-hidden className="size-[18px]" strokeWidth={2.25} />
        </StepButton>
      </div>
    </div>
  );
}

/** The arrows either side of the tabs: phones only. */
function StepButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="pointer-events-auto grid size-9 shrink-0 place-items-center self-center rounded-full bg-white text-neutral-950 shadow-[0_0_0_1px_rgb(0_0_0/0.04),0_1px_2px_1px_rgb(0_0_0/0.04),0_8px_20px_-6px_rgb(0_0_0/0.12)] md:hidden"
    >
      {children}
    </button>
  );
}

/** The app itself, at scene size: sidebar, the open dashboard, and the Build thread. */
function AppMock({ item }: { item: HeroCase }) {
  return (
    <div className="absolute top-16 left-16 h-200 w-364 rounded-t-[30px] bg-white px-[11px] pt-[11px] shadow-[0_0_0_1px_rgb(0_0_0/0.04),0_1px_2px_1px_rgb(0_0_0/0.04),0_16px_40px_-14px_rgb(0_0_0/0.12)] max-md:left-[202px]">
      <div className="relative grid h-full grid-cols-[184px_minmax(0,1fr)_300px] overflow-hidden rounded-t-[19px] bg-[#fafafa] text-left text-sm leading-[1.35] text-[#0a0a0b] after:pointer-events-none after:absolute after:inset-0 after:z-3 after:rounded-[inherit] after:border after:border-b-0 after:border-[rgb(10_10_11/0.08)] [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:stroke-[1.75]">
        <Sidebar active={item.id} />
        <Dashboard item={item} />
        <BuildThread item={item} />
      </div>
    </div>
  );
}

function Sidebar({ active }: { active: string }) {
  return (
    <div className="flex flex-col gap-1 border-r border-[rgb(10_10_11/0.06)] bg-[#f6f6f7] px-3.5 pt-2.5">
      <span className="mx-0.5 mb-3.5 flex h-8 items-center gap-1 text-[15px] font-semibold tracking-[-0.01em]">
        <Image src="/shiro-logo.svg" alt="" width={28} height={28} />
        OpenDashboards
      </span>
      <span className="mb-3.5 flex h-[34px] items-center justify-center gap-1.5 rounded-[9px] bg-white text-[13.5px] font-medium shadow-[0_0_0_1px_rgb(10_10_11/0.1),0_1px_2px_rgb(10_10_11/0.06)]">
        <Plus strokeWidth={2.75} className="size-3.5!" />
        New
      </span>
      {HERO_CASES.map((c) => (
        <NavItem key={c.id} active={c.id === active}>
          <c.Icon />
          {c.label}
        </NavItem>
      ))}
      <span className="mt-auto flex flex-col gap-0.5 pb-[72px]">
        <NavItem>
          <Database />
          Data connections
        </NavItem>
      </span>
    </div>
  );
}

function NavItem({ active = false, children }: { active?: boolean; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "flex h-[34px] items-center gap-2.5 rounded-[9px] px-2.5 text-[13.5px] text-[rgb(10_10_11/0.7)]",
        active && "bg-[rgb(10_10_11/0.08)] font-medium text-[#0a0a0b]",
      )}
    >
      {children}
    </span>
  );
}

function Dashboard({ item }: { item: HeroCase }) {
  return (
    <div className="flex min-w-0 flex-col bg-[#fafafa]">
      <div className="flex h-[52px] shrink-0 items-center gap-3 bg-white pr-3.5 pl-3">
        <span className="flex min-w-0 items-center gap-1.5">
          {item.sources.map((source, i) => (
            <span
              key={source.name}
              className={cn(
                "inline-flex h-[26px] items-center gap-1.5 rounded-full border border-[rgb(10_10_11/0.08)] bg-white pr-2.5 pl-[3px] text-[13px] font-medium whitespace-nowrap",
                POP,
              )}
              style={delay(sourceAt(i))}
            >
              <SourceLogo brand={source} />
              {source.name}
            </span>
          ))}
          <span className="ml-1 inline-flex items-center gap-1 text-[13px] whitespace-nowrap text-[rgb(10_10_11/0.45)]">
            <Plus className="size-3.5!" />
            Add data source
          </span>
        </span>
      </div>
      <div className="relative min-w-0 flex-1 overflow-hidden">
        {/* A capture of the dashboard, rendered once with the OpenUI Dashboards UI library. */}
        <Image
          src={item.image}
          alt=""
          width={item.width}
          height={item.height}
          sizes="(max-width: 767px) 900px, 72vw"
          className="block h-auto w-full animate-[landing-blur-in_0.6s_cubic-bezier(0.16,1,0.3,1)_0.9s_both] motion-reduce:animate-none"
        />
      </div>
    </div>
  );
}

function BuildThread({ item }: { item: HeroCase }) {
  return (
    <div className="relative flex flex-col border-l border-[rgb(10_10_11/0.06)] bg-white px-[18px]">
      <span className="flex h-[52px] items-center">
        <span className="grid size-[30px] place-items-center rounded-lg bg-[rgb(10_10_11/0.05)] text-[rgb(10_10_11/0.7)]">
          <PanelRightClose className="stroke-2!" />
        </span>
      </span>
      <div className="flex flex-col gap-[22px] pt-[22px]">
        <span
          className={cn("max-w-[88%] self-end rounded-[16px_16px_4px_16px] bg-[#f1f1f3] px-3.5 py-[9px] text-[15px]", POP)}
          style={delay(0.05)}
        >
          {item.ask}
        </span>
        <span className="flex flex-col gap-1.5">
          {item.sources.map((source, i) => (
            <span
              key={source.name}
              className={cn("flex items-center gap-2 text-[13px] text-[rgb(10_10_11/0.6)]", POP)}
              style={delay(sourceAt(i))}
            >
              <SourceLogo brand={source} />
              Read {source.name}
              <Check className="size-3.5! stroke-3! text-[#1f9d55]" />
            </span>
          ))}
        </span>
        <span className="animate-[landing-focus_1.7s_linear_both] text-[15px] leading-[1.45] motion-reduce:animate-none">
          {item.reply}
        </span>
      </div>
      <span className="absolute top-[676px] right-[18px] left-[18px] flex min-h-[52px] items-center justify-between gap-2.5 rounded-2xl border border-[rgb(10_10_11/0.1)] bg-white py-2 pr-2 pl-3.5 text-[13.5px] text-[rgb(10_10_11/0.45)] shadow-[0_8px_20px_-14px_rgb(16_24_40/0.3)]">
        Ask anything…
        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-[#050506] text-white">
          <ArrowUp />
        </span>
      </span>
    </div>
  );
}

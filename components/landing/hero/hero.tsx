import { ArrowRight } from "lucide-react";

import { BevelButton } from "../bevel-button";
import { BrandMark } from "../brand-mark";
import { BRANDS } from "../brands";
import { LINKS } from "../links";
import { HeroStage } from "./hero-stage";

const PROOF_SOURCES = [BRANDS.posthog, { ...BRANDS.postgres, name: "Postgres" }, BRANDS.stripe, BRANDS.mcp];

/**
 * The first fold. Desktop (900px, 56.25rem, and up): the title and eyebrow on the left,
 * the subtitle on the right, then the sources line and the buttons. Narrower:
 * everything centred, with the buttons before the sources line. The animated
 * app stage sits under both.
 */
export function Hero() {
  return (
    <section aria-labelledby="hero-title" className="px-4 pt-6 pb-10 md:px-8 md:pt-24">
      <div className="mx-auto flex max-w-300 flex-col items-center text-center min-[56.25rem]:items-start min-[56.25rem]:pt-20 min-[56.25rem]:text-left">
        <div className="order-1 flex w-full flex-col items-center gap-4 min-[56.25rem]:flex-row min-[56.25rem]:items-start min-[56.25rem]:justify-between min-[56.25rem]:gap-8">
          <div className="flex flex-col items-center gap-3 font-(family-name:--font-display) min-[56.25rem]:items-start min-[56.25rem]:gap-5">
            <Eyebrow />
            <h1
              id="hero-title"
              className="text-[40px] leading-[1.15] font-semibold text-balance md:text-[52px] min-[56.25rem]:text-6xl min-[56.25rem]:tracking-[-1px]"
            >
              {/* One sentence for crawlers and screen readers; phones show it without "any question". */}
              Ask<span className="max-md:hidden"> any question</span>. Get a live dashboard.
            </h1>
          </div>
          <p className="font-(family-name:--font-display) text-lg leading-[1.4] font-medium text-pretty text-neutral-950/60 md:text-[22px] md:leading-normal md:tracking-[-0.2px] min-[56.25rem]:mt-10 min-[56.25rem]:w-100 min-[56.25rem]:shrink-0 min-[56.25rem]:pt-3">
            One app. Infinite dashboards.
            <br className="max-md:hidden" /> Use any model. Host it anywhere.
          </p>
        </div>

        <div className="order-3 mt-14 min-[56.25rem]:order-2 min-[56.25rem]:mt-6">
          <SourcesLine />
        </div>

        <div className="order-2 mt-7 flex w-full flex-col items-center gap-3 md:flex-row md:justify-center min-[56.25rem]:order-3 min-[56.25rem]:mt-[49px] min-[56.25rem]:-ml-2 min-[56.25rem]:w-auto">
          <BevelButton href={LINKS.github} label="Star on GitHub" variant="primary" external />
          <BevelButton href={LINKS.app} label="Sign Up" variant="secondary" />
        </div>
      </div>

      <div className="mx-auto mt-12 max-w-320 min-[56.25rem]:mt-15">
        <HeroStage />
      </div>
    </section>
  );
}

/** "Open source · powered by OpenUI Dashboards". On phones it stays on one line and the link goes quiet. */
function Eyebrow() {
  return (
    <p className="flex items-baseline gap-1.5 text-[13px] leading-none font-medium whitespace-nowrap md:ml-0.5 md:gap-2 md:text-[17px]">
      <span className="rounded-[4px] border border-current px-[5px] pt-0.5 pb-[3px] md:rounded-[5px] md:px-1.5">
        Open source
      </span>
      <span className="text-neutral-950/60">
        powered by{" "}
        <a
          href={LINKS.dashboards}
          className="group inline-flex items-center gap-[0.3rem] rounded-md transition-colors hover:text-neutral-950 focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-neutral-950 max-md:pointer-events-none"
        >
          OpenUI Dashboards
          <ArrowRight aria-hidden className="size-[1em] stroke-3 transition-transform group-hover:translate-x-0.5 max-md:hidden" />
        </a>
      </span>
    </p>
  );
}

/** "Brings together data from" and the source marks, each briefly taking its brand colour in turn. */
function SourcesLine() {
  return (
    <div className="flex flex-wrap items-center justify-center gap-2 text-sm leading-5 font-medium text-neutral-950/60 md:inline-flex md:gap-x-3 min-[56.25rem]:justify-start">
      <span className="max-md:basis-full max-md:text-center">Brings together data from</span>
      <ul className="flex flex-wrap items-center gap-1.5 max-md:gap-2">
        {PROOF_SOURCES.map((brand, index) => (
          <li key={brand.name} className="inline-flex items-center gap-1.5 md:not-last:after:-ml-1.5 md:not-last:after:content-[',']">
            <BrandMark
              brand={brand}
              className="size-4 animate-[landing-shimmer_6s_ease-in-out_infinite] motion-reduce:animate-none"
              style={{ "--shimmer": brand.shimmer, animationDelay: `${index * 0.2}s` } as React.CSSProperties}
            />
            <span className="max-md:sr-only">{brand.name}</span>
          </li>
        ))}
      </ul>
      <span className="inline-flex items-center gap-1">
        and more
        <ArrowRight aria-hidden className="size-3.5 stroke-[2.5]" />
      </span>
    </div>
  );
}

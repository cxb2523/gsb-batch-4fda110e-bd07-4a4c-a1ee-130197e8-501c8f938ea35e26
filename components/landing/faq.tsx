const FAQS = [
  {
    question: "How is it different from Claude Dashboards?",
    answer: [
      "Claude Dashboards only work inside Claude, with Claude models, on Anthropic’s cloud.",
      "OpenDashboards is open source: connect your own databases and tools, use any model, and run it hosted at opendashboards.com or on your own servers.",
    ],
  },
  {
    question: "Is OpenDashboards open source?",
    answer: ["Yes. The app is open source. It builds dashboards with the OpenUI Dashboards API, which runs on OpenUI Cloud."],
  },
  {
    question: "Why do I need a Thesys API key?",
    answer: [
      "The key is for the OpenUI Dashboards API, which builds, stores and updates your dashboards. Create one and set up the API at console.thesys.dev.",
      "OpenUI Cloud has a generous free tier.",
    ],
  },
  {
    question: "Which models can I use?",
    answer: [
      "Any model the OpenUI Dashboards API supports.",
      "It also supports BYOK: add your own OpenAI or Anthropic key at console.thesys.dev and your calls run on it.",
    ],
  },
  {
    question: "What can I connect?",
    answer: [
      "Postgres, MySQL, ClickHouse, BigQuery, PostHog, Google Analytics and Search Console are built in.",
      "Anything else, like Stripe or HubSpot, connects through an MCP server.",
    ],
  },
  {
    question: "Can I use it without hosting anything?",
    answer: ["Yes. Use the hosted version at opendashboards.com, or self-host the app in your own environment."],
  },
  {
    question: "Does my data leave my servers if I self-host?",
    answer: [
      "Your credentials stay on your server, and queries run from it. The data behind each answer goes to the OpenUI Dashboards API on OpenUI Cloud, where your dashboards and chats are stored.",
      "For complete isolation, OpenUI Cloud can be privately hosted inside your network.",
    ],
  },
];

/**
 * Frequently asked questions: the title and a Discord note on the left (sticky
 * on desktop), the questions on the right. Built on <details>, so every answer
 * is in the markup for crawlers and it works without JavaScript. The items
 * share a name, so opening one closes the others; the first starts open.
 */
export function Faq() {
  return (
    <section
      aria-labelledby="faq-title"
      className="mx-auto grid w-full max-w-[calc(75rem+2*var(--gutter))] items-start gap-8 px-(--gutter) pt-[clamp(7rem,13.4vw,12rem)] text-neutral-950 [--gutter:1rem] md:[--gutter:1.5rem] lg:[--gutter:2rem] min-[56.3125rem]:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] min-[56.3125rem]:gap-[clamp(2rem,5vw,5rem)]"
    >
      <div className="flex flex-col gap-4 min-[56.3125rem]:sticky min-[56.3125rem]:top-28">
        <h2
          id="faq-title"
          className="font-(family-name:--font-display) text-[clamp(1.75rem,3vw,2.5rem)] leading-[1.1] font-semibold tracking-[-0.02em] text-balance"
        >
          <span className="max-md:hidden">Frequently asked questions</span>
          <span className="md:hidden">FAQs</span>
        </h2>
        <p className="text-base leading-[1.55] text-pretty text-neutral-950/60 min-[56.3125rem]:max-w-[26ch]">
          Have another question?
          <br />
          Join our{" "}
          <a
            href="https://discord.com/invite/Pbv5PsqUSv"
            target="_blank"
            rel="noopener noreferrer"
            className="border-b border-current text-neutral-950 hover:opacity-70"
          >
            Discord
          </a>
          .
        </p>
      </div>

      <div className="flex flex-col gap-3">
        {FAQS.map(({ question, answer }, index) => (
          <details
            key={question}
            name="faq"
            open={index === 0}
            className="group overflow-hidden rounded-2xl border border-[rgb(10_10_10/0.08)] bg-white transition-[border-color,transform] duration-180 [--pad-x:clamp(1.125rem,1.8vw,1.75rem)] [--pad-y:clamp(1rem,1.6vw,1.5rem)] focus-within:border-black/10 hover:border-black/10 active:translate-y-px motion-reduce:transition-none"
          >
            <summary className="flex cursor-pointer list-none items-start justify-between gap-6 px-(--pad-x) py-(--pad-y) group-open:pb-3 [&::-webkit-details-marker]:hidden">
              <span className="font-(family-name:--font-display) text-[clamp(1rem,1.3vw,1.125rem)] leading-[1.4] font-medium tracking-[-0.2px] text-pretty max-md:font-normal max-md:tracking-normal">
                {question}
              </span>
              {/* Two bars making a plus; the upright one folds away when open, leaving a minus. */}
              <span
                aria-hidden
                className="relative mt-[7px] size-2.5 shrink-0 before:absolute before:inset-x-0 before:top-1/2 before:h-[1.5px] before:-translate-y-1/2 before:rounded-xs before:bg-current after:absolute after:inset-x-0 after:top-1/2 after:h-[1.5px] after:-translate-y-1/2 after:rotate-90 after:rounded-xs after:bg-current after:transition-transform after:duration-220 after:ease-[cubic-bezier(0.45,0.05,0.15,1)] group-open:after:scale-x-0 motion-reduce:after:transition-none"
              />
            </summary>
            <div className="flex flex-col gap-3.5 px-(--pad-x) pb-(--pad-y) group-open:animate-[landing-faq-in_220ms_ease-out_both] motion-reduce:group-open:animate-none">
              {answer.map((paragraph) => (
                <p key={paragraph} className="text-[15px] leading-[1.6] text-pretty text-neutral-950/60">
                  {paragraph}
                </p>
              ))}
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}

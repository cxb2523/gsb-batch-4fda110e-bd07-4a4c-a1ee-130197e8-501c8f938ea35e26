import { BriefcaseBusiness, CircleDollarSign, Filter, Megaphone, Repeat, type LucideIcon } from "lucide-react";

import { BRANDS, type Brand } from "../brands";

/** One example in the hero: a question, the dashboard it built, and the tools that dashboard read. */
export type HeroCase = {
  id: string;
  label: string;
  Icon: LucideIcon;
  ask: string;
  reply: string;
  image: string;
  /** The capture's size in px; every capture is 1900px wide. */
  width: number;
  height: number;
  sources: Brand[];
};

export const HERO_CASES: HeroCase[] = [
  {
    id: "revenue",
    label: "Revenue",
    Icon: CircleDollarSign,
    ask: "How was revenue this month?",
    reply: "MRR grew $14.4K. New business and expansion more than covered churn.",
    image: "/landing/dashboards/revenue-light.png",
    width: 1900,
    height: 2856,
    sources: [BRANDS.stripe, BRANDS.postgres],
  },
  {
    id: "sales",
    label: "Sales",
    Icon: BriefcaseBusiness,
    ask: "How are my sales looking?",
    reply: "Pipeline is up 12% to $6.9M. Most of it sits in Proposal, so I broke it down by rep.",
    image: "/landing/dashboards/pipeline-light.png",
    width: 1900,
    height: 3130,
    sources: [BRANDS.hubspot, BRANDS.postgres],
  },
  {
    id: "marketing",
    label: "Marketing",
    Icon: Megaphone,
    ask: "Which ads are actually working?",
    reply: "Affiliates and sponsorships cost least per customer. Display costs the most.",
    image: "/landing/dashboards/marketing-light.png",
    width: 1900,
    height: 2810,
    sources: [BRANDS.googleAnalytics, BRANDS.hubspot, BRANDS.stripe],
  },
  {
    id: "conversion",
    label: "Conversion",
    Icon: Filter,
    ask: "Are signups turning into customers?",
    reply: "Most drop before activating. Referral converts best, so I ranked sources.",
    image: "/landing/dashboards/conversion-light.png",
    width: 1900,
    height: 2490,
    sources: [BRANDS.posthog, BRANDS.stripe, BRANDS.postgres],
  },
  {
    id: "retention",
    label: "Retention",
    Icon: Repeat,
    ask: "Are customers sticking around?",
    reply: "Yes. Week-1 retention climbed from 58% to 66% across the last six cohorts.",
    image: "/landing/dashboards/retention-light.png",
    width: 1900,
    height: 2650,
    sources: [BRANDS.posthog, BRANDS.postgres],
  },
];

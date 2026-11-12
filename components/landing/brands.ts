import {
  siGoogleanalytics,
  siHubspot,
  siModelcontextprotocol,
  siPosthog,
  siStripe,
  type SimpleIcon,
} from "simple-icons";

/** A brand's mark, used as a CSS mask so it takes whatever colour sits behind it. */
export type Brand = {
  name: string;
  /** A CSS `url(...)` for the mark. */
  mask: string;
  /** The colour its mark sits on in the app mock. */
  color: string;
  /** The colour its mark briefly takes in a monochrome row of marks. */
  shimmer: string;
};

const iconMask = (icon: SimpleIcon) =>
  `url("data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="${icon.path}"/></svg>`,
  )}")`;

export const BRANDS = {
  posthog: { name: "PostHog", mask: iconMask(siPosthog), color: "#1d4aff", shimmer: "#f54e00" },
  // Simple Icons draws Postgres as an outline; this is a solid mark.
  postgres: { name: "PostgreSQL", mask: 'url("/landing/brand-icons/postgresql-solid.png")', color: "#2f6feb", shimmer: "#2f6feb" },
  stripe: { name: "Stripe", mask: iconMask(siStripe), color: "#635bff", shimmer: "#635bff" },
  hubspot: { name: "HubSpot", mask: iconMask(siHubspot), color: "#ff5c35", shimmer: "#ff5c35" },
  googleAnalytics: { name: "Google Analytics", mask: iconMask(siGoogleanalytics), color: "#e37400", shimmer: "#e37400" },
  mcp: { name: "MCP", mask: iconMask(siModelcontextprotocol), color: "#6b7280", shimmer: "#6b7280" },
} satisfies Record<string, Brand>;

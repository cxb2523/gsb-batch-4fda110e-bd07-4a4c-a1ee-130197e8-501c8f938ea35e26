/**
 * The only hosts OpenDashboards talks to for PostHog. A connection stores a host kind,
 * never a URL, so nothing a user types can point requests elsewhere.
 */
export const POSTHOG_HOSTS = {
  posthog_us: { url: "https://us.posthog.com", label: "US Cloud" },
  posthog_eu: { url: "https://eu.posthog.com", label: "EU Cloud" },
} as const satisfies Record<string, { url: string; label: string }>;

export type HostKind = keyof typeof POSTHOG_HOSTS;

export const HOST_KINDS = Object.keys(POSTHOG_HOSTS) as [HostKind, ...HostKind[]];

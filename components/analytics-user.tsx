"use client";

import posthog from "posthog-js";
import { useEffect } from "react";

/** Ties this browser's PostHog events to the signed-in user, the id the server's events carry. */
export function AnalyticsUser({ id, email }: { id: string; email: string }) {
  useEffect(() => {
    if (posthog.__loaded) posthog.identify(id, { email });
  }, [id, email]);
  return null;
}

import "server-only";

import { waitUntil } from "@vercel/functions";
import { PostHog } from "posthog-node";

// The same PostHog project and proxy as openui.com.
const POSTHOG_KEY = "phc_3OLW53x09ZTVZSV6BEpj5uycj3ooqR6KOemOjx04e3D";
const POSTHOG_HOST = "https://dgoeivjus9jfp.cloudfront.net";

let client: PostHog | undefined;

/**
 * Records a product event for a user, only on Vercel. Properties are ids,
 * counts and fixed labels: never prompts, queries, names or credentials.
 */
export function track(userId: string, event: string, properties: Record<string, unknown> = {}): void {
  const environment = process.env.VERCEL_ENV;
  if (!environment) return;
  client ??= new PostHog(POSTHOG_KEY, { host: POSTHOG_HOST });
  // Sent before the function is frozen; a failure never reaches the user.
  waitUntil(
    client
      .captureImmediate({
        distinctId: userId,
        event: `opendashboards_${event}`,
        properties: { app: "opendashboards", environment, ...properties },
      })
      .catch(() => {}),
  );
}

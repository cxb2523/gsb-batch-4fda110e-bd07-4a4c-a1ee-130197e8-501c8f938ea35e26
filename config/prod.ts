import type { EnvironmentSettings } from "./settings";

/** Production builds and `next start`, behind the gateway. */
export const prod: EnvironmentSettings = {
  auth: { devUser: null, publicHost: "opendashboards.com" },
  secrets: { allowPlaintext: false },
  network: { connectAttemptTimeoutMs: null },
};

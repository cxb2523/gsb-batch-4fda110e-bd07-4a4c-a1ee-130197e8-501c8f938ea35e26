import type { EnvironmentSettings } from "./settings";

/** `next dev` and tests, on a developer's machine. */
export const local: EnvironmentSettings = {
  auth: { devUser: { id: "dev-user", email: "user@example.dev" }, publicHost: null },
  secrets: { allowPlaintext: true },
  // Home and office networks are often slow, or have IPv6 that goes nowhere.
  network: { connectAttemptTimeoutMs: 2_000 },
};

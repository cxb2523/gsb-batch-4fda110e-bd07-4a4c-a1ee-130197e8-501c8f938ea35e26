import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";

import { config } from "@/config";

/**
 * How long Node waits on each of a host's addresses before trying the next
 * when it opens a connection (Happy Eyeballs). Node's default is 250ms: on a
 * slow link every IPv4 attempt times out before it connects, and where IPv6
 * is unreachable `fetch` fails outright with ETIMEDOUT though the host is up.
 * Only environments that set network.connectAttemptTimeoutMs (local) change
 * it; the rest keep Node's default.
 *
 * Called once when the server starts.
 */
export function configureConnectTimeouts(): void {
  const timeout = config().network.connectAttemptTimeoutMs;
  if (timeout !== null) setDefaultAutoSelectFamilyAttemptTimeout(timeout);
}

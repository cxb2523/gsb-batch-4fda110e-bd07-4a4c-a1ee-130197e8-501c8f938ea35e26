import "server-only";

import { secrets } from "@/config";

/**
 * Our own infrastructure's host names, which no user connection may point
 * at: the database that holds every user's connections, apps and sealed
 * secrets. Neon serves it publicly, so the address checks alone don't stop it.
 * Credentials never leak to it (none of ours are ever sent on a user's behalf),
 * but there's no reason to let a connector knock on its door at all.
 */

/** "ep-x-pooler.c-1.us-east-1.aws.neon.tech" and "ep-x.c-1…" are the same database. */
const withoutPooler = (host: string) => host.replace(/^([^.]+)-pooler\./, "$1.");

function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "");
    return host || null;
  } catch {
    return null;
  }
}

/** Whether `host` is one of ours. Compared case-insensitively, pooled and direct alike. */
export function isOwnHost(host: string): boolean {
  const candidate = withoutPooler(host.toLowerCase().replace(/^\[(.*)\]$/, "$1").replace(/\.$/, ""));
  return [secrets.databaseUrl(), secrets.databaseUrlUnpooled()]
    .map(hostOf)
    .some((own) => own !== null && withoutPooler(own) === candidate);
}

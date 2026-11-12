import { z } from "zod";

import { hostSchemaFor, portSchema, sslModeSchema, type SslMode } from "../host";
import type { SourceCatalog } from "../types";

/**
 * Where a Postgres connection points, and how. Safe for the browser: no
 * password here. Host, port and database are fixed once the connection is
 * saved; pointing elsewhere means a new connection.
 */

export { portSchema, SSL_MODES, sslModeSchema, type SslMode } from "../host";

export const DEFAULT_PORT = 5432;

export const hostSchema = hostSchemaFor("postgres");

export const databaseSchema = z.string().trim().min(1, "Enter the database name.").max(63, "Postgres names are at most 63 characters.");
export const userSchema = z.string().trim().min(1, "Enter the user name.").max(63, "Postgres names are at most 63 characters.");
/** Empty for a server that needs no password, such as a public read-only one. */
export const passwordSchema = z.string().max(1024, "That password is too long.");

export const postgresConfigSchema = z
  .object({
    host: hostSchema,
    port: portSchema,
    database: databaseSchema,
    user: userSchema,
    sslMode: sslModeSchema,
  })
  .strict();

export type PostgresConfig = z.infer<typeof postgresConfigSchema>;

export type ParsedConnectionString = Partial<PostgresConfig & { password: string }>;

/**
 * Reads a postgres:// URL into form fields, for pasting. The string itself is
 * never stored or sent: only the fields are. Returns null for anything that
 * isn't a Postgres URL.
 */
export function parseConnectionString(input: string): ParsedConnectionString | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") return null;

  const fields: ParsedConnectionString = {};
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  if (host) fields.host = decodeURIComponent(host);
  if (url.port) fields.port = Number(url.port);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (database) fields.database = database;
  if (url.username) fields.user = decodeURIComponent(url.username);
  if (url.password) fields.password = decodeURIComponent(url.password);

  const sslmode = url.searchParams.get("sslmode");
  if (sslmode === "verify-full" || sslmode === "verify-ca") fields.sslMode = "verify-full";
  // prefer/allow/disable can mean no encryption, which OpenDashboards never uses: encrypt at least.
  else if (sslmode === "require" || sslmode === "prefer" || sslmode === "allow" || sslmode === "disable") {
    fields.sslMode = "require";
  }
  return fields;
}

/**
 * Hosted services that are Postgres underneath. They're stored as ordinary
 * Postgres connections; the flavor only changes how the form guides you and
 * how the connection is labelled, which is read back from its host.
 */
export const POSTGRES_FLAVORS = {
  supabase: {
    label: "Supabase",
    tile: "SB",
    blurb: "Your Supabase project's Postgres database",
    hostSuffixes: ["supabase.com", "supabase.co"],
    // Supabase signs with its own certificate authority, which no system trusts.
    sslMode: "require",
    hostPlaceholder: "aws-0-us-east-1.pooler.supabase.com",
    databasePlaceholder: "postgres",
    userPlaceholder: "dashboards_reader.your-project-ref",
    tip: "In Supabase, open Connect and copy the Session pooler string: the direct host only answers over IPv6. Supabase uses its own certificate authority, so the connection is encrypted but its certificate isn't checked.",
  },
  neon: {
    label: "Neon",
    tile: "NE",
    blurb: "Your Neon project's Postgres database",
    hostSuffixes: ["neon.tech"],
    sslMode: "verify-full",
    hostPlaceholder: "ep-example-123456.us-east-2.aws.neon.tech",
    databasePlaceholder: "neondb",
    userPlaceholder: "dashboards_reader",
    tip: "In Neon, open Connect, pick the branch and database, and copy the connection string.",
  },
} as const satisfies Record<
  string,
  {
    label: string;
    tile: string;
    blurb: string;
    hostSuffixes: readonly string[];
    sslMode: SslMode;
    hostPlaceholder: string;
    databasePlaceholder: string;
    userPlaceholder: string;
    tip: string;
  }
>;

export type PostgresFlavor = keyof typeof POSTGRES_FLAVORS;
export const POSTGRES_FLAVOR_KEYS = Object.keys(POSTGRES_FLAVORS) as PostgresFlavor[];

/** Which hosted service a host belongs to, if any. */
export function flavorOf(host: string): PostgresFlavor | null {
  const name = host.toLowerCase().replace(/\.$/, "");
  return (
    POSTGRES_FLAVOR_KEYS.find((key) =>
      POSTGRES_FLAVORS[key].hostSuffixes.some((suffix) => name === suffix || name.endsWith(`.${suffix}`)),
    ) ?? null
  );
}

/** `analyst@db.example.com:5432/app`, for lists. */
export function postgresAddress(config: Pick<PostgresConfig, "host" | "port" | "database" | "user">): string {
  const host = config.host.includes(":") ? `[${config.host}]` : config.host;
  return `${config.user}@${host}:${config.port}/${config.database}`;
}

export const postgresCatalog: SourceCatalog<PostgresConfig, "postgres"> = {
  type: "postgres",
  label: "Postgres",
  blurb: "Any database reachable on the public internet",
  tile: "PG",
  configSchema: postgresConfigSchema,
  describe: (config) => {
    const flavor = flavorOf(config.host);
    const { label, tile } = flavor ? POSTGRES_FLAVORS[flavor] : { label: "Postgres", tile: "PG" };
    return { source: label, shortSource: label, detail: postgresAddress(config), tile };
  },
};

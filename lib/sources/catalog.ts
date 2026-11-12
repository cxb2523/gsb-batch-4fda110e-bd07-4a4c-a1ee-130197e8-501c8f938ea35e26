import { z } from "zod";

import { bigqueryCatalog, bigqueryConfigSchema } from "./bigquery/catalog";
import { clickhouseCatalog, clickhouseConfigSchema } from "./clickhouse/catalog";
import { ga4Catalog, ga4ConfigSchema } from "./ga4/catalog";
import { mcpCatalog, mcpConfigSchema } from "./mcp/catalog";
import { mysqlCatalog, mysqlConfigSchema } from "./mysql/catalog";
import { posthogCatalog, posthogConfigSchema } from "./posthog/catalog";
import { searchConsoleCatalog, searchConsoleConfigSchema } from "./searchconsole/catalog";
import { POSTGRES_FLAVOR_KEYS, POSTGRES_FLAVORS, postgresCatalog, postgresConfigSchema, type PostgresFlavor } from "./postgres/catalog";
import type { SourceCatalog, SourceDescription } from "./types";

/**
 * Every source's client-safe catalog. Adding a source: add it here and in
 * ./index.ts, and to the connection_type enum in lib/db/schema.ts.
 */
export const CATALOGS = [posthogCatalog, postgresCatalog, mysqlCatalog, clickhouseCatalog, bigqueryCatalog, ga4Catalog, searchConsoleCatalog, mcpCatalog] as const;

export const CONNECTION_TYPES = ["posthog", "postgres", "mysql", "clickhouse", "bigquery", "ga4", "searchconsole", "mcp"] as const satisfies readonly (typeof CATALOGS)[number]["type"][];
export type ConnectionType = (typeof CONNECTION_TYPES)[number];

/** A stored config: the source's settings, tagged with its type. */
export const connectionConfigSchema = z.discriminatedUnion("type", [
  posthogConfigSchema.extend({ type: z.literal("posthog") }),
  postgresConfigSchema.extend({ type: z.literal("postgres") }),
  mysqlConfigSchema.extend({ type: z.literal("mysql") }),
  clickhouseConfigSchema.extend({ type: z.literal("clickhouse") }),
  bigqueryConfigSchema.extend({ type: z.literal("bigquery") }),
  ga4ConfigSchema.extend({ type: z.literal("ga4") }),
  searchConsoleConfigSchema.extend({ type: z.literal("searchconsole") }),
  mcpConfigSchema.extend({ type: z.literal("mcp") }),
]);

export type ConnectionConfig = z.infer<typeof connectionConfigSchema>;

export function catalogFor(type: ConnectionType): SourceCatalog {
  const catalog = CATALOGS.find((candidate) => candidate.type === type);
  if (!catalog) throw new Error(`Unknown connection type: ${type}`);
  return catalog as unknown as SourceCatalog;
}

export function describeConnection(config: ConnectionConfig): SourceDescription {
  const { type, ...settings } = config;
  return catalogFor(type).describe(settings);
}

/**
 * What the "connect a source" lists offer: each source, then the hosted
 * services that are one of them underneath (Supabase and Neon are Postgres).
 */
export type SourceOption = {
  key: string;
  type: ConnectionType;
  flavor: PostgresFlavor | null;
  label: string;
  blurb: string;
  tile: string;
};

export const SOURCE_OPTIONS: SourceOption[] = CATALOGS.flatMap(({ type, label, blurb, tile }): SourceOption[] => [
  { key: type, type, flavor: null, label, blurb, tile },
  // Postgres-compatible services sit right after Postgres.
  ...(type === "postgres"
    ? POSTGRES_FLAVOR_KEYS.map((flavor) => {
        const { label, blurb, tile } = POSTGRES_FLAVORS[flavor];
        return { key: flavor, type: "postgres" as const, flavor, label, blurb, tile };
      })
    : []),
]);

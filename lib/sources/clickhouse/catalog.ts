import { z } from "zod";

import { hostSchemaFor, portSchema, sslModeSchema } from "../host";
import type { SourceCatalog } from "../types";

/**
 * Where a ClickHouse connection points: its HTTPS interface. Safe for the
 * browser: no password here.
 */

/** ClickHouse Cloud and most TLS setups serve HTTPS on 8443. */
export const CLICKHOUSE_DEFAULT_PORT = 8443;

export const clickhouseConfigSchema = z
  .object({
    host: hostSchemaFor("https"),
    port: portSchema,
    database: z
      .string()
      .trim()
      .min(1, "Enter the database name.")
      .max(128, "That database name is too long.")
      .regex(/^[A-Za-z0-9_.-]+$/, "Database names here are letters, digits, _, . and -."),
    user: z.string().trim().min(1, "Enter the user name.").max(128, "That user name is too long."),
    sslMode: sslModeSchema,
  })
  .strict();

export type ClickhouseConfig = z.infer<typeof clickhouseConfigSchema>;

/** Empty for a user that needs no password, such as a public playground. */
export const clickhousePasswordSchema = z.string().max(1024, "That password is too long.");

/** `default@abc123.us-east-1.aws.clickhouse.cloud:8443/default`, for lists. */
export function clickhouseAddress(config: Pick<ClickhouseConfig, "host" | "port" | "database" | "user">): string {
  const host = config.host.includes(":") ? `[${config.host}]` : config.host;
  return `${config.user}@${host}:${config.port}/${config.database}`;
}

export const clickhouseCatalog: SourceCatalog<ClickhouseConfig, "clickhouse"> = {
  type: "clickhouse",
  label: "ClickHouse",
  blurb: "ClickHouse Cloud or your own server, over HTTPS",
  tile: "CH",
  configSchema: clickhouseConfigSchema,
  describe: (config) => ({ source: "ClickHouse", shortSource: "ClickHouse", detail: clickhouseAddress(config), tile: "CH" }),
};

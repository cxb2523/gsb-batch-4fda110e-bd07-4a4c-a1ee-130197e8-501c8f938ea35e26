import { z } from "zod";

import { hostSchemaFor, portSchema, sslModeSchema } from "../host";
import type { SourceCatalog } from "../types";

/**
 * Where a MySQL or MariaDB connection points. Safe for the browser: no
 * password here. Host, port and database are fixed once saved.
 */

export const MYSQL_DEFAULT_PORT = 3306;

export const mysqlConfigSchema = z
  .object({
    host: hostSchemaFor("mysql"),
    port: portSchema,
    database: z.string().trim().min(1, "Enter the database name.").max(64, "MySQL names are at most 64 characters."),
    user: z.string().trim().min(1, "Enter the user name.").max(80, "That user name is too long."),
    sslMode: sslModeSchema,
  })
  .strict();

export type MysqlConfig = z.infer<typeof mysqlConfigSchema>;

/** Empty for a server that needs no password, such as a public read-only one. */
export const mysqlPasswordSchema = z.string().max(1024, "That password is too long.");

/** `analyst@db.example.com:3306/shop`, for lists. */
export function mysqlAddress(config: Pick<MysqlConfig, "host" | "port" | "database" | "user">): string {
  const host = config.host.includes(":") ? `[${config.host}]` : config.host;
  return `${config.user}@${host}:${config.port}/${config.database}`;
}

/** Reads a mysql:// URL into form fields, for pasting. The URL itself is never stored or sent. */
export function parseMysqlUrl(input: string): Partial<MysqlConfig & { password: string }> | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "mysql:" && url.protocol !== "mariadb:") return null;
  const fields: Partial<MysqlConfig & { password: string }> = {};
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  if (host) fields.host = decodeURIComponent(host);
  if (url.port) fields.port = Number(url.port);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (database) fields.database = database;
  if (url.username) fields.user = decodeURIComponent(url.username);
  if (url.password) fields.password = decodeURIComponent(url.password);
  return fields;
}

export const mysqlCatalog: SourceCatalog<MysqlConfig, "mysql"> = {
  type: "mysql",
  label: "MySQL",
  blurb: "MySQL or MariaDB, reachable on the public internet",
  tile: "MY",
  configSchema: mysqlConfigSchema,
  describe: (config) => ({ source: "MySQL", shortSource: "MySQL", detail: mysqlAddress(config), tile: "MY" }),
};

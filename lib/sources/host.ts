import { z } from "zod";

/**
 * Host and port fields shared by sources that connect to a server the user
 * names. Client-safe. Where the host may point is enforced at connect time
 * (lib/net), not here: this only rejects things that aren't a host at all.
 */

/** A DNS name or an IP literal. No scheme, path, user info or socket path. */
const HOSTNAME = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.?$/;
const IPV6_LITERAL = /^[0-9A-Fa-f:.]{2,45}$/;

export const isHost = (host: string) => HOSTNAME.test(host) || (host.includes(":") && IPV6_LITERAL.test(host));

/** `scheme` names the URL prefix people tend to paste: "postgres", "mysql", "https". */
export const hostSchemaFor = (scheme: string) =>
  z
    .string()
    .trim()
    .min(1, "Enter the host.")
    .refine(isHost, `Enter a host name or IP address, without ${scheme}:// or a port.`);

export const portSchema = z.coerce
  .number({ error: "Enter a port number." })
  .int("Enter a port number.")
  .min(1, "Ports run from 1 to 65535.")
  .max(65535, "Ports run from 1 to 65535.");

/** verify-full: encrypted, certificate checked (default). require: encrypted only. Never unencrypted. */
export const SSL_MODES = ["verify-full", "require"] as const;
export type SslMode = (typeof SSL_MODES)[number];
export const sslModeSchema = z.enum(SSL_MODES, { error: "Choose an SSL mode." });

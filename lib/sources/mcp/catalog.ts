import { z } from "zod";

import { isHost } from "../host";
import type { SourceCatalog } from "../types";

/**
 * A remote MCP server: its Streamable HTTP endpoint, and which header carries
 * the API key. Safe for the browser: the key is the credential, never here.
 */

/** Headers the transport sets itself, or that would change where or how a request goes. */
const RESERVED_HEADERS = new Set([
  "accept",
  "connection",
  "content-length",
  "content-type",
  "cookie",
  "host",
  "keep-alive",
  "last-event-id",
  "mcp-protocol-version",
  "mcp-session-id",
  "origin",
  "proxy-authorization",
  "referer",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "user-agent",
]);

/** The server's endpoint: HTTPS, a real host, no user info or fragment. Exported for tests. */
export function normalizeMcpUrl(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) return null;
  if (!isHost(url.hostname.replace(/^\[(.*)\]$/, "$1"))) return null;
  return url.href;
}

export const mcpConfigSchema = z
  .object({
    url: z.string().transform((value, ctx) => {
      const url = normalizeMcpUrl(value);
      if (!url) {
        ctx.addIssue({ code: "custom", message: "Enter the server's https:// endpoint, like https://mcp.example.com/mcp." });
        return z.NEVER;
      }
      return url;
    }),
    /** "Authorization" sends `Bearer <key>`; any other header sends the key as is. */
    headerName: z
      .string()
      .trim()
      .default("Authorization")
      .pipe(
        z
          .string()
          .regex(/^[A-Za-z0-9-]{1,64}$/, "Use a header name like Authorization or X-API-Key.")
          .refine((name) => !RESERVED_HEADERS.has(name.toLowerCase()), "That header is set by OpenDashboards itself; choose another."),
      ),
  })
  .strict();

export type McpConfig = z.infer<typeof mcpConfigSchema>;

/** The key, or nothing for a public server. */
export const mcpKeySchema = z.string().trim().max(4_096, "That key is too long.");

export const mcpCatalog: SourceCatalog<McpConfig, "mcp"> = {
  type: "mcp",
  label: "MCP server",
  blurb: "Any remote MCP server, with an API key",
  tile: "MC",
  configSchema: mcpConfigSchema,
  describe: (config) => {
    const url = new URL(config.url);
    return { source: "MCP server", shortSource: "MCP", detail: `${url.host}${url.pathname === "/" ? "" : url.pathname}`, tile: "MC" };
  },
};

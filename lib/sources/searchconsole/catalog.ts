import { z } from "zod";

import type { SourceCatalog } from "../types";

/**
 * Which Search Console property a connection reads. Safe for the browser:
 * the service account key is the credential, never here.
 *
 * Properties come in two kinds, written the way Search Console's API names them:
 * - Domain: "sc-domain:example.com" (every subdomain and protocol).
 * - URL prefix: "https://www.example.com/" (always ending in a slash).
 */

const DOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Accepts what people paste ("example.com", "https://example.com") and stores the API's form. */
export function normalizeSiteUrl(input: string): string | null {
  const value = input.trim();
  if (/^sc-domain:/i.test(value)) {
    const domain = value.slice("sc-domain:".length).toLowerCase();
    return DOMAIN.test(domain) ? `sc-domain:${domain}` : null;
  }
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (url.username || url.password || url.search || url.hash || !DOMAIN.test(url.hostname)) return null;
      return `${url.protocol}//${url.host}${url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`}`;
    } catch {
      return null;
    }
  }
  // A bare domain most likely means a Domain property.
  const domain = value.toLowerCase().replace(/\/+$/, "");
  return DOMAIN.test(domain) ? `sc-domain:${domain}` : null;
}

export const searchConsoleConfigSchema = z
  .object({
    siteUrl: z
      .string()
      .transform((value, ctx) => {
        const site = normalizeSiteUrl(value);
        if (!site) {
          ctx.addIssue({ code: "custom", message: "Enter the property as Search Console shows it: sc-domain:example.com, or https://www.example.com/." });
          return z.NEVER;
        }
        return site;
      }),
  })
  .strict();

export type SearchConsoleConfig = z.infer<typeof searchConsoleConfigSchema>;

export const searchConsoleCatalog: SourceCatalog<SearchConsoleConfig, "searchconsole"> = {
  type: "searchconsole",
  label: "Search Console",
  blurb: "Google search clicks, impressions and rankings",
  tile: "SC",
  configSchema: searchConsoleConfigSchema,
  describe: (config) => ({
    source: "Search Console",
    shortSource: "Search Console",
    detail: config.siteUrl.replace(/^sc-domain:/, "Domain · "),
    tile: "SC",
  }),
};

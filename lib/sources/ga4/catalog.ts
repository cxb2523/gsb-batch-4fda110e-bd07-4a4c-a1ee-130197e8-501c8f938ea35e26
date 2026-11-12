import { z } from "zod";

import type { SourceCatalog } from "../types";

/**
 * Which Google Analytics 4 property a connection reads. Safe for the
 * browser: the service account key is the credential, never here.
 */

export const ga4ConfigSchema = z
  .object({
    /** The numeric property ID (Admin → Property settings). "properties/123" is accepted too. */
    propertyId: z
      .string()
      .trim()
      .transform((value) => value.replace(/^properties\//, ""))
      .pipe(z.string().regex(/^\d{4,15}$/, "Enter the numeric property ID from Admin → Property settings (not the G- measurement ID).")),
  })
  .strict();

export type Ga4Config = z.infer<typeof ga4ConfigSchema>;

export const ga4Catalog: SourceCatalog<Ga4Config, "ga4"> = {
  type: "ga4",
  label: "Google Analytics",
  blurb: "GA4 traffic, engagement and conversions",
  tile: "GA",
  configSchema: ga4ConfigSchema,
  describe: (config) => ({ source: "Google Analytics", shortSource: "GA4", detail: `Property ${config.propertyId}`, tile: "GA" }),
};

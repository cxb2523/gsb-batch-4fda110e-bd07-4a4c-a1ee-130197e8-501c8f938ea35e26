import { z } from "zod";

import type { SourceCatalog } from "../types";

/**
 * Which Google Cloud project runs (and pays for) the queries. Safe for the
 * browser: the service account key is the credential, never here.
 */

/** Project ids: 6–30 lowercase letters, digits and hyphens, optionally domain-scoped ("example.com:proj"). */
export const PROJECT_ID = /^(?:[a-z0-9.-]+:)?[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
/** Dataset ids: letters, digits and underscores. */
export const DATASET_ID = /^[A-Za-z0-9_]{1,1024}$/;

export const bigqueryConfigSchema = z
  .object({
    projectId: z.string().trim().regex(PROJECT_ID, "Enter the project ID, like my-project-123 (not its name or number)."),
    /** Where jobs run, e.g. "US", "EU", "us-central1". Empty: BigQuery works it out from the tables. */
    location: z
      .string()
      .trim()
      .max(40)
      .regex(/^[A-Za-z0-9-]*$/, "Enter a location like US, EU or us-central1.")
      .optional()
      .transform((value) => value || undefined),
  })
  .strict();

export type BigqueryConfig = z.infer<typeof bigqueryConfigSchema>;

export const bigqueryCatalog: SourceCatalog<BigqueryConfig, "bigquery"> = {
  type: "bigquery",
  label: "BigQuery",
  blurb: "Google BigQuery, with a read-only service account",
  tile: "BQ",
  configSchema: bigqueryConfigSchema,
  describe: (config) => ({
    source: "BigQuery",
    shortSource: "BigQuery",
    detail: config.location ? `${config.projectId} · ${config.location}` : config.projectId,
    tile: "BQ",
  }),
};

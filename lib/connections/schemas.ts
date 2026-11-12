import { z } from "zod";

/**
 * Shared input shapes. A source's own settings and credential are validated by
 * that source's schemas, which the service picks from the registry.
 */

export const connectionNameSchema = z
  .string()
  .trim()
  .min(1, "Enter a name.")
  .max(80, "Keep the name under 80 characters.");

export const connectionIdSchema = z.uuid();

/** `type` picks the source; the rest is checked against that source's schemas. */
export const createEnvelopeSchema = z.looseObject({
  type: z.string(),
  name: connectionNameSchema,
});

/** A new API key or password. Which one is checked against the saved connection's source. */
export const replaceCredentialSchema = z
  .object({ id: connectionIdSchema, credential: z.string() })
  .strict();

export const renameSchema = z.object({ id: connectionIdSchema, name: connectionNameSchema }).strict();
export const connectionRefSchema = z.object({ id: connectionIdSchema }).strict();

/** A demo dataset, by its key in config. */
export const demoRefSchema = z.object({ dataset: z.string().min(1).max(40) }).strict();

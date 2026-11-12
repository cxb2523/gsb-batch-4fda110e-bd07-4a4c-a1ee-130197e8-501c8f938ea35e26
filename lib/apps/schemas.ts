import { z } from "zod";

export const appIdSchema = z.uuid();

export const appNameSchema = z
  .string()
  .trim()
  .min(1, "Enter a name.")
  .max(80, "Keep the name under 80 characters.");

export const promptSchema = z
  .string()
  .trim()
  .min(1, "Describe what you want to build.")
  .max(4000, "Keep the prompt under 4,000 characters.");

/** OpenUI Cloud conversation ids. Anything else is refused before it reaches the database. */
export const threadIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, "Invalid thread id.");

export const threadTitleSchema = z
  .string()
  .trim()
  .max(200)
  .transform((title) => title || "New chat");

export const createAppSchema = z
  .object({
    prompt: promptSchema,
    connectionIds: z
      .array(z.uuid("Choose a data source."))
      .min(1, "Choose at least one data source.")
      .max(20)
      .transform((ids) => [...new Set(ids)]),
  })
  .strict();
export const renameAppSchema = z.object({ id: appIdSchema, name: appNameSchema }).strict();
export const appRefSchema = z.object({ id: appIdSchema }).strict();
export const addAppConnectionSchema = z.object({ appId: appIdSchema, connectionId: z.uuid() }).strict();

export const registerThreadSchema = z
  .object({ threadId: threadIdSchema, title: threadTitleSchema })
  .strict();
export const renameThreadSchema = z.object({ title: threadTitleSchema }).strict();

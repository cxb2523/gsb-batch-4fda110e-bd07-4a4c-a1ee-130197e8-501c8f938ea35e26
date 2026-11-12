import { z } from "zod";

import type { SourceCatalog } from "../types";

import { HOST_KINDS, POSTHOG_HOSTS } from "./hosts";

export const posthogConfigSchema = z
  .object({
    hostKind: z.enum(HOST_KINDS, { error: "Choose a region." }),
    projectId: z
      .string()
      .trim()
      .regex(/^\d{1,12}$/, "The project ID is a number. Find it in PostHog's project settings."),
  })
  .strict();

export type PostHogConfig = z.infer<typeof posthogConfigSchema>;

export const posthogCatalog: SourceCatalog<PostHogConfig, "posthog"> = {
  type: "posthog",
  label: "PostHog",
  blurb: "Events · Persons · Sessions · HogQL",
  tile: "PH",
  configSchema: posthogConfigSchema,
  describe(config) {
    const region = POSTHOG_HOSTS[config.hostKind].label;
    return {
      source: `PostHog · ${region}`,
      shortSource: `PostHog ${region.replace(" Cloud", "")}`,
      detail: `Project ${config.projectId}`,
      tile: "PH",
    };
  },
};

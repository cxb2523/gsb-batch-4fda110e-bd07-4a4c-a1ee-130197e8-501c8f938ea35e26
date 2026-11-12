import { metric } from "@vercel/functions";

/**
 * Counts one occurrence in Vercel Observability, where monitors alert on it.
 * Tagged with the environment because monitors can't filter custom metrics by
 * deployment environment. Keep attribute values to a small, fixed set.
 */
export function count(name: string, attributes: Record<string, string>): void {
  metric(name, 1, { ...attributes, env: process.env.VERCEL_ENV ?? "local" });
}

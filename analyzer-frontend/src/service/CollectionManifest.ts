import { shallowRef } from "vue";

export type ManifestItemStatus = "read" | "missing" | "failed";

export type ManifestItemKind =
  | "contacts"
  | "groups"
  | "contact-messages"
  | "group-messages";

export interface ManifestItem {
  filename: string;
  kind: ManifestItemKind;
  status: ManifestItemStatus;
  /** Rows successfully parsed and accepted. */
  recordCount: number;
  /** Rows skipped by rule (missing body or type other than TEXT). */
  skippedCount: number;
  /** Rows that could not be parsed, e.g. invalid posted_at timestamps. */
  failedCount: number;
  /** Human-readable details, e.g. failure reasons and offending rows. */
  detail?: string;
}

export interface ManifestSummary {
  total: number;
  read: number;
  missing: number;
  failed: number;
  recordCount: number;
  skippedCount: number;
  failedCount: number;
  allSuccess: boolean;
}

export interface CollectionManifest {
  zipName: string;
  startedAt: string;
  finishedAt: string;
  items: ManifestItem[];
  summary: ManifestSummary;
}

function buildSummary(items: ManifestItem[]): ManifestSummary {
  const summary: ManifestSummary = {
    total: items.length,
    read: items.filter((i) => i.status === "read").length,
    missing: items.filter((i) => i.status === "missing").length,
    failed: items.filter((i) => i.status === "failed").length,
    recordCount: items.reduce((sum, i) => sum + i.recordCount, 0),
    skippedCount: items.reduce((sum, i) => sum + i.skippedCount, 0),
    failedCount: items.reduce((sum, i) => sum + i.failedCount, 0),
    allSuccess: false,
  };
  summary.allSuccess =
    items.length > 0 &&
    summary.missing === 0 &&
    summary.failed === 0 &&
    summary.failedCount === 0;
  return summary;
}

export function createManifest(
  zipName: string,
  items: ManifestItem[],
  startedAt: string,
): CollectionManifest {
  return {
    zipName,
    startedAt,
    finishedAt: new Date().toISOString(),
    items,
    summary: buildSummary(items),
  };
}

export function createEmptyManifest(zipName: string): CollectionManifest {
  const now = new Date().toISOString();
  return {
    zipName,
    startedAt: now,
    finishedAt: now,
    items: [],
    summary: buildSummary([]),
  };
}

/**
 * Reactive holder for the manifest of the most recently collected backup.
 * Reset on every upload so counts from two uploads can never accumulate.
 */
const manifestRef = shallowRef<CollectionManifest | null>(null);

export function getManifest(): CollectionManifest | null {
  return manifestRef.value;
}

export function setManifest(manifest: CollectionManifest): void {
  manifestRef.value = manifest;
}

export function resetManifest(zipName: string): CollectionManifest {
  const empty = createEmptyManifest(zipName);
  manifestRef.value = empty;
  return empty;
}

export { manifestRef };

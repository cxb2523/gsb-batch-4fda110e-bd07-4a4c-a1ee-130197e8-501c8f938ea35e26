/**
 * A checkable summary of a cursor-paged catalog collection.
 *
 * The target catalog comes back page by page from
 * `GET /api/v1/gateway-catalog`: every page carries `items` and, while
 * more rows exist, a `next_cursor`. Infinite scroll alone can't tell
 * "no more pages" from "a page failed and the cursor was lost", so this
 * module keeps the running tally the page needs to answer that:
 *
 *   - how many rows the server actually returned (`totalCount`),
 *   - how many distinct rows survive after dedupe (`uniqueCount`),
 *   - whether the collection reached the natural end (`complete`),
 *   - and why it stopped, when it stopped early (`interruptionReason`).
 *
 * The module is transport-agnostic: it takes the page payloads the hook
 * already holds, so it runs both in the browser and under node:test
 * with no React involved.
 */

import type { CatalogItem } from '../api/gateways';

/** One GET /api/v1/gateway-catalog page (the shape the hook already types). */
export interface CatalogPageInput {
  items: CatalogItem[] | null;
  next_cursor?: string;
}

/** Why a collection stopped before reaching the natural end. */
export type CatalogInterruptionReason = 'page_failed' | 'cursor_lost';

/** A failure recorded for a page that never returned a payload. */
export interface CatalogPageFailure {
  /** 1-based position of the page the collection was asking for. */
  page: number;
  /** The reason the fetch failed, such as an HTTP status or a network error. */
  reason: string;
}

/** The checkable result of a collection in progress or at rest. */
export interface CatalogCollectionSummary {
  /** Every row the server returned across all successful pages, duplicates counted. */
  totalCount: number;
  /** Distinct rows, keyed by connector_uuid/target_id, in first-seen order. */
  uniqueCount: number;
  /**
   * True only when a page returned without a `next_cursor`: every
   * matching row has been seen. A failed page, or a page whose cursor
   * disappeared, leaves this false so the UI never reads a gap as
   * "no more".
   */
  complete: boolean;
  /** Set whenever `complete` is false for a reason other than "still paging". */
  interruptionReason: CatalogInterruptionReason | null;
  /** The failure that stopped the collection, if a page request failed. */
  failure: CatalogPageFailure | null;
  /** 1-based number of the last successful page (0 before any page lands). */
  loadedPages: number;
  /** Rows dropped because the same key had already been seen. */
  duplicateCount: number;
  /** The cursor to ask for next, or null when nothing more can be asked. */
  nextCursor: string | null;
  /** The de-duplicated rows themselves, in first-seen order. */
  items: CatalogItem[];
}

/** The stable identity of a catalog row: one connector's one target. */
export function catalogItemKey(item: CatalogItem): string {
  return `${item.connector_uuid}/${item.target_id}`;
}

function describeReason(reason: unknown): string {
  if (typeof reason === 'string' && reason.trim()) return reason;
  if (reason instanceof Error && reason.message) return reason.message;
  return 'Network error.';
}

/**
 * Accumulate catalog pages one at a time. A failed page is remembered,
 * not thrown away: the rows already loaded stay visible, and retrying
 * the same page only appends rows whose key hasn't been seen, so a
 * retry can never insert the same entry twice.
 */
export class CatalogCollectionAccumulator {
  private readonly seen = new Set<string>();
  private readonly rows: CatalogItem[] = [];
  private total = 0;
  private duplicates = 0;
  private pages = 0;
  private cursor: string | null = null;
  private finished = false;
  private failure: CatalogPageFailure | null = null;
  private lostCursor = false;

  /** Fold one successful page into the collection. */
  appendPage(page: CatalogPageInput): void {
    this.pages += 1;
    this.failure = null;
    this.lostCursor = false;
    for (const item of page.items ?? []) {
      this.total += 1;
      const key = catalogItemKey(item);
      if (this.seen.has(key)) {
        this.duplicates += 1;
        continue;
      }
      this.seen.add(key);
      this.rows.push(item);
    }
    if (page.next_cursor) {
      this.cursor = page.next_cursor;
    } else {
      // The natural end: the server holds no further page.
      this.cursor = null;
      this.finished = true;
    }
  }

  /**
   * Record a page that never returned a payload. The cursor for the
   * retry is kept, and the already-loaded rows are untouched.
   */
  recordFailure(reason: unknown, opts: { cursorLost?: boolean } = {}): void {
    this.failure = { page: this.pages + 1, reason: describeReason(reason) };
    if (opts.cursorLost) {
      this.lostCursor = true;
      this.cursor = null;
    }
  }

  /** The cursor the next request must carry, if any. */
  get nextCursor(): string | null {
    return this.failure ? this.cursor : this.finished ? null : this.cursor;
  }

  /** The snapshot the UI renders against. */
  get summary(): CatalogCollectionSummary {
    const interrupted: CatalogInterruptionReason | null = this.failure
      ? this.lostCursor
        ? 'cursor_lost'
        : 'page_failed'
      : null;
    return {
      totalCount: this.total,
      uniqueCount: this.rows.length,
      // A collection is whole only at the natural end. A first page
      // that is still loading reads as incomplete with no reason yet.
      complete: this.finished,
      interruptionReason: interrupted,
      failure: this.failure,
      loadedPages: this.pages,
      duplicateCount: this.duplicates,
      nextCursor: this.nextCursor,
      items: [...this.rows],
    };
  }
}

/**
 * One-shot summary for a fixed sequence of pages plus an optional
 * terminal failure. Mirrors the accumulator so callers that already
 * hold every page (and the tests) don't have to drive the state
 * machine themselves.
 */
export function summarizeCatalogCollection(
  pages: Iterable<CatalogPageInput>,
  failure?: CatalogPageFailure | null,
  opts: { cursorLost?: boolean } = {},
): CatalogCollectionSummary {
  const acc = new CatalogCollectionAccumulator();
  for (const page of pages) acc.appendPage(page);
  if (failure) acc.recordFailure(failure.reason, opts);
  return acc.summary;
}

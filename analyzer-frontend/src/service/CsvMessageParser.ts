import Papa from "papaparse";

export interface ParsedMessageRow {
  body: string;
  type: string;
  postedAt: number;
  identity: string | null;
  isOutbox: boolean;
  /** 1-based row number inside the CSV, header counted as row 1. */
  rowNumber: number;
}

export interface RowFailure {
  rowNumber: number;
  reason: string;
  postedAtRaw?: string;
}

export interface MessageParseResult {
  records: ParsedMessageRow[];
  /** Rows accepted as valid text messages. */
  recordCount: number;
  /** Rows skipped by rule: missing body or a type other than TEXT. */
  skippedCount: number;
  /** Rows rejected because their posted_at is not a valid timestamp. */
  failedCount: number;
  failures: RowFailure[];
}

/**
 * Strictly parse a posted_at value into epoch milliseconds.
 *
 * Returns null for anything that is not a finite integer timestamp so that
 * malformed values can be reported instead of silently turning into the
 * 1970 epoch (the old `new Date(parseInt(...))` behaviour mapped garbage
 * such as "not-a-number" to 1970-01-01).
 */
export function parseMessageTimestamp(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;

  const text = String(raw).trim();
  if (text === "" || !/^[+-]?\d+$/.test(text)) return null;

  const millis = Number(text);
  if (!Number.isFinite(millis) || Number.isNaN(new Date(millis).getTime())) {
    return null;
  }
  return millis;
}

function isOutboxValue(raw: unknown): boolean {
  return raw === "1" || raw === 1;
}

/**
 * Parse a message CSV (both message_<id>.csv and group_message_<uid>.csv
 * share the same relevant columns).
 *
 * Rows without a body or whose type is not TEXT are skipped and counted.
 * Rows whose posted_at cannot be parsed as a timestamp are failed and
 * counted, never coerced to 1970. Parsing never throws for bad rows; only
 * a fundamentally unreadable CSV would make Papa report an error.
 */
export function parseMessageCsv(csvContent: string): MessageParseResult {
  const parsed = Papa.parse<Record<string, unknown>>(csvContent, {
    header: true,
    skipEmptyLines: true,
  });

  const result: MessageParseResult = {
    records: [],
    recordCount: 0,
    skippedCount: 0,
    failedCount: 0,
    failures: [],
  };

  for (const [index, row] of parsed.data.entries()) {
    const rowNumber = index + 2; // header is row 1
    const body = row.body;
    const type = row.type === undefined || row.type === null ? "" : String(row.type);

    // Existing skip rules: missing body ...
    if (!body) {
      result.skippedCount++;
      continue;
    }
    // ... or a non-TEXT type. A missing type is treated as TEXT.
    if (type.trim() !== "" && type.trim().toUpperCase() !== "TEXT") {
      result.skippedCount++;
      continue;
    }

    const postedAtRaw = row.posted_at;
    const postedAt = parseMessageTimestamp(postedAtRaw);
    if (postedAt === null) {
      result.failedCount++;
      result.failures.push({
        rowNumber,
        reason: "posted_at is not a valid timestamp",
        postedAtRaw:
          postedAtRaw === undefined || postedAtRaw === null
            ? undefined
            : String(postedAtRaw),
      });
      continue;
    }

    result.records.push({
      body: String(body),
      type: type.trim().toUpperCase(),
      postedAt,
      identity:
        row.identity === undefined || row.identity === null
          ? null
          : String(row.identity),
      isOutbox: isOutboxValue(row.isoutbox),
      rowNumber,
    });
  }

  result.recordCount = result.records.length;
  return result;
}

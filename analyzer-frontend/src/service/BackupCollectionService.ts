import Papa from "papaparse";
import { getZipFile, listFiles } from "./FileService";
import { parseMessageCsv } from "./CsvMessageParser";
import {
  createManifest,
  type CollectionManifest,
  type ManifestItem,
  type ManifestItemKind,
} from "./CollectionManifest";

const CONTACTS_FILENAME = "contacts.csv";
const GROUPS_FILENAME = "groups.csv";
const CONTACT_MESSAGE_PREFIX = "message_";
const GROUP_MESSAGE_PREFIX = "group_message_";
const CONTACTS_MIN_COLUMNS = 11;
const GROUPS_MIN_COLUMNS = 11;

type RawRows = string[][];

async function readRawRows(filename: string): Promise<RawRows | null> {
  const entry = getZipFile(filename);
  if (!entry) return null;

  const text = await entry.content.text();
  const parsed = Papa.parse<string[]>(text, {
    header: false,
    skipEmptyLines: true,
  });
  return parsed.data;
}

function buildBaseItem(
  filename: string,
  kind: ManifestItemKind,
): ManifestItem {
  return {
    filename,
    kind,
    status: "read",
    recordCount: 0,
    skippedCount: 0,
    failedCount: 0,
  };
}

async function collectTableItem(
  filename: string,
  kind: ManifestItemKind,
  minColumns: number,
  idColumnIndex: number,
): Promise<{ item: ManifestItem; ids: string[] }> {
  const item = buildBaseItem(filename, kind);

  let rows: RawRows | null;
  try {
    rows = await readRawRows(filename);
  } catch (error) {
    item.status = "failed";
    item.detail = `Failed to read file: ${errorMessage(error)}`;
    return { item, ids: [] };
  }

  if (rows === null) {
    item.status = "missing";
    item.detail = "File not found in backup";
    return { item, ids: [] };
  }

  const ids: string[] = [];
  // First row is the header.
  for (const row of rows.slice(1)) {
    if (row.length < minColumns) {
      item.skippedCount++;
      continue;
    }
    item.recordCount++;
    const id = (row[idColumnIndex] ?? "").toString().trim();
    if (id) ids.push(id);
  }

  if (item.skippedCount > 0) {
    item.detail = `${item.skippedCount} row(s) skipped (too few columns)`;
  }
  return { item, ids };
}

async function collectMessageItem(
  filename: string,
  kind: ManifestItemKind,
): Promise<ManifestItem> {
  const item = buildBaseItem(filename, kind);

  let csvContent: string;
  try {
    const entry = getZipFile(filename);
    if (!entry) {
      item.status = "missing";
      item.detail = "File not found in backup";
      return item;
    }
    csvContent = await entry.content.text();
  } catch (error) {
    item.status = "failed";
    item.detail = `Failed to read file: ${errorMessage(error)}`;
    return item;
  }

  try {
    const parsed = parseMessageCsv(csvContent);
    item.recordCount = parsed.recordCount;
    item.skippedCount = parsed.skippedCount;
    item.failedCount = parsed.failedCount;

    const notes: string[] = [];
    if (parsed.skippedCount > 0) {
      notes.push(
        `${parsed.skippedCount} row(s) skipped (missing body or non-TEXT type)`,
      );
    }
    if (parsed.failures.length > 0) {
      // The file itself was readable, but one or more rows could not be
      // parsed. Mark the file as failed so the problem cannot be missed.
      item.status = "failed";
      for (const failure of parsed.failures.slice(0, 10)) {
        const raw =
          failure.postedAtRaw === undefined
            ? ""
            : ` (raw: "${failure.postedAtRaw}")`;
        notes.push(
          `row ${failure.rowNumber}: ${failure.reason}${raw}`,
        );
      }
      if (parsed.failures.length > 10) {
        notes.push(`...and ${parsed.failures.length - 10} more failed row(s)`);
      }
    }
    if (notes.length > 0) item.detail = notes.join("; ");
  } catch (error) {
    item.status = "failed";
    item.detail = `Failed to parse file: ${errorMessage(error)}`;
  }

  return item;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

function mergeExpectedAndPresent(
  expected: string[],
  present: string[],
): string[] {
  return Array.from(new Set([...expected, ...present])).sort();
}

/**
 * Walk every expected data file of an unpacked backup and build a
 * checkable collection manifest. Each file is handled independently so a
 * single failure never blocks collection of the remaining files.
 */
export async function collectBackup(zipName: string): Promise<CollectionManifest> {
  const startedAt = new Date().toISOString();
  const items: ManifestItem[] = [];

  // Contacts and groups also tell us which message files to expect.
  const contactsResult = await collectTableItem(
    CONTACTS_FILENAME,
    "contacts",
    CONTACTS_MIN_COLUMNS,
    10,
  );
  items.push(contactsResult.item);

  const groupsResult = await collectTableItem(
    GROUPS_FILENAME,
    "groups",
    GROUPS_MIN_COLUMNS,
    9,
  );
  items.push(groupsResult.item);

  const expectedContactMessageFiles = contactsResult.ids.map(
    (id) => `${CONTACT_MESSAGE_PREFIX}${id}.csv`,
  );
  const expectedGroupMessageFiles = groupsResult.ids.map(
    (uid) => `${GROUP_MESSAGE_PREFIX}${uid}.csv`,
  );

  const presentContactMessageFiles = listFiles().filter(
    (f) => f.startsWith(CONTACT_MESSAGE_PREFIX) && f.endsWith(".csv"),
  );
  const presentGroupMessageFiles = listFiles().filter(
    (f) => f.startsWith(GROUP_MESSAGE_PREFIX) && f.endsWith(".csv"),
  );

  const contactMessageFiles = mergeExpectedAndPresent(
    expectedContactMessageFiles,
    presentContactMessageFiles,
  );
  const groupMessageFiles = mergeExpectedAndPresent(
    expectedGroupMessageFiles,
    presentGroupMessageFiles,
  );

  for (const filename of contactMessageFiles) {
    items.push(await collectMessageItem(filename, "contact-messages"));
  }
  for (const filename of groupMessageFiles) {
    items.push(await collectMessageItem(filename, "group-messages"));
  }

  return createManifest(zipName, items, startedAt);
}

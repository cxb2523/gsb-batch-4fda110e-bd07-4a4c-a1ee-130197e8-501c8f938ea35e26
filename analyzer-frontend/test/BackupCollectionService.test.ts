import { beforeEach, describe, expect, it } from "vitest";
import {
  handleZipUpload,
  getZipFile,
  listFiles,
} from "@/service/FileService";
import { collectBackup } from "@/service/BackupCollectionService";
import {
  getManifest,
  resetManifest,
  setManifest,
  type CollectionManifest,
} from "@/service/CollectionManifest";
import { resetIdentityCaches } from "@/service/IdentityService";
import {
  buildZip,
  contactsCsv,
  groupsCsv,
  messageCsv,
  textRow,
} from "./helpers/zipBuilder";

const CONTACT_ID = "ECHOECHO";
const GROUP_UID = "group-uid-1";
const CONTACT_MESSAGE_FILE = `message_${CONTACT_ID}.csv`;
const GROUP_MESSAGE_FILE = `group_message_${GROUP_UID}.csv`;

function fullBackupFiles(): Record<string, string> {
  return {
    "contacts.csv": contactsCsv([
      { identity: "ECHO", identityId: CONTACT_ID, firstName: "Echo" },
    ]),
    "groups.csv": groupsCsv([
      { id: "group-row-1", uid: GROUP_UID, name: "Test Group" },
    ]),
    [CONTACT_MESSAGE_FILE]: messageCsv([
      textRow("hello", "1700000000000", { isoutbox: "0", identity: "ECHO" }),
      textRow("world", "1700000060000", { isoutbox: "1", identity: "" }),
    ]),
    [GROUP_MESSAGE_FILE]: messageCsv([
      textRow("group hello", "1700000100000", { identity: "ECHO" }),
    ]),
    "contact_profile_pic_ECHOECHO": "not-a-real-image",
  };
}

function byFilename(manifest: CollectionManifest) {
  return new Map(manifest.items.map((item) => [item.filename, item]));
}

beforeEach(() => {
  resetManifest("");
  resetIdentityCaches();
});

describe("backup collection manifest", () => {
  it("scenario 1: all expected files present and fully parsed", async () => {
    const zip = await buildZip(fullBackupFiles());

    await handleZipUpload(zip);
    const manifest = await collectBackup(zip.name);

    expect(manifest.zipName).toBe("backup.zip");
    expect(manifest.summary.allSuccess).toBe(true);
    expect(manifest.summary.missing).toBe(0);
    expect(manifest.summary.failed).toBe(0);
    expect(manifest.summary.failedCount).toBe(0);

    const items = byFilename(manifest);
    expect(items.size).toBe(4);

    expect(items.get("contacts.csv")).toMatchObject({
      status: "read",
      recordCount: 1,
      skippedCount: 0,
      failedCount: 0,
    });
    expect(items.get("groups.csv")).toMatchObject({
      status: "read",
      recordCount: 1,
    });
    expect(items.get(CONTACT_MESSAGE_FILE)).toMatchObject({
      status: "read",
      recordCount: 2,
      skippedCount: 0,
      failedCount: 0,
    });
    expect(items.get(GROUP_MESSAGE_FILE)).toMatchObject({
      status: "read",
      recordCount: 1,
    });

    // Non-data files (avatars) are not part of the manifest.
    expect(items.has("contact_profile_pic_ECHOECHO")).toBe(false);
  });

  it("scenario 2: missing files are reported per file and do not block others", async () => {
    const files = fullBackupFiles();
    delete files[CONTACT_MESSAGE_FILE];
    delete files["groups.csv"];
    const zip = await buildZip(files);

    await handleZipUpload(zip);
    const manifest = await collectBackup(zip.name);

    expect(manifest.summary.allSuccess).toBe(false);
    expect(manifest.summary.missing).toBe(2);
    expect(manifest.summary.read).toBe(2);

    const items = byFilename(manifest);
    expect(items.get(CONTACT_MESSAGE_FILE)).toMatchObject({
      status: "missing",
      recordCount: 0,
      detail: expect.stringContaining("not found"),
    });
    expect(items.get("groups.csv")).toMatchObject({ status: "missing" });

    // Files that do exist were still collected successfully.
    expect(items.get("contacts.csv").status).toBe("read");
    expect(items.get(GROUP_MESSAGE_FILE).status).toBe("read");
  });

  it("scenario 3: bad posted_at rows fail and are attributed to their file", async () => {
    const files = fullBackupFiles();
    files[CONTACT_MESSAGE_FILE] = messageCsv([
      textRow("good row", "1700000000000", { identity: "ECHO" }),
      textRow("bad timestamp", "not-a-timestamp", { identity: "ECHO" }),
      textRow("", "1700000120000", { identity: "ECHO" }), // missing body -> skipped
      { body: "image", posted_at: "1700000180000", type: "IMAGE", identity: "ECHO" },
    ]);
    const zip = await buildZip(files);

    await handleZipUpload(zip);
    const manifest = await collectBackup(zip.name);

    const items = byFilename(manifest);
    const contactMessages = items.get(CONTACT_MESSAGE_FILE);

    expect(contactMessages.status).toBe("failed");
    expect(contactMessages.recordCount).toBe(1);
    expect(contactMessages.failedCount).toBe(1);
    expect(contactMessages.skippedCount).toBe(2);
    expect(contactMessages.detail).toContain("row 3");
    expect(contactMessages.detail).toContain("not-a-timestamp");

    expect(manifest.summary.allSuccess).toBe(false);
    expect(manifest.summary.failedCount).toBe(1);

    // Other files remain unaffected.
    expect(items.get(GROUP_MESSAGE_FILE).status).toBe("read");
    expect(items.get("contacts.csv").status).toBe("read");
  });

  it("scenario 4: re-uploading a same-named ZIP fully replaces old data and resets the manifest", async () => {
    // First upload: complete backup.
    const firstZip = await buildZip(fullBackupFiles());
    await handleZipUpload(firstZip);
    const firstManifest = await collectBackup(firstZip.name);
    // ApiService.uploadZip stores the manifest the same way after collection.
    setManifest(firstManifest);

    expect(firstManifest.summary.allSuccess).toBe(true);
    expect(getManifest()?.summary.recordCount).toBe(5);
    // Sanity check: the first extraction really holds the message files.
    expect(getZipFile(CONTACT_MESSAGE_FILE)).toBeDefined();
    expect(listFiles()).toContain(GROUP_MESSAGE_FILE);

    // Second upload under the same file name but without the message files.
    const reducedFiles = fullBackupFiles();
    delete reducedFiles[CONTACT_MESSAGE_FILE];
    delete reducedFiles[GROUP_MESSAGE_FILE];
    const secondZip = new File(
      [await (await buildZip(reducedFiles)).arrayBuffer()],
      "backup.zip",
      { type: "application/zip" },
    );

    await handleZipUpload(secondZip);
    const secondManifest = await collectBackup(secondZip.name);
    setManifest(secondManifest);

    // Counts must reflect only the second upload — nothing accumulates.
    expect(secondManifest.zipName).toBe("backup.zip");
    expect(secondManifest.summary.missing).toBe(2);
    expect(secondManifest.items).toHaveLength(4);
    expect(secondManifest.summary.recordCount).toBe(2);
    expect(
      secondManifest.items.some(
        (item) => item.recordCount > 0 && item.filename.includes("message_"),
      ),
    ).toBe(false);

    // The reactive manifest store holds exactly the reset second result.
    const stored = getManifest();
    expect(stored?.summary.missing).toBe(2);
    expect(stored?.items).toHaveLength(4);

    // No entry of the first extraction may survive in the file store.
    expect(getZipFile(CONTACT_MESSAGE_FILE)).toBeUndefined();
    expect(getZipFile(GROUP_MESSAGE_FILE)).toBeUndefined();
    expect(listFiles()).not.toContain(CONTACT_MESSAGE_FILE);
    expect(listFiles()).not.toContain(GROUP_MESSAGE_FILE);
  });
});

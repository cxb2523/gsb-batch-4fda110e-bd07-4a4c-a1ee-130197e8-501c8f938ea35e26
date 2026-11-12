import { describe, it, expect, vi } from "vitest";

// The real upload flow touches toast notifications; stub the DOM-only lib.
vi.mock("vue3-toastify", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { uploadZip } from "@/service/ApiService";
import { getManifest } from "@/service/CollectionManifest";
import { getZipFile } from "@/service/FileService";
import {
  buildZip,
  contactsCsv,
  groupsCsv,
  messageCsv,
  textRow,
} from "./helpers/zipBuilder";

describe("ApiService.uploadZip end-to-end", () => {
  it("collects a full backup and stores the manifest", async () => {
    const zip = await buildZip({
      "contacts.csv": contactsCsv([
        { identity: "E", identityId: "ID1", firstName: "F" },
      ]),
      "groups.csv": groupsCsv([{ id: "g", uid: "u1", name: "N" }]),
      "message_ID1.csv": messageCsv([
        textRow("hi", "1700000000000", { identity: "E" }),
      ]),
      "group_message_u1.csv": messageCsv([
        textRow("group hi", "1700000100000", { identity: "E" }),
      ]),
    });

    await uploadZip(zip, "pw");

    const manifest = getManifest();
    expect(manifest).not.toBeNull();
    expect(manifest!.zipName).toBe("backup.zip");
    expect(manifest!.summary.allSuccess).toBe(true);
    expect(
      manifest!.items.map((item) => item.filename).sort(),
    ).toEqual(
      [
        "contacts.csv",
        "groups.csv",
        "message_ID1.csv",
        "group_message_u1.csv",
      ].sort(),
    );
    expect(getZipFile("contacts.csv")).toBeDefined();
  });

  it("surfaces a missing group message file instead of showing an empty session silently", async () => {
    const zip = await buildZip({
      "contacts.csv": contactsCsv([
        { identity: "E", identityId: "ID1", firstName: "F" },
      ]),
      "groups.csv": groupsCsv([{ id: "g", uid: "u1", name: "N" }]),
      "message_ID1.csv": messageCsv([
        textRow("hi", "1700000000000", { identity: "E" }),
      ]),
    });

    await uploadZip(zip, "pw");

    const manifest = getManifest()!;
    expect(manifest.summary.allSuccess).toBe(false);
    const missingGroupMessages = manifest.items.find(
      (item) => item.filename === "group_message_u1.csv",
    );
    expect(missingGroupMessages).toMatchObject({ status: "missing" });
  });
});

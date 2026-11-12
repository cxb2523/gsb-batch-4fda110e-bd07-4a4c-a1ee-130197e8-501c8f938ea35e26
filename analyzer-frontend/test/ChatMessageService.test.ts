import { beforeEach, describe, expect, it, vi } from "vitest";

// loadAllChats pulls in contacts/groups via ApiService; stub the heavy
// branches so the test stays focused on message parsing behaviour.
vi.mock("@/service/ApiService", () => ({
  loadContacts: vi.fn(async () => [
    {
      identity: {
        identity: "ECHO",
        identityID: "ECHOECHO",
        firstName: "Echo",
      },
      totalMessageCount: 0,
      contactMessageCount: 0,
      yourMessageCount: 0,
    },
  ]),
  loadGroups: vi.fn(async () => []),
}));

import { handleZipUpload } from "@/service/FileService";
import { loadAllChats } from "@/service/ChatMessageService";
import { resetIdentityCaches } from "@/service/IdentityService";
import { buildZip, contactsCsv } from "./helpers/zipBuilder";

const MESSAGE_HEADER =
  "id,session_id,isoutbox,issaved,send_status,body,posted_at,edited_at,delivered_at,read_at,type,identity";

describe("loadAllChats timestamp handling", () => {
  beforeEach(() => {
    resetIdentityCaches();
  });

  it("never emits a 1970 date for an unparseable posted_at and keeps skipping rules", async () => {
    const csv = [
      MESSAGE_HEADER,
      "1,s,0,0,SENT,valid message,1700000000000,,,,TEXT,ECHO",
      "2,s,0,0,SENT,broken timestamp,not-a-date,,,,TEXT,ECHO",
      "3,s,0,0,SENT,,1700000120000,,,,TEXT,ECHO",
      "4,s,0,0,SENT,an image,1700000180000,,,,IMAGE,ECHO",
    ].join("\n");

    const zip = await buildZip({
      "contacts.csv": contactsCsv([
        { identity: "ECHO", identityId: "ECHOECHO", firstName: "Echo" },
      ]),
      "message_ECHOECHO.csv": csv,
    });

    await handleZipUpload(zip);
    const chats = await loadAllChats();

    const contactChat = chats.find((chat) => chat.id === "ECHOECHO");
    expect(contactChat).toBeDefined();
    expect(contactChat!.messages).toHaveLength(1);
    expect(contactChat!.messages[0].text).toBe("valid message");

    // The old behaviour turned garbage into 1970-01-01; it must be gone.
    expect(
      contactChat!.messages.some((m) => m.date.startsWith("1970-01-01")),
    ).toBe(false);
    expect(contactChat!.messages[0].date).toBe(
      new Date(1700000000000).toISOString(),
    );
  });

  it("returns an empty chat when the contact message file is missing", async () => {
    const zip = await buildZip({
      "contacts.csv": contactsCsv([
        { identity: "ECHO", identityId: "ECHOECHO", firstName: "Echo" },
      ]),
    });

    await handleZipUpload(zip);
    const chats = await loadAllChats();
    const contactChat = chats.find((chat) => chat.id === "ECHOECHO");
    expect(contactChat?.messages ?? []).toHaveLength(0);
  });
});

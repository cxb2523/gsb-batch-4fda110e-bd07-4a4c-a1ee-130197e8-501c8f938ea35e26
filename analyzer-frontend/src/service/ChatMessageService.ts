import { getZipFile, ZipFileEntry } from "./FileService";
import { parseMessageCsv } from "./CsvMessageParser";
import { ModelsChat, ChatMessage } from "@/models/ModelsChat";
import { loadContacts, loadGroups } from "./ApiService";
import { ModelsContact } from "@/models/ModelsContact";
import { ModelsGroup } from "@/models/ModelsGroup";
import { ModelsIdentity } from "@/models/ModelsIdentity";
import { loadIdentityByUserID } from "./IdentityService";

const USER_MESSAGE_PATH = "message_";
const GROUP_MESSAGE_PATH = "group_message_";

export async function loadAllChats(): Promise<ModelsChat[]> {
  const allChats: ModelsChat[] = [];

  const contacts: ModelsContact[] = await loadContacts();
  const groups: ModelsGroup[] = await loadGroups();

  for (const contact of contacts) {
    const contactId = contact.identity.identityID;
    const messages = await loadContactChatMessages(contactId, contact.identity);
    allChats.push({
      id: contactId,
      messages: messages,
    });
  }
  console.info(`Loaded contact chats.`, allChats);
  for (const group of groups) {
    const groupUUID = group.groupUid;
    const messages = await loadGroupChatMessages(groupUUID);
    allChats.push({
      id: groupUUID,
      messages: messages,
    });
  }
  console.info(`Loaded group chats.`, allChats);
  return allChats;
}

async function loadGroupChatMessages(
  groupUUID: string,
): Promise<ChatMessage[]> {
  const file: ZipFileEntry | undefined = await getZipFile(
    `${GROUP_MESSAGE_PATH}${groupUUID}.csv`,
  );
  if (!file) return [];
  const text = await file.content.text();
  return await parseGroupMessageFromCsv(text);
}

async function parseGroupMessageFromCsv(
  csvContent: string,
): Promise<ChatMessage[]> {
  const messages: ChatMessage[] = [];
  const parsed = parseMessageCsv(csvContent);

  for (const row of parsed.records) {
    // Determine sender
    let sender: ModelsIdentity;
    if (row.isOutbox) {
      sender = {
        identity: "You",
        identityID: "You",
        firstName: "You",
      };
    } else if (row.identity !== null) {
      // Resolve identity by user id
      try {
        sender = await loadIdentityByUserID(row.identity);
      } catch (error) {
        sender = { identity: "", identityID: "", firstName: "" };
      }
    } else {
      sender = { identity: "", identityID: "", firstName: "" };
    }

    messages.push({
      sender,
      text: row.body,
      date: new Date(row.postedAt).toISOString(),
    });
  }

  return messages;
}

async function loadContactChatMessages(
  contactId: string,
  contactIdentity: ModelsIdentity,
): Promise<ChatMessage[]> {
  const file: ZipFileEntry | undefined = await getZipFile(
    `${USER_MESSAGE_PATH}${contactId}.csv`,
  );
  if (!file) return [];
  const text = await file.content.text();
  return parseContactMessageFromCsv(text, contactIdentity);
}

function parseContactMessageFromCsv(
  csvContent: string,
  contactIdentity: ModelsIdentity | null,
): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const parsed = parseMessageCsv(csvContent);

  for (const row of parsed.records) {
    // Determine sender
    let sender: ModelsIdentity;
    if (row.isOutbox) {
      sender = {
        identity: "You",
        identityID: "You",
        firstName: "You",
      };
    } else if (contactIdentity) {
      sender = contactIdentity;
    } else {
      continue;
    }

    messages.push({
      sender,
      text: row.body,
      date: new Date(row.postedAt).toISOString(),
    });
  }

  return messages;
}

import { toast } from "vue3-toastify";
import * as groupService from "./GroupService";
import * as AvatarService from "./AvatarService";
import * as WordCloudService from "./WordCloudService";
import * as ContactService from "./ContactService";
import * as FileService from "./FileService";
import * as GroupTimelineService from "./GroupTimelineService";
import * as ContactTimelineService from "./ContactTimelineService";
import * as ChatMessageService from "./ChatMessageService";
import * as BackupCollectionService from "./BackupCollectionService";
import { resetIdentityCaches } from "./IdentityService";
import { setManifest, createEmptyManifest } from "./CollectionManifest";

import { AvatarIdGetTypeEnum } from "../models/AvatarIdGetTypeEnum";
import { ModelsContactTimeline } from "@/models/ModelsContactTimeline";

import { ModelsChat } from "@/models/ModelsChat";
import { ModelsContact } from "@/models/ModelsContact";
import { ModelsGroup } from "@/models/ModelsGroup";
import { ModelsGroupTimeline } from "@/models/ModelsGroupTimeline";
import { ModelsWordCount } from "@/models/ModelsWordCount";

export async function loadGroupTimeline(
  groupName: string,
): Promise<ModelsGroupTimeline[]> {
  try {
    return await GroupTimelineService.getGroupTimeline(groupName);
  } catch (err) {
    toast.error(`Failed to load group timeline for "${groupName}"`);
    console.error(err);
    return [];
  }
}

export async function loadContactTimeline(
  userId: string,
): Promise<ModelsContactTimeline[]> {
  try {
    return await ContactTimelineService.getContactTimeline(userId);
  } catch (err) {
    toast.error(`Failed to load contact timeline for user "${userId}"`);
    console.error(err);
    return [];
  }
}

export async function loadWordCloudData(): Promise<ModelsWordCount[]> {
  try {
    return await WordCloudService.getWordCount(100);
  } catch (err) {
    toast.error("Failed to load word cloud data");
    console.error(err);
    return [];
  }
}

export async function loadContacts(): Promise<ModelsContact[]> {
  try {
    return await ContactService.loadContacts();
  } catch (err) {
    toast.error("Failed to load contacts");
    console.error(err);
    return [];
  }
}

export async function loadAvatar(
  avatarType: AvatarIdGetTypeEnum,
  imageID: string,
): Promise<Blob> {
  try {
    return await AvatarService.getAvatar(avatarType, imageID);
  } catch (err) {
    toast.error(`Failed to load avatar ${imageID}`);
    console.error(err);
    throw err;
  }
}

export async function loadGroups(): Promise<ModelsGroup[]> {
  try {
    var result = await groupService.loadGroupsWithMessageCounts("groups.csv");
    console.info(result);
    return result;
  } catch (err) {
    toast.error("Failed to load groups");
    console.error(err);
    return [];
  }
}

export async function loadAllChats(): Promise<ModelsChat[]> {
  return await ChatMessageService.loadAllChats();
}

export async function uploadZip(
  selectedFile: any,
  password: string,
): Promise<void> {
  // Identity lookups are cached across uploads; drop them so a new backup
  // cannot be resolved against identities of the previous one.
  resetIdentityCaches();
  try {
    await FileService.handleZipUpload(selectedFile, password);
    // Build the checkable collection manifest. Collection is fault
    // isolated per file, so this must not throw for individual bad files.
    try {
      const manifest = await BackupCollectionService.collectBackup(
        selectedFile.name,
      );
      setManifest(manifest);
    } catch (collectionError) {
      console.error("Failed to build collection manifest", collectionError);
      setManifest(createEmptyManifest(selectedFile.name));
    }
  } catch (err) {
    console.error(err);
    throw err;
  }
}

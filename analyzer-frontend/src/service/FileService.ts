import { ZipReader, BlobReader, BlobWriter } from "@zip.js/zip.js";
import { toast } from "vue3-toastify";
import { openDB } from "idb";
import { resetManifest } from "./CollectionManifest";
export interface ZipFileEntry {
  filename: string;
  content: Blob;
  size: number;
  lastModified?: Date;
}

export class ZipUnpackService {
  private files = new Map<string, ZipFileEntry>();

  async unpackZip(
    zipFile: File,
    password?: string,
  ): Promise<Map<string, ZipFileEntry>> {
    // A new upload always fully replaces the previous backup, including
    // same-named re-uploads: no entry from an earlier extraction may survive.
    this.clear();
    resetManifest(zipFile.name);

    const extracted = new Map<string, ZipFileEntry>();
    try {
      const reader = new ZipReader(new BlobReader(zipFile), { password });
      const entries = await reader.getEntries();

      for (const entry of entries) {
        if (!entry.directory) {
          const writer = new BlobWriter();
          await entry.getData!(writer);
          const content = await writer.getData();
          extracted.set(entry.filename, {
            filename: entry.filename,
            content,
            size: content.size,
            lastModified: entry.lastModDate,
          });
        }
      }

      await reader.close();
      this.files = extracted;
      return this.files;
    } catch (error: any) {
      // Keep the store empty on failure so a broken upload cannot leave a
      // mix of old and new entries behind.
      this.files = new Map<string, ZipFileEntry>();
      toast.error("Failed to unzip ZIP file, maybe wrong password or invalid ZIP file");
      throw error;
    }
  }

  getFile(filename: string): ZipFileEntry | undefined {
    return this.files.get(filename);
  }

  hasFile(filename: string): boolean {
    return this.files.has(filename);
  }

  listFiles(): string[] {
    return Array.from(this.files.keys());
  }

  clear(): void {
    this.files.clear();
  }
}
const zipUnpackService = new ZipUnpackService();

export async function handleZipUpload(zipFile: File, password?: string) {
  try {
    const files = await zipUnpackService.unpackZip(zipFile, password);
    return files;
  } catch (error) {
    console.error(error);
    throw error;
  }
}
export function getZipFile(filename: string): ZipFileEntry | undefined {
  return zipUnpackService.getFile(filename);
}

export function listFiles(): string[] {
  return zipUnpackService.listFiles();
}

interface SavedZip {
  name: string;
  file: File;
}

const DB_NAME = "zip-storage";
const STORE_NAME = "zips";

async function getDB() {
  return openDB(DB_NAME, 1, {
    upgrade(db) {
      db.createObjectStore(STORE_NAME, { keyPath: "name" });
    },
  });
}

export async function saveZipToStorage(file: File): Promise<void> {
  const db = await getDB();
  await db.put(STORE_NAME, { name: file.name, file });
}

export async function getSavedZips(): Promise<SavedZip[]> {
  const db = await getDB();
  return await db.getAll(STORE_NAME);
}

export async function deleteZipFromStorage(name: string): Promise<void> {
  const db = await getDB();
  await db.delete(STORE_NAME, name);
}

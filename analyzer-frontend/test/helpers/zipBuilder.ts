import { ZipWriter, BlobWriter, TextReader } from "@zip.js/zip.js";

/**
 * Build an in-memory ZIP from a map of filename -> text content using the
 * same zip.js library the application uses for extraction.
 */
export async function buildZip(files: Record<string, string>): Promise<File> {
  const writer = new ZipWriter(new BlobWriter("application/zip"));

  for (const [filename, content] of Object.entries(files)) {
    await writer.add(filename, new TextReader(content));
  }

  const blob = await writer.close();
  return new File([blob], "backup.zip", { type: "application/zip" });
}

export function contactsCsv(
  rows: Array<{ identity: string; identityId: string; firstName?: string }>,
): string {
  const header =
    "identity,public_nickname,public_key,verification_level,first_name,last_name,nick_name,type,threema_channel,feature_mask,identity_id";
  const lines = rows.map(
    (r) =>
      `${r.identity},nick,key,1,${r.firstName ?? "First"},Last,Nicky,0,channel,0,${r.identityId}`,
  );
  return [header, ...lines].join("\n");
}

export function groupsCsv(
  rows: Array<{ id: string; uid: string; name: string }>,
): string {
  // 12 columns. GroupService reads groupUid at column index 9, so the UID
  // must be placed at that position in every row.
  const header =
    "id,creator,created_at,name,description,last_member_update,archived,last_message_at,deleted,group_uid,sync_state,last_policy_sync";
  const lines = rows.map(
    (r) =>
      `${r.id},CREATOR,0,${r.name},desc,0,false,0,false,${r.uid},sync-0,0`,
  );
  return [header, ...lines].join("\n");
}

const MESSAGE_HEADER =
  "id,session_id,isoutbox,issaved,send_status,body,posted_at,edited_at,delivered_at,read_at,type,identity";

export function messageCsv(rows: Array<Record<string, string>>): string {
  const lines = rows.map((r, index) =>
    [
      r.id ?? String(index + 1),
      r.session_id ?? "session",
      r.isoutbox ?? "0",
      r.issaved ?? "0",
      r.send_status ?? "SENT",
      r.body ?? "",
      r.posted_at ?? "1700000000000",
      r.edited_at ?? "",
      r.delivered_at ?? "",
      r.read_at ?? "",
      r.type ?? "TEXT",
      r.identity ?? "",
    ].join(","),
  );
  return [MESSAGE_HEADER, ...lines].join("\n");
}

export function textRow(
  body: string,
  postedAt: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return { body, posted_at: postedAt, ...extra };
}

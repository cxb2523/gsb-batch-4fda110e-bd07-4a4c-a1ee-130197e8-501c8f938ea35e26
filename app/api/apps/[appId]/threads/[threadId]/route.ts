import { getThreadService } from "@/lib/apps";
import { readJson, respond, route } from "@/lib/http";

type Ctx = { params: Promise<{ appId: string; threadId: string }> };

/** Renames a thread in the app's list. */
export const PATCH = route<Ctx>(async (request, user, { params }) => {
  const { appId, threadId } = await params;
  const result = await getThreadService().rename(user.id, appId, threadId, await readJson(request));
  return respond(result, { emptyOk: true });
});

/** Removes a thread from the app. The client deletes the Cloud conversation first. */
export const DELETE = route<Ctx>(async (_request, user, { params }) => {
  const { appId, threadId } = await params;
  return respond(await getThreadService().remove(user.id, appId, threadId), { emptyOk: true });
});

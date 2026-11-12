import { getThreadService } from "@/lib/apps";
import { ownsConversation } from "@/lib/apps/cloud-threads";
import { registerThreadSchema } from "@/lib/apps/schemas";
import { HttpError, readJson, respond, route } from "@/lib/http";

type Ctx = { params: Promise<{ appId: string }> };

/** The app's chat threads, newest activity first. `?cursor=` pages. */
export const GET = route<Ctx>(async (request, user, { params }) => {
  const { appId } = await params;
  const cursor = new URL(request.url).searchParams.get("cursor");
  return respond(await getThreadService().list(user.id, appId, cursor));
});

/**
 * Registers a thread just created in OpenUI Cloud as belonging to the app,
 * once Cloud confirms the conversation is this user's.
 */
export const POST = route<Ctx>(async (request, user, { params }) => {
  const { appId } = await params;
  const input = await readJson(request);
  const parsed = registerThreadSchema.safeParse(input);
  if (parsed.success && !(await ownsConversation(user.id, parsed.data.threadId))) {
    throw new HttpError(404, "Conversation not found");
  }
  return respond(await getThreadService().register(user.id, appId, input));
});

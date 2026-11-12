import { getOpenUI } from "@/lib/dashboards";
import { route } from "@/lib/http";

/**
 * The signed-in user's OpenUI Cloud frontend token: the browser reads their
 * chat threads and dashboards with it. It reads only this user's artifacts.
 */
export const POST = route(async (_request, user) => {
  return Response.json(await getOpenUI().createFrontendToken({ userId: user.id }));
});

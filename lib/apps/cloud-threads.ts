import "server-only";

import { config } from "@/config";
import { getOpenUI } from "@/lib/dashboards";

/**
 * Whether an OpenUI Cloud conversation is this user's. Asked with the user's
 * own frontend token, which reaches only their conversations, so a thread id
 * from the browser is never taken on trust.
 */
export async function ownsConversation(userId: string, conversationId: string): Promise<boolean> {
  const { token } = await getOpenUI().createFrontendToken({ userId });
  const response = await fetch(
    `${config().openui.apiUrl}/v1/conversations/${encodeURIComponent(conversationId)}`,
    { headers: { "x-thesys-frontend-token": token }, cache: "no-store" },
  );
  return response.ok;
}

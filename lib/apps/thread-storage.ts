import type { ChatStorage, Thread, ThreadStorage } from "@openuidev/react-headless";

/**
 * Scopes OpenUI Cloud chat storage to one app, for Agent Interface.
 *
 * Cloud keeps one flat list of a user's conversations. This wrapper reads the
 * app's list from OpenDashboards (`/api/apps/:appId/threads`) and keeps the mapping in
 * step with every create, rename and delete. Messages are still read straight
 * from Cloud.
 *
 * Usage, in the chat milestone:
 *   const cloud = useOpenuiCloudStorage({ token: "/api/frontend-token" });
 *   const storage = useMemo(() => scopeStorageToApp(cloud, appId), [cloud, appId]);
 *   <AgentInterface storage={storage} … />
 */
export function scopeStorageToApp(
  cloud: ChatStorage,
  appId: string,
  { fetch: fetchImpl = fetch }: { fetch?: typeof fetch } = {},
): ChatStorage {
  const base = `/api/apps/${encodeURIComponent(appId)}/threads`;
  const threadUrl = (id: string) => `${base}/${encodeURIComponent(id)}`;

  async function call<T>(url: string, init?: RequestInit): Promise<T | undefined> {
    const response = await fetchImpl(url, {
      ...init,
      headers: init?.body ? { "Content-Type": "application/json" } : undefined,
      cache: "no-store",
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
      throw new Error(body?.error?.message ?? `Request failed (${response.status})`);
    }
    return response.status === 204 ? undefined : ((await response.json()) as T);
  }

  const thread: ThreadStorage = {
    async listThreads(cursor) {
      const url = cursor ? `${base}?cursor=${encodeURIComponent(cursor)}` : base;
      return (await call<{ threads: Thread[]; nextCursor?: string }>(url)) ?? { threads: [] };
    },

    async createThread(firstMessage) {
      const created = await cloud.thread.createThread(firstMessage);
      try {
        await call(base, {
          method: "POST",
          body: JSON.stringify({ threadId: created.id, title: created.title }),
        });
      } catch (error) {
        // Don't leave a Cloud conversation that no app lists.
        await cloud.thread.deleteThread(created.id).catch(() => {});
        throw error;
      }
      return created;
    },

    getMessages: (threadId) => cloud.thread.getMessages(threadId),

    async updateThread(next) {
      const updated = await cloud.thread.updateThread(next);
      await call(threadUrl(updated.id), {
        method: "PATCH",
        body: JSON.stringify({ title: updated.title }),
      });
      return updated;
    },

    async deleteThread(id) {
      await cloud.thread.deleteThread(id);
      await call(threadUrl(id), { method: "DELETE" });
    },
  };

  return { ...cloud, thread };
}

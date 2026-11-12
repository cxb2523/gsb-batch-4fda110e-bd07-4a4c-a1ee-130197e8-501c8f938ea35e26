import type { ChatStorage, Thread } from "@openuidev/react-headless";
import { describe, expect, it, vi } from "vitest";

import { scopeStorageToApp } from "@/lib/apps/thread-storage";

const APP = "11111111-1111-4111-8111-111111111111";
const created: Thread = { id: "conv_1", title: "Hello", createdAt: "2026-11-06T00:00:00.000Z" };

function fakeCloud() {
  return {
    thread: {
      listThreads: vi.fn(async () => ({ threads: [created] })),
      createThread: vi.fn(async () => created),
      getMessages: vi.fn(async () => []),
      updateThread: vi.fn(async (thread: Thread) => thread),
      deleteThread: vi.fn(async () => {}),
    },
  } satisfies ChatStorage;
}

function fakeFetch(status = 200, body: unknown = {}) {
  return vi.fn<typeof fetch>(async () =>
    status === 204 ? new Response(null, { status }) : Response.json(body, { status }),
  );
}

describe("scopeStorageToApp", () => {
  it("lists threads from OpenDashboards, not from Cloud's flat list", async () => {
    const cloud = fakeCloud();
    const fetchImpl = fakeFetch(200, { threads: [], nextCursor: "abc" });
    const storage = scopeStorageToApp(cloud, APP, { fetch: fetchImpl });

    expect(await storage.thread.listThreads("c1")).toEqual({ threads: [], nextCursor: "abc" });
    expect(fetchImpl.mock.calls[0][0]).toBe(`/api/apps/${APP}/threads?cursor=c1`);
    expect(cloud.thread.listThreads).not.toHaveBeenCalled();
  });

  it("creates in Cloud, then registers the thread with the app", async () => {
    const cloud = fakeCloud();
    const fetchImpl = fakeFetch(200, created);
    const storage = scopeStorageToApp(cloud, APP, { fetch: fetchImpl });

    expect(await storage.thread.createThread({ id: "m1", role: "user", content: "Hi" })).toEqual(created);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`/api/apps/${APP}/threads`);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ threadId: "conv_1", title: "Hello" });
  });

  it("deletes the Cloud thread when registering fails", async () => {
    const cloud = fakeCloud();
    const storage = scopeStorageToApp(cloud, APP, {
      fetch: fakeFetch(409, { error: { message: "This conversation belongs to another app." } }),
    });

    await expect(storage.thread.createThread({ id: "m1", role: "user", content: "Hi" })).rejects.toThrow(
      "This conversation belongs to another app.",
    );
    expect(cloud.thread.deleteThread).toHaveBeenCalledWith("conv_1");
  });

  it("keeps renames and deletes in step, and reads messages from Cloud", async () => {
    const cloud = fakeCloud();
    const fetchImpl = fakeFetch(204);
    const storage = scopeStorageToApp(cloud, APP, { fetch: fetchImpl });

    await storage.thread.updateThread({ ...created, title: "Renamed" });
    await storage.thread.deleteThread("conv_1");
    await storage.thread.getMessages("conv_1");

    expect(fetchImpl.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      [`/api/apps/${APP}/threads/conv_1`, "PATCH"],
      [`/api/apps/${APP}/threads/conv_1`, "DELETE"],
    ]);
    expect(cloud.thread.deleteThread).toHaveBeenCalledWith("conv_1");
    expect(cloud.thread.getMessages).toHaveBeenCalledWith("conv_1");
  });
});

import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { appName, createAppService } from "@/lib/apps/service";
import { createThreadService } from "@/lib/apps/threads";
import { createConnectionService } from "@/lib/connections/service";
import { createDatabase } from "@/lib/db";
import { appConnections, apps, dashboards, dataConnections } from "@/lib/db/schema";
import { plaintextSecretBox } from "@/lib/secrets/plaintext";
import { postgresSource } from "@/lib/sources/postgres/source";
import { posthogSource } from "@/lib/sources/posthog/source";
import type { ConnectionSource } from "@/lib/sources/types";

import { TEST_DATABASE_URL } from "./global-setup";

const { db, pool } = createDatabase(TEST_DATABASE_URL);
const appsService = createAppService({ db });
const threads = createThreadService({ db });
const connections = createConnectionService({
  db,
  secrets: () => plaintextSecretBox,
  sources: (type) =>
    ({ ...(type === "posthog" ? posthogSource : postgresSource), test: async () => [] }) as unknown as ConnectionSource,
});

async function addConnection(userId: string, name = "Production") {
  const result = await connections.create(userId, {
    type: "posthog",
    name,
    hostKind: "posthog_us",
    projectId: "1",
    apiKey: "phx_abcdefghijklmnopqrstuvwxyz1234",
  });
  if (!result.ok) throw new Error(result.error.code);
  return result.data.id;
}

async function createApp(userId: string, prompt = "Weekly signups by plan", connectionIds?: string[]) {
  const ids = connectionIds ?? (await connections.list(userId)).map((connection) => connection.id);
  const result = await appsService.create(userId, { prompt, connectionIds: ids });
  if (!result.ok) throw new Error(result.error.code);
  return result.data.id;
}

beforeEach(async () => {
  await db.execute(sql`TRUNCATE ${apps}, ${dataConnections} CASCADE`);
});

afterAll(async () => {
  await pool.end();
});

describe("create", () => {
  it("needs at least one data source", async () => {
    expect(await appsService.create("alice", { prompt: "Signups", connectionIds: [] })).toMatchObject({
      ok: false,
      error: { code: "validation", field: "connectionIds" },
    });
  });

  it("stores the prompt and chosen sources, and names the app after them", async () => {
    const prod = await addConnection("alice", "Production");
    await addConnection("alice", "Staging");
    const id = await createApp("alice", "show me weekly signups by plan and country for the last year.", [prod]);
    const app = await appsService.get("alice", id);
    expect(app).toMatchObject({
      name: "Production: App 1",
      pendingPrompt: "show me weekly signups by plan and country for the last year.",
      pendingConnections: [{ id: prod, name: "Production" }],
      dashboards: [],
      // The sources picked for an app are its own from the start.
      connections: [{ id: prod, name: "Production" }],
    });
    const next = await createApp("alice", "another", [prod]);
    expect((await appsService.get("alice", next))?.name).toBe("Production: App 2");
  });

  it("refuses another user's data source", async () => {
    const mine = await addConnection("alice");
    const theirs = await addConnection("bob");
    expect(
      await appsService.create("alice", { prompt: "Signups", connectionIds: [mine, theirs] }),
    ).toMatchObject({ ok: false, error: { code: "validation", field: "connectionIds" } });
    expect(await appsService.list("alice")).toEqual([]);
  });

  it("rejects empty prompts and unexpected fields", async () => {
    const id = await addConnection("alice");
    expect(await appsService.create("alice", { prompt: "   ", connectionIds: [id] })).toMatchObject({
      ok: false,
      error: { code: "validation", field: "prompt" },
    });
    expect(
      await appsService.create("alice", { prompt: "x", connectionIds: [id], name: "Mine" }),
    ).toMatchObject({ ok: false, error: { code: "validation" } });
  });
});

describe("ownership", () => {
  it("never shows or changes another user's app", async () => {
    await addConnection("alice");
    const id = await createApp("alice");

    expect(await appsService.list("bob")).toEqual([]);
    expect(await appsService.get("bob", id)).toBeNull();
    expect(await appsService.rename("bob", { id, name: "Mine" })).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    expect(await appsService.remove("bob", { id })).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    expect(await appsService.takePendingPrompt("bob", id)).toBeNull();
    expect((await appsService.get("alice", id))?.pendingPrompt).toBe("Weekly signups by plan");
  });
});

describe("list, rename, remove", () => {
  it("lists newest first with dashboard counts and used connections", async () => {
    const connectionId = await addConnection("alice");
    const older = await createApp("alice", "Older");
    const newer = await createApp("alice", "Newer");
    await db.insert(dashboards).values([
      { appId: older, userId: "alice", artifactId: "art_1", title: "One", position: 0 },
      { appId: older, userId: "alice", artifactId: "art_2", title: "Two", position: 1 },
    ]);
    await appsService.recordConnectionUse("alice", older, connectionId);
    await appsService.rename("alice", { id: older, name: "Renamed" });

    const listed = await appsService.list("alice");
    expect(listed.map((app) => app.name)).toEqual(["Renamed", "Production: App 2"]);
    expect(listed[0]).toMatchObject({
      dashboardCount: 2,
      connections: [{ id: connectionId, name: "Production" }],
    });
    expect(listed[1]).toMatchObject({ id: newer, dashboardCount: 0, connections: [{ id: connectionId, name: "Production" }] });
    expect(await appsService.list("alice", { limit: 1 })).toHaveLength(1);
  });

  it("deletes the app with its dashboards, threads and usage, but not the connection", async () => {
    const connectionId = await addConnection("alice");
    const id = await createApp("alice");
    await db.insert(dashboards).values({ appId: id, userId: "alice", artifactId: "art_1", title: "D", position: 0 });
    await appsService.recordConnectionUse("alice", id, connectionId);
    await threads.register("alice", id, { threadId: "conv_1", title: "Chat" });

    expect(await appsService.remove("alice", { id })).toEqual({ ok: true, data: undefined });
    expect(await appsService.get("alice", id)).toBeNull();
    expect(await db.select().from(dashboards)).toEqual([]);
    expect(await db.select().from(appConnections)).toEqual([]);
    expect(await threads.belongsTo("alice", id, "conv_1")).toBe(false);
    expect(await connections.list("alice")).toHaveLength(1);
  });
});

describe("tree", () => {
  it("lists each app with its dashboards in order, only for the user", async () => {
    await addConnection("alice");
    const first = await createApp("alice", "First");
    const second = await createApp("alice", "Second");
    await db.insert(dashboards).values([
      { appId: first, userId: "alice", artifactId: "art_b", title: "Second tab", position: 1 },
      { appId: first, userId: "alice", artifactId: "art_a", title: "First tab", position: 0 },
    ]);

    expect(await appsService.tree("alice")).toEqual([
      { id: second, name: "Production: App 2", dashboards: [] },
      {
        id: first,
        name: "Production: App 1",
        dashboards: [
          { id: expect.any(String), title: "First tab" },
          { id: expect.any(String), title: "Second tab" },
        ],
      },
    ]);
    expect(await appsService.tree("bob")).toEqual([]);
  });
});

describe("takePendingPrompt", () => {
  it("returns the prompt and its sources once", async () => {
    const connectionId = await addConnection("alice");
    const id = await createApp("alice", "Signups");
    expect(await appsService.takePendingPrompt("alice", id)).toEqual({
      prompt: "Signups",
      connectionIds: [connectionId],
    });
    expect(await appsService.takePendingPrompt("alice", id)).toBeNull();
    expect((await appsService.get("alice", id))?.pendingConnections).toEqual([]);
  });
});

describe("addConnection", () => {
  it("starts an app with the sources picked for it", async () => {
    const first = await addConnection("alice", "Production");
    await addConnection("alice", "Staging");
    const id = await createApp("alice", "Signups", [first]);
    expect((await appsService.get("alice", id))?.connections.map((connection) => connection.name)).toEqual(["Production"]);
  });

  it("adds another of the user's connections, once", async () => {
    const first = await addConnection("alice", "Production");
    const second = await addConnection("alice", "Staging");
    const id = await createApp("alice", "Signups", [first]);

    expect(await appsService.addConnection("alice", { appId: id, connectionId: second })).toEqual({ ok: true, data: undefined });
    expect(await appsService.addConnection("alice", { appId: id, connectionId: second })).toMatchObject({ ok: true });
    expect((await appsService.get("alice", id))?.connections.map((connection) => connection.name)).toEqual(["Production", "Staging"]);
  });

  it("refuses someone else's app or connection, and malformed input", async () => {
    const mine = await addConnection("alice");
    const theirs = await addConnection("bob");
    const id = await createApp("alice", "Signups", [mine]);
    for (const [userId, input] of [
      ["alice", { appId: id, connectionId: theirs }],
      ["bob", { appId: id, connectionId: theirs }],
      ["alice", { appId: id, connectionId: "not-a-uuid" }],
      ["alice", { appId: id, connectionId: mine, extra: true }],
    ] as const) {
      expect(await appsService.addConnection(userId, input)).toMatchObject({ ok: false, error: { code: "not_found" } });
    }
    expect(await db.select().from(appConnections)).toHaveLength(1);
  });
});

describe("recordConnectionUse", () => {
  it("links only the user's own app and connection, once", async () => {
    const mine = await addConnection("alice");
    const theirs = await addConnection("bob");
    const id = await createApp("alice");

    expect((await appsService.recordConnectionUse("alice", id, mine)).ok).toBe(true);
    expect((await appsService.recordConnectionUse("alice", id, mine)).ok).toBe(true);
    expect(await appsService.recordConnectionUse("alice", id, theirs)).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    expect(await appsService.recordConnectionUse("bob", id, theirs)).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    expect(await db.select().from(appConnections)).toHaveLength(1);
  });

  it("blocks deleting a connection a dashboard uses", async () => {
    const connectionId = await addConnection("alice");
    const id = await createApp("alice");
    await appsService.recordConnectionUse("alice", id, connectionId);
    expect(await connections.remove("alice", { id: connectionId })).toMatchObject({
      ok: false,
      error: { code: "in_use", apps: [{ id }] },
    });
  });
});

describe("threads", () => {
  it("registers threads per app and refuses one that belongs elsewhere", async () => {
    await addConnection("alice");
    const first = await createApp("alice", "First");
    const second = await createApp("alice", "Second");

    expect((await threads.register("alice", first, { threadId: "conv_1", title: "" })).ok).toBe(true);
    expect(await threads.belongsTo("alice", first, "conv_1")).toBe(true);
    // Idempotent for the same app.
    expect(await threads.register("alice", first, { threadId: "conv_1", title: "Again" })).toMatchObject({
      ok: true,
      data: { id: "conv_1", title: "New chat" },
    });
    // The same conversation can't join a second app, or another user's app.
    expect(await threads.register("alice", second, { threadId: "conv_1", title: "x" })).toMatchObject({
      ok: false,
      error: { code: "thread_conflict" },
    });
    await addConnection("bob");
    const bobs = await createApp("bob");
    expect(await threads.register("bob", bobs, { threadId: "conv_1", title: "x" })).toMatchObject({
      ok: false,
      error: { code: "thread_conflict" },
    });
    expect(await threads.register("bob", first, { threadId: "conv_2", title: "x" })).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
  });

  it("lists newest activity first, page by page", async () => {
    await addConnection("alice");
    const id = await createApp("alice");
    let tick = Date.UTC(2026, 0, 1);
    const clocked = createThreadService({ db, now: () => new Date((tick += 1000)) });

    for (let i = 0; i < 35; i++) {
      await clocked.register("alice", id, { threadId: `conv_${i}`, title: `Chat ${i}` });
      await clocked.touch("alice", id, `conv_${i}`);
    }
    await clocked.touch("alice", id, "conv_3");

    const page1 = await clocked.list("alice", id);
    if (!page1.ok) throw new Error("list failed");
    expect(page1.data.threads).toHaveLength(30);
    expect(page1.data.threads[0].id).toBe("conv_3");
    expect(page1.data.nextCursor).toBeTruthy();

    const page2 = await clocked.list("alice", id, page1.data.nextCursor);
    if (!page2.ok) throw new Error("list failed");
    expect(page2.data.threads).toHaveLength(5);
    expect(page2.data.nextCursor).toBeUndefined();

    const all = [...page1.data.threads, ...page2.data.threads].map((thread) => thread.id);
    expect(new Set(all).size).toBe(35);

    expect(await clocked.list("alice", id, "garbage")).toMatchObject({
      ok: false,
      error: { code: "validation" },
    });
    expect(await clocked.list("bob", id)).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("renames and removes only within the app", async () => {
    await addConnection("alice");
    const id = await createApp("alice");
    const other = await createApp("alice", "Other");
    await threads.register("alice", id, { threadId: "conv_1", title: "Chat" });

    expect(await threads.rename("alice", other, "conv_1", { title: "x" })).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    expect(await threads.rename("alice", id, "conv_1", { title: "Renamed" })).toEqual({
      ok: true,
      data: undefined,
    });
    expect(await threads.remove("alice", other, "conv_1")).toMatchObject({ ok: false });
    expect(await threads.remove("alice", id, "conv_1")).toEqual({ ok: true, data: undefined });
    expect(await threads.belongsTo("alice", id, "conv_1")).toBe(false);
  });
});

describe("appName", () => {
  it("names an app after its data sources and numbers it", () => {
    expect(appName(["Retail sales"], [])).toBe("Retail sales: App 1");
    expect(appName(["Retail sales"], ["Retail sales: App 1", "Retail sales: App 4", "Production: App 9"])).toBe(
      "Retail sales: App 5",
    );
    expect(appName(["Retail sales"], ["My renamed app"])).toBe("Retail sales: App 1");
  });

  it("lists two sources and counts the rest", () => {
    expect(appName(["Retail sales", "Production"], [])).toBe("Retail sales + Production: App 1");
    expect(appName(["A", "B", "C"], ["A + 2 more: App 1"])).toBe("A + 2 more: App 2");
  });

  it("treats source names literally", () => {
    expect(appName(["Sales (EU)"], ["Sales (EU): App 2"])).toBe("Sales (EU): App 3");
  });
});

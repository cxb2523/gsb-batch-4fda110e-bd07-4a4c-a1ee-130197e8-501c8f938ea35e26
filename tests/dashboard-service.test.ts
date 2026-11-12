import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createDashboardService } from "@/lib/dashboards/service";
import { createDatabase } from "@/lib/db";
import { apps, dataConnections } from "@/lib/db/schema";

import { TEST_DATABASE_URL } from "./global-setup";

const { db, pool } = createDatabase(TEST_DATABASE_URL);
const dashboards = createDashboardService({ db });

async function createApp(userId: string) {
  const [app] = await db.insert(apps).values({ userId, name: "Test app" }).returning({ id: apps.id });
  return app.id;
}

async function titles(userId: string, appId: string) {
  return (await dashboards.list(userId, appId)).map((dashboard) => dashboard.title);
}

beforeEach(async () => {
  await db.execute(sql`TRUNCATE ${apps}, ${dataConnections} CASCADE`);
});

afterAll(async () => {
  await pool.end();
});

describe("record", () => {
  it("adds dashboards in order, and retitles one it already has", async () => {
    const appId = await createApp("alice");
    await dashboards.record("alice", appId, { artifactId: "art_a", title: "Overview" });
    await dashboards.record("alice", appId, { artifactId: "art_b", title: "Retention" });
    await dashboards.record("alice", appId, { artifactId: "art_a", title: "Product overview" });
    expect(await titles("alice", appId)).toEqual(["Product overview", "Retention"]);
  });

  it("won't record into another user's app", async () => {
    const appId = await createApp("alice");
    expect(await dashboards.record("bob", appId, { artifactId: "art_a", title: "Overview" })).toBeNull();
    expect(await titles("alice", appId)).toEqual([]);
  });
});

describe("remove", () => {
  it("removes the dashboard and closes the gap in the order", async () => {
    const appId = await createApp("alice");
    for (const [artifactId, title] of [
      ["art_a", "A"],
      ["art_b", "B"],
      ["art_c", "C"],
    ]) {
      await dashboards.record("alice", appId, { artifactId, title });
    }

    expect(await dashboards.remove("alice", appId, "art_b")).toBe(true);
    expect(await titles("alice", appId)).toEqual(["A", "C"]);

    // Positions are contiguous again, so the next one goes last.
    await dashboards.record("alice", appId, { artifactId: "art_d", title: "D" });
    expect(await titles("alice", appId)).toEqual(["A", "C", "D"]);
  });

  it("only removes the user's own dashboard, from the app it belongs to", async () => {
    const appId = await createApp("alice");
    const otherApp = await createApp("alice");
    await dashboards.record("alice", appId, { artifactId: "art_a", title: "A" });

    expect(await dashboards.remove("bob", appId, "art_a")).toBe(false);
    expect(await dashboards.remove("alice", otherApp, "art_a")).toBe(false);
    expect(await dashboards.remove("alice", appId, "art_missing")).toBe(false);
    expect(await titles("alice", appId)).toEqual(["A"]);
  });
});

describe("update", () => {
  it("renames the user's own dashboard in its app, and nothing else", async () => {
    const appId = await createApp("alice");
    const other = await createApp("alice");
    const recorded = await dashboards.record("alice", appId, { artifactId: "art_a", title: "Overview" });
    if (!recorded) throw new Error("record failed");

    expect(await dashboards.update("bob", appId, recorded.id, { title: "Mine" })).toBe(false);
    expect(await dashboards.update("alice", other, recorded.id, { title: "Moved" })).toBe(false);
    expect(await dashboards.update("alice", appId, recorded.id, { title: "Monthly KPIs" })).toBe(true);
    expect(await titles("alice", appId)).toEqual(["Monthly KPIs"]);

    await dashboards.update("alice", appId, recorded.id, { description: "Revenue by month." });
    expect((await dashboards.list("alice", appId))[0]).toMatchObject({ title: "Monthly KPIs", description: "Revenue by month." });
    await dashboards.update("alice", appId, recorded.id, { description: null });
    expect((await dashboards.list("alice", appId))[0]?.description).toBeNull();
  });
});

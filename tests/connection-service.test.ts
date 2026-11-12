import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { DemoDataset } from "@/config";
import { createConnectionService } from "@/lib/connections/service";
import { createDatabase } from "@/lib/db";
import { appConnections, apps, dataConnections } from "@/lib/db/schema";
import type { PostgresCheck } from "@/lib/sources/postgres/client";
import { postgresSource } from "@/lib/sources/postgres/source";
import { posthogSource } from "@/lib/sources/posthog/source";
import type { ConnectionSource } from "@/lib/sources/types";
import { PostgresError } from "@/lib/sources/postgres/errors";
import { PostHogError } from "@/lib/sources/posthog/client";
import type { SecretBox } from "@/lib/secrets";
import { createKmsSecretBox } from "@/lib/secrets/kms";
import { plaintextSecretBox } from "@/lib/secrets/plaintext";

import { TEST_DATABASE_URL } from "./global-setup";

const { db, pool } = createDatabase(TEST_DATABASE_URL);

const VALID = {
  type: "posthog",
  name: "Production",
  hostKind: "posthog_us",
  projectId: "12345",
  apiKey: "phx_abcdefghijklmnopqrstuvwxyz1234",
};

const READ_ONLY: PostgresCheck = { serverVersion: "16.4", canWrite: false };

const DEMO: DemoDataset = {
  key: "retail",
  name: "Retail sales",
  description: "A sample retail business.",
  postgres: { host: "demo.example.com", port: 5432, database: "retail_sales", user: "reader", sslMode: "verify-full" },
  prompts: ["Revenue by month"],
};

function makeService(
  overrides: {
    secrets?: SecretBox;
    test?: () => Promise<void>;
    testPostgres?: () => Promise<PostgresCheck>;
    demo?: { datasets: () => DemoDataset[]; password: () => string | undefined };
  } = {},
) {
  const testConnection = vi.fn(overrides.test ?? (async () => {}));
  const testPostgres = vi.fn(overrides.testPostgres ?? (async () => READ_ONLY));
  // The real sources, with only their network checks stubbed.
  const sources = (type: string): ConnectionSource =>
    (type === "posthog"
      ? {
          ...posthogSource,
          test: async (config: Record<string, unknown>, credential: string) => {
            await (testConnection as (target: unknown) => Promise<void>)({ ...config, apiKey: credential });
            return [];
          },
        }
      : {
          ...postgresSource,
          test: async (config: Record<string, unknown>, credential: string) => {
            const result = await (testPostgres as (target: unknown) => Promise<PostgresCheck>)({ ...config, password: credential });
            return result.canWrite ? ["can_write"] : [];
          },
        }) as unknown as ConnectionSource;
  const service = createConnectionService({
    db,
    secrets: () => overrides.secrets ?? plaintextSecretBox,
    sources,
    demo: overrides.demo ?? { datasets: () => [DEMO], password: () => "demo-password" },
  });
  return { service, testConnection, testPostgres };
}

async function createOk(userId: string, input: object = VALID) {
  const { service } = makeService();
  const result = await service.create(userId, input);
  if (!result.ok) throw new Error(`create failed: ${result.error.code}`);
  return result.data.id;
}

beforeEach(async () => {
  await db.execute(sql`TRUNCATE ${apps}, ${dataConnections} CASCADE`);
});

afterAll(async () => {
  await pool.end();
});

describe("create", () => {
  it("tests the key, then saves a connection without exposing the key", async () => {
    const { service, testConnection } = makeService();
    const result = await service.create("alice", VALID);
    expect(result).toMatchObject({ ok: true, data: { warnings: [] } });
    expect(testConnection).toHaveBeenCalledWith({
      hostKind: "posthog_us",
      projectId: "12345",
      apiKey: VALID.apiKey,
    });

    const [listed] = await service.list("alice");
    expect(listed).toMatchObject({
      name: "Production",
      type: "posthog",
      source: "PostHog · US Cloud",
      detail: "Project 12345",
      credentialHint: "phx_…1234",
      status: "ok",
    });
    expect(JSON.stringify(listed)).not.toContain(VALID.apiKey);
  });

  it("saves nothing when PostHog rejects the key, and points at the key field", async () => {
    const { service } = makeService({
      test: async () => {
        throw new PostHogError("invalid_key", 403);
      },
    });
    const result = await service.create("alice", VALID);
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_key", field: "apiKey" } });
    expect(await service.list("alice")).toEqual([]);
  });

  it("rejects unexpected fields such as a host or URL", async () => {
    const { service, testConnection } = makeService();
    const result = await service.create("alice", { ...VALID, url: "http://169.254.169.254" });
    expect(result).toMatchObject({ ok: false, error: { code: "validation" } });
    expect(testConnection).not.toHaveBeenCalled();
  });

  it("validates each field", async () => {
    const { service } = makeService();
    for (const [field, value] of [
      ["name", "  "],
      ["hostKind", "posthog_internal"],
      ["projectId", "12a"],
      ["apiKey", "sk_live_123"],
    ] as const) {
      const result = await service.create("alice", { ...VALID, [field]: value });
      expect(result).toMatchObject({ ok: false, error: { code: "validation", field } });
    }
  });

  it("reports missing secret storage without calling PostHog", async () => {
    const { service, testConnection } = makeService({ secrets: createKmsSecretBox("arn:test", { roleArn: "role" }) });
    const result = await service.create("alice", VALID);
    expect(result).toMatchObject({ ok: false, error: { code: "secret_storage_unavailable" } });
    expect(testConnection).not.toHaveBeenCalled();
  });
});

describe("ownership", () => {
  it("never shows or changes another user's connection", async () => {
    const id = await createOk("alice");
    const { service, testConnection } = makeService();

    expect(await service.list("bob")).toEqual([]);
    for (const result of [
      await service.retest("bob", { id }),
      await service.rename("bob", { id, name: "Hijacked" }),
      await service.replaceCredential("bob", { id, credential: VALID.apiKey }),
      await service.remove("bob", { id }),
    ]) {
      expect(result).toMatchObject({ ok: false, error: { code: "not_found" } });
    }
    expect(testConnection).not.toHaveBeenCalled();

    const [still] = await service.list("alice");
    expect(still).toMatchObject({ id, name: "Production" });
  });

  it("treats a malformed id as not found", async () => {
    const { service } = makeService();
    expect(await service.remove("alice", { id: "not-a-uuid" })).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
  });
});

describe("retest", () => {
  it("records ok, invalid and unavailable outcomes", async () => {
    const id = await createOk("alice");

    const failing = makeService({
      test: async () => {
        throw new PostHogError("missing_scope", 403);
      },
    });
    expect(await failing.service.retest("alice", { id })).toMatchObject({
      ok: false,
      error: { code: "missing_scope" },
    });
    expect((await failing.service.list("alice"))[0].status).toBe("invalid");

    const down = makeService({
      test: async () => {
        throw new PostHogError("unavailable");
      },
    });
    await down.service.retest("alice", { id });
    expect((await down.service.list("alice"))[0].status).toBe("unavailable");

    const fine = makeService();
    expect(await fine.service.retest("alice", { id })).toEqual({ ok: true, data: { status: "ok" } });
    expect((await fine.service.list("alice"))[0].status).toBe("ok");
  });

  it("marks a plaintext row invalid under KMS instead of using it", async () => {
    const id = await createOk("alice");
    const { service, testConnection } = makeService({ secrets: createKmsSecretBox("arn:test", { roleArn: "role" }) });

    expect(await service.retest("alice", { id })).toMatchObject({
      ok: false,
      error: { code: "key_reentry_required" },
    });
    expect(testConnection).not.toHaveBeenCalled();
    expect((await service.list("alice"))[0].status).toBe("invalid");
  });

  it("caches the decrypted key and drops it when the key is replaced", async () => {
    const id = await createOk("alice");
    const open = vi.fn(plaintextSecretBox.open);
    const secrets: SecretBox = { ...plaintextSecretBox, open };
    const { service, testConnection } = makeService({ secrets });

    await service.retest("alice", { id });
    await service.retest("alice", { id });
    expect(open).toHaveBeenCalledTimes(1);

    const newKey = "phx_zyxwvutsrqponmlkjihgfedcba9876";
    expect(await service.replaceCredential("alice", { id, credential: newKey })).toEqual({
      ok: true,
      data: { warnings: [] },
    });
    await service.retest("alice", { id });
    expect(open).toHaveBeenCalledTimes(2);
    expect(testConnection).toHaveBeenLastCalledWith(expect.objectContaining({ apiKey: newKey }));
  });
});

describe("replaceCredential", () => {
  it("keeps the old key when the new one fails, and never changes the host", async () => {
    const id = await createOk("alice");
    const { service, testConnection } = makeService({
      test: async () => {
        throw new PostHogError("invalid_key", 403);
      },
    });

    const result = await service.replaceCredential("alice", {
      id,
      credential: "phx_badbadbadbadbadbadbad1",
      hostKind: "posthog_eu",
    });
    expect(result).toMatchObject({ ok: false, error: { code: "validation" } });
    expect(testConnection).not.toHaveBeenCalled();

    const failed = await service.replaceCredential("alice", { id, credential: "phx_badbadbadbadbadbadbad1" });
    expect(failed).toMatchObject({ ok: false, error: { code: "invalid_key", field: "apiKey" } });
    const [row] = await service.list("alice");
    expect(row).toMatchObject({ credentialHint: "phx_…1234", source: "PostHog · US Cloud" });
  });

  it("validates the new key as a PostHog key", async () => {
    const id = await createOk("alice");
    const { service, testConnection } = makeService();
    expect(await service.replaceCredential("alice", { id, credential: "hunter2" })).toMatchObject({
      ok: false,
      error: { code: "validation", field: "apiKey" },
    });
    expect(testConnection).not.toHaveBeenCalled();
  });
});

describe("rename and remove", () => {
  it("renames", async () => {
    const id = await createOk("alice");
    const { service } = makeService();
    expect(await service.rename("alice", { id, name: "  Staging  " })).toEqual({
      ok: true,
      data: undefined,
    });
    expect((await service.list("alice"))[0].name).toBe("Staging");
  });

  it("refuses to delete a connection an app uses, and lists the apps", async () => {
    const id = await createOk("alice");
    const [app] = await db.insert(apps).values({ userId: "alice", name: "Growth" }).returning();
    await db.insert(appConnections).values({ appId: app.id, connectionId: id });
    const { service } = makeService();

    expect(await service.remove("alice", { id })).toMatchObject({
      ok: false,
      error: { code: "in_use", apps: [{ name: "Growth" }] },
    });
    expect(await service.list("alice")).toHaveLength(1);
  });

  it("deletes an unused connection", async () => {
    const id = await createOk("alice");
    const { service } = makeService();
    expect(await service.remove("alice", { id })).toEqual({ ok: true, data: undefined });
    expect(await service.list("alice")).toEqual([]);
  });
});

const PG = {
  type: "postgres",
  name: "Warehouse",
  host: "db.example.com",
  port: 5432,
  database: "app",
  user: "analyst",
  password: "s3cret-Passw0rd",
  sslMode: "verify-full",
};

describe("postgres", () => {
  it("tests with the password, then saves without exposing it", async () => {
    const seal = vi.fn(plaintextSecretBox.seal);
    const { service, testPostgres } = makeService({ secrets: { ...plaintextSecretBox, seal } });

    expect(await service.create("alice", PG)).toMatchObject({ ok: true, data: { warnings: [] } });
    expect(testPostgres).toHaveBeenCalledWith({
      host: "db.example.com",
      port: 5432,
      database: "app",
      user: "analyst",
      password: PG.password,
      sslMode: "verify-full",
    });
    expect(seal).toHaveBeenCalledWith(PG.password, expect.objectContaining({ purpose: "postgres-password" }));

    const [listed] = await service.list("alice");
    expect(listed).toMatchObject({
      type: "postgres",
      source: "Postgres",
      detail: "analyst@db.example.com:5432/app",
      tile: "PG",
      credentialHint: "password ••••",
    });
    expect(JSON.stringify(listed)).not.toContain(PG.password);
  });

  it("accepts the port as text, as a form sends it", async () => {
    const { service, testPostgres } = makeService();
    expect(await service.create("alice", { ...PG, port: "6543" })).toMatchObject({ ok: true });
    expect(testPostgres).toHaveBeenCalledWith(expect.objectContaining({ port: 6543 }));
  });

  it("warns when the user can write", async () => {
    const { service } = makeService({ testPostgres: async () => ({ serverVersion: "16.4", canWrite: true }) });
    expect(await service.create("alice", PG)).toMatchObject({ ok: true, data: { warnings: ["can_write"] } });
  });

  it("maps failed checks to their fields and saves nothing", async () => {
    for (const [code, field] of [
      ["auth_failed", "password"],
      ["database_not_found", "database"],
      ["host_blocked", "host"],
      ["host_not_found", "host"],
      ["tls_failed", "sslMode"],
    ] as const) {
      const { service } = makeService({
        testPostgres: async () => {
          throw new PostgresError(code);
        },
      });
      expect(await service.create("alice", PG)).toMatchObject({ ok: false, error: { code, field } });
    }
    expect(await makeService().service.list("alice")).toEqual([]);
  });

  it("rejects a connection string, a socket path or an unknown SSL mode before connecting", async () => {
    const { service, testPostgres } = makeService();
    for (const [input, field] of [
      [{ ...PG, connectionString: "postgres://x" }, undefined],
      [{ ...PG, host: "/var/run/postgresql" }, "host"],
      [{ ...PG, host: "postgres://db.example.com" }, "host"],
      [{ ...PG, host: "db.example.com:5432" }, "host"],
      [{ ...PG, port: 70000 }, "port"],
      [{ ...PG, sslMode: "prefer" }, "sslMode"],
      [{ ...PG, password: "x".repeat(1025) }, "password"],
    ] as const) {
      const result = await service.create("alice", input);
      expect(result).toMatchObject({ ok: false, error: { code: "validation" } });
      if (field && !result.ok) expect(result.error.field).toBe(field);
    }
    expect(testPostgres).not.toHaveBeenCalled();
  });

  it("changes the password only, and keeps the old one when the new one fails", async () => {
    const id = await createOk("alice", PG);
    const rejecting = makeService({
      testPostgres: async () => {
        throw new PostgresError("auth_failed");
      },
    });
    expect(await rejecting.service.replaceCredential("alice", { id, credential: "wrong" })).toMatchObject({
      ok: false,
      error: { code: "auth_failed", field: "password" },
    });
    expect(await rejecting.service.replaceCredential("alice", { id, credential: "" })).toMatchObject({
      ok: false,
      error: { code: "auth_failed", field: "password" },
    });

    const { service, testPostgres } = makeService();
    expect(await service.replaceCredential("alice", { id, credential: "new-Passw0rd" })).toMatchObject({ ok: true });
    await service.retest("alice", { id });
    expect(testPostgres).toHaveBeenLastCalledWith(
      expect.objectContaining({ host: "db.example.com", database: "app", password: "new-Passw0rd" }),
    );
  });

  it("saves a server with no password without touching secret storage", async () => {
    const unavailable: SecretBox = {
      provider: "kms",
      seal: vi.fn(async () => {
        throw new Error("KMS must not be called");
      }),
      open: vi.fn(async () => {
        throw new Error("KMS must not be called");
      }),
    };
    const { service, testPostgres } = makeService({ secrets: unavailable });
    const created = await service.create("alice", { ...PG, password: "" });
    expect(created).toMatchObject({ ok: true });
    expect(testPostgres).toHaveBeenCalledWith(expect.objectContaining({ password: "" }));
    expect(unavailable.seal).not.toHaveBeenCalled();

    const [row] = await db.select().from(dataConnections);
    expect(row.secret).toEqual({ v: 1, provider: "none" });
    expect((await service.list("alice"))[0].credentialHint).toBe("no password");

    // Opening it for a tool, and retesting it, give the empty password back without KMS.
    expect(await service.open("alice", row.id, "postgres")).toMatchObject({ credential: "" });
    expect(await service.retest("alice", { id: row.id })).toMatchObject({ ok: true });
    expect(unavailable.open).not.toHaveBeenCalled();
  });

  it("switches between a password and none", async () => {
    const id = await createOk("alice", { ...PG, password: "" });
    const { service } = makeService();
    expect(await service.replaceCredential("alice", { id, credential: "s3cret-pw" })).toMatchObject({ ok: true });
    expect((await db.select().from(dataConnections))[0].secret).toEqual({ v: 1, provider: "plaintext", value: "s3cret-pw" });
    expect(await service.open("alice", id, "postgres")).toMatchObject({ credential: "s3cret-pw" });
    expect((await service.list("alice"))[0].credentialHint).toBe("password ••••");

    expect(await service.replaceCredential("alice", { id, credential: "" })).toMatchObject({ ok: true });
    expect((await db.select().from(dataConnections))[0].secret).toEqual({ v: 1, provider: "none" });
    expect(await service.open("alice", id, "postgres")).toMatchObject({ credential: "" });
  });

  it("records an unreachable server as unavailable, not invalid", async () => {
    const id = await createOk("alice", PG);
    const { service } = makeService({
      testPostgres: async () => {
        throw new PostgresError("unreachable");
      },
    });
    await service.retest("alice", { id });
    expect((await service.list("alice"))[0].status).toBe("unavailable");
  });
});

describe("demo datasets", () => {
  it("installs once per user, with no secret of its own, and opens with config's settings", async () => {
    const { service } = makeService();
    const first = await service.installDemo("alice", { dataset: "retail" });
    const again = await service.installDemo("alice", { dataset: "retail" });
    expect(first.ok && again.ok && first.data.id === again.data.id).toBe(true);
    if (!first.ok) return;

    const [row] = await db.select().from(dataConnections);
    expect(row).toMatchObject({ userId: "alice", demoDataset: "retail", secret: null, type: "postgres" });

    expect(await service.open("alice", first.data.id, "postgres")).toEqual({
      id: first.data.id,
      name: "Retail sales",
      config: DEMO.postgres,
      credential: "demo-password",
    });
    expect(await service.open("bob", first.data.id, "postgres")).toBeNull();

    const [summary] = await service.list("alice");
    expect(summary).toMatchObject({ source: "Demo dataset", shortSource: "Demo", demo: { key: "retail" } });
    expect(await service.listDemoDatasets("alice")).toMatchObject([{ key: "retail", connectionId: first.data.id, apps: [] }]);
    expect(await service.listDemoDatasets("bob")).toMatchObject([{ key: "retail", connectionId: null }]);
  });

  it("follows config: a changed host applies to installed copies, a removed dataset reads as gone", async () => {
    let datasets = [DEMO];
    const { service } = makeService({ demo: { datasets: () => datasets, password: () => "demo-password" } });
    const installed = await service.installDemo("alice", { dataset: "retail" });
    if (!installed.ok) throw new Error("install failed");

    datasets = [{ ...DEMO, postgres: { ...DEMO.postgres, host: "moved.example.com" } }];
    expect((await service.open("alice", installed.data.id, "postgres"))?.config).toMatchObject({ host: "moved.example.com" });

    datasets = [];
    expect(await service.open("alice", installed.data.id, "postgres")).toBeNull();
    expect(await service.list("alice")).toEqual([]);
  });

  it("offers nothing without the shared password", async () => {
    const { service } = makeService({ demo: { datasets: () => [DEMO], password: () => undefined } });
    expect(await service.listDemoDatasets("alice")).toEqual([]);
    expect(await service.installDemo("alice", { dataset: "retail" })).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await service.installDemo("alice", { dataset: "nope" })).toMatchObject({ ok: false });
  });

  it("can't be edited, and can't be uninstalled while an app uses it", async () => {
    const { service } = makeService();
    const installed = await service.installDemo("alice", { dataset: "retail" });
    if (!installed.ok) throw new Error("install failed");
    const id = installed.data.id;

    expect(await service.retest("alice", { id })).toMatchObject({ ok: false, error: { code: "demo_dataset" } });
    expect(await service.replaceCredential("alice", { id, credential: "x" })).toMatchObject({ ok: false, error: { code: "demo_dataset" } });
    expect(await service.rename("alice", { id, name: "Mine" })).toMatchObject({ ok: false });

    const [app] = await db.insert(apps).values({ userId: "alice", name: "Sales" }).returning();
    await db.insert(appConnections).values({ appId: app.id, connectionId: id });
    expect(await service.uninstallDemo("alice", { dataset: "retail" })).toMatchObject({
      ok: false,
      error: { code: "in_use", apps: [{ id: app.id, name: "Sales" }] },
    });

    await db.delete(apps);
    expect(await service.uninstallDemo("alice", { dataset: "retail" })).toEqual({ ok: true, data: undefined });
    expect(await service.uninstallDemo("alice", { dataset: "retail" })).toEqual({ ok: true, data: undefined });
    expect(await service.listDemoDatasets("alice")).toMatchObject([{ connectionId: null }]);
  });

  it("a connection with a secret can't also be a demo dataset", async () => {
    await expect(
      db.insert(dataConnections).values({
        id: crypto.randomUUID(),
        userId: "alice",
        name: "Odd",
        type: "postgres",
        config: { type: "postgres", ...DEMO.postgres },
        secret: { provider: "plaintext", value: "x" } as never,
        credentialHint: "x",
        demoDataset: "retail",
        status: "ok",
        lastCheckedAt: new Date(),
      }),
    ).rejects.toThrow();
  });
});

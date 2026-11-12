import { exportPKCS8, generateKeyPair } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { queryBigquery, toResult } from "@/lib/sources/bigquery/client";
import { readServiceAccountKey, serviceAccountKeySchema } from "@/lib/sources/google/credential";
import { BigqueryError, fromApiError } from "@/lib/sources/bigquery/errors";
import { bigquerySource } from "@/lib/sources/bigquery/source";

let privateKey: string;
const keyFile = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "service_account",
    project_id: "acme-analytics",
    private_key_id: "abc",
    private_key: privateKey,
    client_email: "dashboards-reader@acme-analytics.iam.gserviceaccount.com",
    client_id: "123",
    token_uri: "https://oauth2.googleapis.com/token",
    ...overrides,
  });

beforeAll(async () => {
  const { privateKey: key } = await generateKeyPair("RS256", { extractable: true });
  privateKey = await exportPKCS8(key);
});

describe("service account key", () => {
  it("keeps only the email and private key", () => {
    const parsed = serviceAccountKeySchema.parse(keyFile());
    expect(Object.keys(JSON.parse(parsed)).sort()).toEqual(["client_email", "private_key"]);
    expect(readServiceAccountKey(parsed).client_email).toBe("dashboards-reader@acme-analytics.iam.gserviceaccount.com");
  });

  it("drops a doctored token_uri: tokens only ever go to Google", () => {
    const parsed = serviceAccountKeySchema.parse(keyFile({ token_uri: "https://attacker.example/token" }));
    expect(parsed).not.toContain("attacker");
  });

  it.each([
    ["external_account", { type: "external_account", credential_source: { executable: { command: "/bin/sh -c id" } } }],
    ["authorized_user", { type: "authorized_user" }],
    ["impersonated_service_account", { type: "impersonated_service_account" }],
  ])("refuses a %s credential", (_label, overrides) => {
    expect(serviceAccountKeySchema.safeParse(keyFile(overrides)).success).toBe(false);
  });

  it("refuses a non-Google client_email and a non-PEM key", () => {
    expect(serviceAccountKeySchema.safeParse(keyFile({ client_email: "me@example.com" })).success).toBe(false);
    expect(serviceAccountKeySchema.safeParse(keyFile({ private_key: "not a key" })).success).toBe(false);
    expect(serviceAccountKeySchema.safeParse("{ not json").success).toBe(false);
  });

  it("shows the account, never the key, as the hint", () => {
    const hint = bigquerySource.credential.hint(serviceAccountKeySchema.parse(keyFile()));
    expect(hint).toBe("dashboards-reader@acme-analytics.iam.gserviceaccount.com");
  });
});

describe("toResult", () => {
  it("turns BigQuery's cells into JSON values", () => {
    const result = toResult(
      {
        schema: {
          fields: [
            { name: "day", type: "DATE" },
            { name: "n", type: "INTEGER" },
            { name: "rate", type: "FLOAT" },
            { name: "ok", type: "BOOLEAN" },
            { name: "at", type: "TIMESTAMP" },
            { name: "tags", type: "STRING", mode: "REPEATED" },
            { name: "geo", type: "RECORD", fields: [{ name: "country", type: "STRING" }] },
          ],
        },
        rows: [{ f: [{ v: "2026-11-01" }, { v: "42" }, { v: "0.5" }, { v: "true" }, { v: "1.7619552E9" }, { v: [{ v: "a" }, { v: "b" }] }, { v: { f: [{ v: "IN" }] } }] }],
        totalRows: "1",
      },
      10,
    );
    expect(result.rows[0]).toEqual({ day: "2026-11-01", n: 42, rate: 0.5, ok: true, at: "2025-11-01T00:00:00.000Z", tags: ["a", "b"], geo: { country: "IN" } });
    expect(result.truncated).toBe(false);
  });

  it("marks results with more rows than the limit as truncated", () => {
    const result = toResult({ schema: { fields: [{ name: "x", type: "INTEGER" }] }, rows: [{ f: [{ v: "1" }] }, { f: [{ v: "2" }] }], totalRows: "5000" }, 1);
    expect(result).toEqual({ columns: ["x"], rows: [{ x: 1 }], truncated: true });
  });
});

describe("fromApiError", () => {
  it.each<[number, string, string]>([
    [400, "invalidQuery", "bad_query"],
    [403, "accessDenied", "access_denied"],
    [404, "notFound", "not_found"],
    [400, "bytesBilledLimitExceeded", "too_expensive"],
    [403, "rateLimitExceeded", "rate_limited"],
    [403, "quotaExceeded", "rate_limited"],
    [400, "resourcesExceeded", "too_heavy"],
    [403, "billingNotEnabled", "not_enabled"],
    [500, "backendError", "unavailable"],
  ])("HTTP %i %s is %s", (status, reason, code) => {
    expect(fromApiError(status, { error: { code: status, message: "m", errors: [{ reason, message: "m" }] } }).code).toBe(code);
  });

  it("recognizes a project without the BigQuery API enabled", () => {
    const body = { error: { code: 403, message: "BigQuery API has not been used in project 123 before or it is disabled.", errors: [{ reason: "accessDenied", message: "BigQuery API has not been used in project 123 before or it is disabled." }] } };
    expect(fromApiError(403, body).code).toBe("not_enabled");
  });
});

describe("queryBigquery", () => {
  type Call = { url: string; method: string; body: Record<string, unknown> | null };
  let calls: Call[];

  function mockGoogle(responses: { dry: object; query?: object[]; results?: object[] }) {
    calls = [];
    const queue = [...(responses.query ?? [])];
    const results = [...(responses.results ?? [])];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init: RequestInit) => {
        const url = String(input);
        const body = typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
        calls.push({ url, method: init.method ?? "GET", body });
        const json = (data: object, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
        if (url === "https://oauth2.googleapis.com/token") return json({ access_token: "token-1", expires_in: 3600 });
        if (url.endsWith("/jobs") && body?.configuration) return json(responses.dry);
        if (url.endsWith("/queries")) return json(queue.shift() ?? {});
        if (url.includes("/queries/")) return json(results.shift() ?? {});
        if (url.includes("/cancel")) return json({});
        return json({ error: { code: 404, message: "unexpected call" } }, 404);
      }),
    );
  }

  afterEach(() => vi.unstubAllGlobals());

  const target = () => ({ projectId: "acme-analytics", location: "US", credential: serviceAccountKeySchema.parse(keyFile()) });
  const done = { jobComplete: true, schema: { fields: [{ name: "n", type: "INTEGER" }] }, rows: [{ f: [{ v: "7" }] }], totalRows: "1" };

  it("dry-runs, then runs capped at the byte limit, with named parameters", async () => {
    mockGoogle({ dry: { statistics: { query: { statementType: "SELECT", totalBytesProcessed: "1000" } } }, query: [done] });
    const result = await queryBigquery(target(), "SELECT @n AS n", { n: 7, country: "IN" }, 10);
    expect(result.rows).toEqual([{ n: 7 }]);
    const run = calls.find((call) => call.url.endsWith("/queries"))!;
    expect(run.body).toMatchObject({ useLegacySql: false, maximumBytesBilled: String(10 * 1024 ** 3), parameterMode: "NAMED" });
    expect(run.body?.queryParameters).toEqual([
      { name: "n", parameterType: { type: "INT64" }, parameterValue: { value: "7" } },
      { name: "country", parameterType: { type: "STRING" }, parameterValue: { value: "IN" } },
    ]);
    // The token came from Google's fixed endpoint, signed for the right account.
    expect(calls[0]?.url).toBe("https://oauth2.googleapis.com/token");
  });

  it.each(["INSERT", "UPDATE", "DELETE", "MERGE", "CREATE_TABLE", "DROP_TABLE", "SCRIPT", "EXPORT_DATA"])("refuses a %s before running it", async (statementType) => {
    mockGoogle({ dry: { statistics: { query: { statementType, totalBytesProcessed: "0" } } } });
    const error = await queryBigquery(target(), "…", {}, 10).catch((e: unknown) => e);
    expect((error as BigqueryError).code).toBe("read_only");
    expect(calls.some((call) => call.url.endsWith("/queries"))).toBe(false);
  });

  it("refuses a query that would scan more than the limit, and says how much", async () => {
    mockGoogle({ dry: { statistics: { query: { statementType: "SELECT", totalBytesProcessed: String(50 * 1024 ** 3) } } } });
    const error = (await queryBigquery(target(), "SELECT * FROM huge", {}, 10).catch((e: unknown) => e)) as BigqueryError;
    expect(error.code).toBe("too_expensive");
    expect(bigquerySource.toError(error)?.error.message).toMatch(/50 GB, over the 10 GB per-query limit/);
    expect(calls.some((call) => call.url.endsWith("/queries"))).toBe(false);
  });

  it("waits for a slow job, then returns its rows", async () => {
    const pending = { jobComplete: false, jobReference: { projectId: "acme-analytics", jobId: "job_1", location: "US" } };
    mockGoogle({ dry: { statistics: { query: { statementType: "SELECT", totalBytesProcessed: "1" } } }, query: [pending], results: [pending, done] });
    const result = await queryBigquery(target(), "SELECT 7 AS n", {}, 10);
    expect(result.rows).toEqual([{ n: 7 }]);
    expect(calls.filter((call) => call.url.includes("/queries/job_1"))).toHaveLength(2);
  });

  it("cancels a job that outlives the wait", async () => {
    const pending = { jobComplete: false, jobReference: { projectId: "acme-analytics", jobId: "job_2", location: "US" } };
    mockGoogle({ dry: { statistics: { query: { statementType: "SELECT", totalBytesProcessed: "1" } } }, query: [pending], results: Array(50).fill(pending) });
    const error = (await queryBigquery(target(), "SELECT 1", {}, 10, { timeoutMs: 1 }).catch((e: unknown) => e)) as BigqueryError;
    expect(error.code).toBe("timeout");
    expect(calls.some((call) => call.url.includes("/jobs/job_2/cancel"))).toBe(true);
  });

  it("refuses parameter names that aren't identifiers", async () => {
    mockGoogle({ dry: { statistics: { query: { statementType: "SELECT", totalBytesProcessed: "1" } } } });
    const error = (await queryBigquery(target(), "SELECT 1", { "x y": 1 }, 10).catch((e: unknown) => e)) as BigqueryError;
    expect(error.code).toBe("bad_query");
  });
});

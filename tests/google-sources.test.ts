import { decodeJwt, exportPKCS8, generateKeyPair } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { fromGoogleError, GoogleApiError } from "@/lib/sources/google/api";
import { serviceAccountKeySchema } from "@/lib/sources/google/credential";
import { ga4ConfigSchema } from "@/lib/sources/ga4/catalog";
import { runGa4Report, toReportResult } from "@/lib/sources/ga4/client";
import { ga4Source } from "@/lib/sources/ga4/source";
import { normalizeSiteUrl, searchConsoleConfigSchema } from "@/lib/sources/searchconsole/catalog";
import { querySearchAnalytics } from "@/lib/sources/searchconsole/client";
import { searchConsoleSource } from "@/lib/sources/searchconsole/source";

let credential: string;

beforeAll(async () => {
  const { privateKey } = await generateKeyPair("RS256", { extractable: true });
  credential = serviceAccountKeySchema.parse(
    JSON.stringify({
      type: "service_account",
      project_id: "acme-site",
      private_key: await exportPKCS8(privateKey),
      client_email: "dashboards-reader@acme-site.iam.gserviceaccount.com",
    }),
  );
});

describe("Search Console properties", () => {
  it.each([
    ["sc-domain:Example.com", "sc-domain:example.com"],
    ["example.com", "sc-domain:example.com"],
    ["https://www.example.com", "https://www.example.com/"],
    ["https://www.example.com/blog", "https://www.example.com/blog/"],
    ["http://example.com/", "http://example.com/"],
  ])("reads %j as %j", (input, expected) => {
    expect(normalizeSiteUrl(input)).toBe(expected);
  });

  it.each(["", "not a site", "https://user:pw@example.com/", "https://example.com/?x=1", "ftp://example.com/", "sc-domain:"])("refuses %j", (input) => {
    expect(normalizeSiteUrl(input)).toBeNull();
    expect(searchConsoleConfigSchema.safeParse({ siteUrl: input }).success).toBe(false);
  });
});

describe("GA4 property IDs", () => {
  it("accepts the numeric ID, with or without properties/", () => {
    expect(ga4ConfigSchema.parse({ propertyId: "properties/123456789" })).toEqual({ propertyId: "123456789" });
    expect(ga4ConfigSchema.parse({ propertyId: " 123456789 " })).toEqual({ propertyId: "123456789" });
  });

  it("refuses a measurement ID", () => {
    expect(ga4ConfigSchema.safeParse({ propertyId: "G-ABC123" }).success).toBe(false);
  });
});

describe("fromGoogleError", () => {
  it("spots a disabled API and keeps where to enable it", () => {
    const error = fromGoogleError(403, {
      error: {
        code: 403,
        status: "PERMISSION_DENIED",
        message: "Google Analytics Data API has not been used in project 123 before or it is disabled.",
        details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "SERVICE_DISABLED", metadata: { activationUrl: "https://console.developers.google.com/apis/api/analyticsdata.googleapis.com/overview?project=123" } }],
      },
    });
    expect(error.code).toBe("not_enabled");
    expect(error.activationUrl).toContain("analyticsdata");
  });

  it.each<[number, string, string]>([
    [403, "PERMISSION_DENIED", "access_denied"],
    [400, "INVALID_ARGUMENT", "bad_request"],
    [429, "RESOURCE_EXHAUSTED", "rate_limited"],
    [401, "UNAUTHENTICATED", "key_rejected"],
    [404, "NOT_FOUND", "not_found"],
    [503, "UNAVAILABLE", "unavailable"],
  ])("HTTP %i %s is %s", (status, rpcStatus, code) => {
    expect(fromGoogleError(status, { error: { code: status, status: rpcStatus, message: "m" } }).code).toBe(code);
  });

  it("reads Search Console's older error shape", () => {
    expect(fromGoogleError(403, { error: { code: 403, message: "User does not have sufficient permission for site", errors: [{ reason: "forbidden" }] } }).code).toBe("access_denied");
    expect(fromGoogleError(429, { error: { code: 429, message: "Quota exceeded", errors: [{ reason: "quotaExceeded" }] } }).code).toBe("rate_limited");
  });
});

describe("toReportResult", () => {
  it("turns GA4 rows into chartable values and passes on GA4's caveats", () => {
    const result = toReportResult(
      {
        dimensionHeaders: [{ name: "date" }, { name: "sessionDefaultChannelGroup" }],
        metricHeaders: [{ name: "sessions", type: "TYPE_INTEGER" }, { name: "engagementRate", type: "TYPE_FLOAT" }],
        rows: [
          { dimensionValues: [{ value: "20261101" }, { value: "Organic Search" }], metricValues: [{ value: "1832" }, { value: "0.61" }] },
          { dimensionValues: [{ value: "20261101" }, { value: "Direct" }], metricValues: [{ value: "912" }, { value: "0.55" }] },
        ],
        rowCount: 60,
        metadata: { subjectToThresholding: true },
      },
      1,
    );
    expect(result.columns).toEqual(["date", "sessionDefaultChannelGroup", "sessions", "engagementRate"]);
    expect(result.rows).toEqual([{ date: "2026-11-01", sessionDefaultChannelGroup: "Organic Search", sessions: 1832, engagementRate: 0.61 }]);
    expect(result.truncated).toBe(true);
    expect(result.notes.join(" ")).toMatch(/thresholding/);
  });
});

describe("requests to Google", () => {
  type Call = { url: string; body: Record<string, unknown> | string | null };
  let calls: Call[];

  function mockGoogle(answer: (url: string) => { status?: number; body: object }) {
    calls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init: RequestInit) => {
        const url = String(input);
        const raw = init.body;
        const body = raw instanceof URLSearchParams ? raw.toString() : typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : null;
        calls.push({ url, body });
        const json = (data: object, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
        if (url === "https://oauth2.googleapis.com/token") return json({ access_token: `token-${calls.length}`, expires_in: 3600 });
        const { status, body: data } = answer(url);
        return json(data, status);
      }),
    );
  }

  afterEach(() => vi.unstubAllGlobals());

  const scopeOf = (call: Call | undefined) => decodeJwt(new URLSearchParams(call?.body as string).get("assertion") ?? "").scope;

  it("asks Search Console with the read-only scope, the site in the path, and filters as one AND group", async () => {
    mockGoogle(() => ({ body: { rows: [{ keys: ["2026-11-01", "pricing"], clicks: 12, impressions: 400, ctr: 0.03, position: 4.2 }] } }));
    const result = await querySearchAnalytics(
      { siteUrl: "sc-domain:example-sc.com", credential },
      { startDate: "2026-10-01", endDate: "2026-10-31", dimensions: ["date", "query"], filters: [{ dimension: "country", operator: "equals", expression: "ind" }] },
      100,
    );
    expect(result.rows).toEqual([{ date: "2026-11-01", query: "pricing", clicks: 12, impressions: 400, ctr: 0.03, position: 4.2 }]);
    const api = calls.find((call) => call.url.includes("searchAnalytics"))!;
    expect(api.url).toBe("https://searchconsole.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample-sc.com/searchAnalytics/query");
    expect(api.body).toMatchObject({ type: "web", dataState: "final", rowLimit: 101, dimensionFilterGroups: [{ groupType: "and", filters: [{ dimension: "country", operator: "equals", expression: "ind" }] }] });
    expect(scopeOf(calls.find((call) => call.url.includes("oauth2")))).toBe("https://www.googleapis.com/auth/webmasters.readonly");
  });

  it("asks GA4 with the read-only scope, and maps order and limits", async () => {
    mockGoogle(() => ({ body: { dimensionHeaders: [{ name: "country" }], metricHeaders: [{ name: "activeUsers" }], rows: [], rowCount: 0 } }));
    await runGa4Report(
      { propertyId: "424242", credential },
      { startDate: "30daysAgo", endDate: "yesterday", dimensions: ["country"], metrics: ["activeUsers"], orderBys: [{ metric: "activeUsers", desc: true }], limit: 10 },
      200,
    );
    const api = calls.find((call) => call.url.includes("runReport"))!;
    expect(api.url).toBe("https://analyticsdata.googleapis.com/v1beta/properties/424242:runReport");
    expect(api.body).toMatchObject({
      dateRanges: [{ startDate: "30daysAgo", endDate: "yesterday" }],
      dimensions: [{ name: "country" }],
      metrics: [{ name: "activeUsers" }],
      orderBys: [{ metric: { metricName: "activeUsers" }, desc: true }],
      limit: 11,
    });
    expect(scopeOf(calls.find((call) => call.url.includes("oauth2")))).toBe("https://www.googleapis.com/auth/analytics.readonly");
  });

  it("tells the user how to grant access when the account isn't on the property", async () => {
    mockGoogle(() => ({ status: 403, body: { error: { code: 403, status: "PERMISSION_DENIED", message: "User does not have sufficient permissions for this property." } } }));
    const ga4 = await runGa4Report({ propertyId: "424243", credential }, { startDate: "7daysAgo", endDate: "today", metrics: ["sessions"] }, 1).catch((e: unknown) => e);
    expect(ga4Source.toError(ga4)).toMatchObject({ status: "invalid", error: { field: "propertyId", message: expect.stringMatching(/Property access management/) } });

    const sc = await querySearchAnalytics({ siteUrl: "https://www.example-denied.com/", credential }, { startDate: "2026-10-01", endDate: "2026-10-02" }, 1).catch((e: unknown) => e);
    expect(searchConsoleSource.toError(sc)).toMatchObject({ status: "invalid", error: { field: "siteUrl", message: expect.stringMatching(/Users and permissions/) } });
  });

  it("gives the agent GA4's reason for a bad report", async () => {
    mockGoogle(() => ({ status: 400, body: { error: { code: 400, status: "INVALID_ARGUMENT", message: "Field sesions is not a valid metric." } } }));
    const error = (await runGa4Report({ propertyId: "424244", credential }, { startDate: "7daysAgo", endDate: "today", metrics: ["sesions"] }, 1).catch((e: unknown) => e)) as GoogleApiError;
    expect(error.code).toBe("bad_request");
    expect(ga4Source.toError(error)?.error.message).toMatch(/sesions is not a valid metric.*ga4_fields/);
  });

  it("refuses a key Google rejects, and keeps it apart from other failures", async () => {
    calls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "invalid_grant", error_description: "Invalid JWT Signature." }), { status: 400 })),
    );
    const { privateKey } = await generateKeyPair("RS256", { extractable: true });
    const revoked = serviceAccountKeySchema.parse(
      JSON.stringify({ type: "service_account", private_key: await exportPKCS8(privateKey), client_email: "revoked@acme-site.iam.gserviceaccount.com" }),
    );
    const error = await runGa4Report({ propertyId: "424245", credential: revoked }, { startDate: "7daysAgo", endDate: "today", metrics: ["sessions"] }, 1).catch((e: unknown) => e);
    expect(ga4Source.toError(error)).toMatchObject({ status: "invalid", error: { code: "key_rejected", field: "serviceAccountKey" } });
  });
});

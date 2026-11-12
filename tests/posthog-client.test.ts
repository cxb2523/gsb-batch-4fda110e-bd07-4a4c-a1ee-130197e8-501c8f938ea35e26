import { describe, expect, it, vi } from "vitest";

import { PostHogError, runHogQLQuery, testConnection, type PostHogTarget } from "@/lib/sources/posthog/client";

const target: PostHogTarget = { hostKind: "posthog_eu", projectId: "42", apiKey: "phx_key" };

function respond(status: number, body: unknown) {
  return vi.fn<typeof fetch>(async () => Response.json(body, { status }));
}

async function codeFor(fetchImpl: typeof fetch) {
  const error = await testConnection(target, { fetch: fetchImpl }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(PostHogError);
  return (error as PostHogError).code;
}

describe("runHogQLQuery", () => {
  it("posts HogQL to the fixed host for the region, with the key as a bearer token", async () => {
    const fetchImpl = respond(200, { results: [[1]], columns: ["1"] });
    await expect(runHogQLQuery(target, "SELECT 1", { fetch: fetchImpl })).resolves.toEqual({
      results: [[1]],
      columns: ["1"],
    });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://eu.posthog.com/api/projects/42/query/");
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer phx_key");
    expect(JSON.parse(String(init?.body))).toEqual({
      query: { kind: "HogQLQuery", query: "SELECT 1" },
      name: "opendashboards",
    });
  });
});

describe("error classification", () => {
  it("reads PostHog's 403 authentication_error as a bad key", async () => {
    const body = {
      type: "authentication_error",
      code: "authentication_failed",
      detail: "Personal API key found in request Authorization header is invalid.",
    };
    expect(await codeFor(respond(403, body))).toBe("invalid_key");
    expect(await codeFor(respond(401, body))).toBe("invalid_key");
  });

  it("tells a missing scope from a forbidden project", async () => {
    expect(
      await codeFor(
        respond(403, {
          type: "authentication_error_but_not",
          code: "permission_denied",
          detail: "API key missing required scope 'query:read'",
        }),
      ),
    ).toBe("missing_scope");
    expect(
      await codeFor(
        respond(403, { code: "permission_denied", detail: "You don't have access to the project." }),
      ),
    ).toBe("project_forbidden");
  });

  it("maps 404, 429, 5xx and other statuses", async () => {
    expect(await codeFor(respond(404, {}))).toBe("project_not_found");
    expect(await codeFor(respond(429, {}))).toBe("rate_limited");
    expect(await codeFor(respond(502, {}))).toBe("unavailable");
    const slow = "Query has hit the max execution time before completing. See our docs for how to improve your query performance.";
    expect(await codeFor(respond(504, { detail: slow }))).toBe("timeout");
    expect(await codeFor(respond(504, {}))).toBe("unavailable");
    // 400 is a query PostHog couldn't run; its detail is kept for the query's author.
    expect(await codeFor(respond(400, { detail: "Unknown table" }))).toBe("bad_query");
    expect(await codeFor(respond(418, {}))).toBe("unexpected");
  });

  it("treats network errors and malformed bodies as unavailable or unexpected", async () => {
    const network = vi.fn<typeof fetch>(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await codeFor(network)).toBe("unavailable");
    expect(await codeFor(respond(200, { nope: true }))).toBe("unexpected");
  });

  it("never puts the key in the error message", async () => {
    const error = await testConnection(target, { fetch: respond(403, {}) }).catch((e: Error) => e);
    expect(String((error as Error).message)).not.toContain("phx_key");
  });
});

describe("queryProblem", () => {
  it("keeps PostHog's reason and drops the expanded SQL", async () => {
    const { queryProblem } = await import("@/lib/sources/posthog/source");
    expect(
      queryProblem(
        "Column 'st' is not under aggregate function and not in GROUP BY keys. In query SELECT toString(st) FROM events WHERE equals(events.team_id, 79652)",
      ),
    ).toBe("Column 'st' is not under aggregate function and not in GROUP BY keys.");
  });

  it("leaves a detail without SQL alone", async () => {
    const { queryProblem } = await import("@/lib/sources/posthog/source");
    expect(queryProblem("Unable to resolve field: foo")).toBe("Unable to resolve field: foo");
  });
});

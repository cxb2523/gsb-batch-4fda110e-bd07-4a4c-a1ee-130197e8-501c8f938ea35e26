import { afterEach, describe, expect, it, vi } from "vitest";

const metric = vi.hoisted(() => vi.fn());
vi.mock("@vercel/functions", () => ({ metric }));

import { logError, redact } from "@/lib/log";

afterEach(() => vi.restoreAllMocks());

describe("redact", () => {
  it("strips PostHog keys", () => {
    expect(redact("key phx_abcdef123 refused")).toBe("key phx_[redacted] refused");
  });

  it("strips the password from a connection string", () => {
    expect(redact("connect postgres://opendashboards:hunter2@db.example.com:5432/app failed")).toBe(
      "connect postgres://opendashboards:[redacted]@db.example.com:5432/app failed",
    );
  });

  it("strips bearer tokens and JWTs", () => {
    expect(redact("Authorization: Bearer abc.def-123")).toBe("Authorization: Bearer [redacted]");
    expect(redact("token eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl here")).toBe("token [redacted-jwt] here");
  });

  it("leaves ordinary text and URLs alone", () => {
    expect(redact("GET https://us.posthog.com:443/api failed at 12:30")).toBe("GET https://us.posthog.com:443/api failed at 12:30");
  });
});

describe("logError", () => {
  it("logs redacted text and counts the root cause", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const root = Object.assign(new Error("connect postgres://u:secret@h failed"), { code: "ECONNREFUSED" });
    logError("apps.list", new Error("query failed", { cause: root }));

    expect(log.mock.calls[0][0]).not.toContain("secret");
    expect(metric).toHaveBeenCalledWith("opendashboards.error", 1, { context: "apps.list", cause: "ECONNREFUSED", env: "local" });
  });
});

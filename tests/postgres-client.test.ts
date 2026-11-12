import { describe, expect, it } from "vitest";

import { testPostgresConnection, type PostgresTarget } from "@/lib/sources/postgres/client";
import { parseConnectionString, postgresAddress } from "@/lib/sources/postgres/catalog";
import { PostgresError, toPostgresError } from "@/lib/sources/postgres/errors";
import { BlockedAddressError } from "@/lib/net/guarded-socket";

import { TEST_DATABASE_URL } from "./global-setup";

describe("parseConnectionString", () => {
  it("reads every field, decoding escapes", () => {
    expect(
      parseConnectionString("postgresql://analyst:p%40ss%2Fword@db.example.com:6543/app?sslmode=require"),
    ).toEqual({
      host: "db.example.com",
      port: 6543,
      database: "app",
      user: "analyst",
      password: "p@ss/word",
      sslMode: "require",
    });
  });

  it("maps sslmode to the closest mode we support", () => {
    const mode = (sslmode: string) => parseConnectionString(`postgres://h/db?sslmode=${sslmode}`)?.sslMode;
    expect(mode("verify-ca")).toBe("verify-full");
    expect(mode("verify-full")).toBe("verify-full");
    expect(mode("prefer")).toBe("require");
    // OpenDashboards never connects unencrypted, so "disable" still encrypts.
    expect(mode("disable")).toBe("require");
    expect(parseConnectionString("postgres://h/db")?.sslMode).toBeUndefined();
  });

  it("handles IPv6 hosts and leaves out what's missing", () => {
    expect(parseConnectionString("postgres://[2606:4700::1111]/app")).toEqual({ host: "2606:4700::1111", database: "app" });
  });

  it("rejects anything that isn't a Postgres URL", () => {
    expect(parseConnectionString("mysql://h/db")).toBeNull();
    expect(parseConnectionString("not a url")).toBeNull();
  });

  it("formats an address for lists", () => {
    expect(postgresAddress({ host: "db.example.com", port: 5432, database: "app", user: "analyst" })).toBe(
      "analyst@db.example.com:5432/app",
    );
  });
});

describe("toPostgresError", () => {
  it.each([
    [{ code: "28P01" }, "auth_failed"],
    [{ code: "3D000" }, "database_not_found"],
    [{ code: "42501" }, "permission_denied"],
    [{ code: "ENOTFOUND" }, "host_not_found"],
    [{ code: "ECONNREFUSED" }, "unreachable"],
    [{ code: "DEPTH_ZERO_SELF_SIGNED_CERT" }, "tls_failed"],
    [new Error("The server does not support SSL connections"), "tls_failed"],
    [new Error("Connection terminated due to connection timeout"), "timeout"],
    [new BlockedAddressError("db.internal", "10.0.0.5"), "host_blocked"],
    [new Error("something odd"), "unexpected"],
  ])("classifies %o as %s", (error, code) => {
    expect(toPostgresError(error).code).toBe(code);
  });
});

/**
 * The local Postgres from docker-compose is reachable, but it's on localhost:
 * the guard must refuse it by name and by IP before any login is attempted.
 */
describe("testPostgresConnection", () => {
  const url = new URL(TEST_DATABASE_URL);
  const local: PostgresTarget = {
    host: url.hostname,
    port: Number(url.port),
    database: url.pathname.slice(1),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    sslMode: "require",
  };
  const code = (target: Partial<PostgresTarget>) =>
    testPostgresConnection({ ...local, ...target }).then(
      () => "ok",
      (error: unknown) => (error instanceof PostgresError ? error.code : `not a PostgresError: ${String(error)}`),
    );

  it("refuses a running local server by name and by IP", async () => {
    expect(await code({})).toBe("host_blocked");
    expect(await code({ host: "127.0.0.1" })).toBe("host_blocked");
    expect(await code({ host: "::1" })).toBe("host_blocked");
  });

  it("refuses private and metadata addresses without connecting", async () => {
    expect(await code({ host: "10.0.0.5" })).toBe("host_blocked");
    expect(await code({ host: "169.254.169.254" })).toBe("host_blocked");
  });
});

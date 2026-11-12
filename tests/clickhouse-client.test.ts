import { describe, expect, it } from "vitest";

import { clickhouseUrl, listClickhouseTables, queryClickhouse } from "@/lib/sources/clickhouse/client";
import { ClickhouseError, fromResponse, serverMessage, toClickhouseError } from "@/lib/sources/clickhouse/errors";
import { clickhouseSource } from "@/lib/sources/clickhouse/source";
import { BlockedAddressError } from "@/lib/net/guarded-socket";

const target = { host: "ch.example.com", port: 8443, database: "analytics" };

describe("clickhouseUrl", () => {
  it("runs every query read-only, with time and row limits", () => {
    const url = clickhouseUrl(target, { maxRows: 200, timeoutMs: 30_000 });
    expect(url.origin).toBe("https://ch.example.com:8443");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      database: "analytics",
      readonly: "1",
      max_execution_time: "28",
      timeout_overflow_mode: "throw",
      max_result_rows: "201",
      result_overflow_mode: "break",
      wait_end_of_query: "1",
    });
  });

  it("sends values as parameters, never in the SQL", () => {
    const url = clickhouseUrl(target, { maxRows: 1, timeoutMs: 10_000, params: { event: "signup'; DROP TABLE x", since: 5, gone: null } });
    expect(url.searchParams.get("param_event")).toBe("signup'; DROP TABLE x");
    expect(url.searchParams.get("param_since")).toBe("5");
    expect(url.searchParams.get("param_gone")).toBe("\\N");
  });

  it("refuses parameter names that could become other settings", () => {
    expect(() => clickhouseUrl(target, { maxRows: 1, timeoutMs: 10_000, params: { "x&readonly=0": 1 } })).toThrow(ClickhouseError);
  });

  it("leaves out what a locked-down profile won't let us change", () => {
    const readonly2 = Object.fromEntries(clickhouseUrl(target, { maxRows: 10, timeoutMs: 10_000, lockdown: "profile-readonly-2" }).searchParams);
    expect(readonly2.readonly).toBeUndefined();
    expect(readonly2.max_execution_time).toBe("8");
    const readonly1 = Object.fromEntries(clickhouseUrl(target, { maxRows: 10, timeoutMs: 10_000, lockdown: "profile-readonly-1" }).searchParams);
    expect(readonly1.readonly).toBe("1");
    expect(readonly1.max_execution_time).toBeUndefined();
    expect(readonly1.max_result_rows).toBeUndefined();
  });

  it("brackets IPv6 hosts", () => {
    expect(clickhouseUrl({ ...target, host: "2606:4700::1111" }, { maxRows: 1, timeoutMs: 10_000 }).host).toBe("[2606:4700::1111]:8443");
  });
});

describe("ClickHouse errors", () => {
  it("strips the code prefix, version and stack trace", () => {
    expect(serverMessage("Code: 60. DB::Exception: Unknown table expression identifier 'nope' in scope SELECT * FROM nope. (UNKNOWN_TABLE) (version 25.8.33.6 (official build))\n")).toBe(
      "Unknown table expression identifier 'nope' in scope SELECT * FROM nope. (UNKNOWN_TABLE)",
    );
  });

  it.each<[number, string | undefined, string, string]>([
    [404, "60", "Code: 60. DB::Exception: Unknown table", "bad_query"],
    [500, "159", "Code: 159. DB::Exception: Timeout exceeded", "timeout"],
    [500, "241", "Code: 241. DB::Exception: Memory limit exceeded", "too_heavy"],
    [403, "164", "Code: 164. DB::Exception: Cannot execute query in readonly mode", "read_only"],
    [401, "516", "Code: 516. DB::Exception: default: Authentication failed", "auth_failed"],
    [404, "81", "Code: 81. DB::Exception: Database nope does not exist", "database_not_found"],
    [500, "202", "Code: 202. DB::Exception: Too many simultaneous queries", "rate_limited"],
    [502, undefined, "Bad gateway", "unreachable"],
    [400, undefined, "Code: 62. DB::Exception: Syntax error", "bad_query"],
  ])("classifies HTTP %i with code %s", (status, header, body, code) => {
    expect(fromResponse(status, header, body).code).toBe(code);
  });

  it("classifies network failures", () => {
    expect(toClickhouseError(Object.assign(new Error("x"), { code: "ENOTFOUND" })).code).toBe("host_not_found");
    expect(toClickhouseError(new BlockedAddressError("ch.internal", "10.1.2.3")).code).toBe("host_blocked");
    expect(toClickhouseError(Object.assign(new Error("self-signed certificate"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" })).code).toBe("tls_failed");
  });

  it("tells the agent how to fix a heavy query", () => {
    expect(clickhouseSource.toError(new ClickhouseError("too_heavy", "Memory limit exceeded"))?.error.message).toMatch(/shorter time range|fewer keys/);
  });
});

/*
 * The settings above, against a real server (plain HTTP, so it goes around
 * the HTTPS client; the settings are what's under test):
 *   docker run -d --name opendashboards-clickhouse-test -e CLICKHOUSE_PASSWORD=rootpw -p 127.0.0.1:38123:8123 clickhouse/clickhouse-server:25.8
 *   CLICKHOUSE_TEST_PORT=38123 pnpm test tests/clickhouse-client.test.ts
 */
const localPort = Number(process.env.CLICKHOUSE_TEST_PORT ?? 0);

describe.skipIf(!localPort)("OpenDashboards' settings on a real ClickHouse server", () => {
  async function run(sql: string, options: { maxRows?: number; timeoutMs?: number; params?: Record<string, string | number> } = {}) {
    const url = clickhouseUrl({ host: "localhost", port: localPort, database: "default" }, { maxRows: options.maxRows ?? 100, timeoutMs: options.timeoutMs ?? 10_000, params: options.params });
    const response = await fetch(`http://127.0.0.1:${localPort}/${url.search}`, {
      method: "POST",
      headers: { "X-ClickHouse-User": "default", "X-ClickHouse-Key": "rootpw" },
      body: sql,
    });
    const body = await response.text();
    return response.ok ? { ok: true as const, body: JSON.parse(body) as { data: unknown[][] } } : { ok: false as const, error: fromResponse(response.status, response.headers.get("x-clickhouse-exception-code") ?? undefined, body) };
  }

  it.each([
    "CREATE TABLE t (x Int8) ENGINE = Memory",
    "INSERT INTO system.numbers SELECT 1",
    "CREATE TEMPORARY TABLE t (x Int8)",
    "SELECT * FROM url('https://example.com', 'LineAsString')",
    "SELECT * FROM file('/etc/passwd', 'LineAsString')",
    "SELECT * FROM executable('x.sh', 'TSV', 'x String')",
    "SELECT * FROM remote('example.com', system.one)",
    "SELECT * FROM s3('https://example.com/x.csv')",
    "SELECT 1 SETTINGS readonly = 0",
    "SELECT 1 SETTINGS max_result_rows = 0",
  ])("refuses %j", async (sql) => {
    const result = await run(sql);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("read_only");
  });

  it("refuses more than one statement", async () => {
    const result = await run("SELECT 1; SELECT 2");
    expect(result.ok).toBe(false);
  });

  it("stops at the row limit", async () => {
    const result = await run("SELECT number FROM numbers(10000000)", { maxRows: 200 });
    expect(result.ok && result.body.data.length).toBeLessThanOrEqual(1_000);
  });

  it("stops at the time limit", async () => {
    const result = await run("SELECT count() FROM numbers(100000000000) WHERE sipHash64(number) = 1", { timeoutMs: 3_000 });
    expect(!result.ok && result.error.code).toBe("timeout");
  });

  it("works for users an admin locked down in their profile", async () => {
    const admin = (sql: string) =>
      fetch(`http://127.0.0.1:${localPort}/`, { method: "POST", headers: { "X-ClickHouse-User": "default", "X-ClickHouse-Key": "rootpw" }, body: sql });
    for (const [user, level] of [["dashboards_ro1", 1], ["dashboards_ro2", 2]] as const) {
      await admin(`CREATE USER IF NOT EXISTS ${user} IDENTIFIED BY 'pw' SETTINGS readonly = ${level}`);
      await admin(`GRANT SELECT ON default.* TO ${user}`);
    }
    const as = async (user: string, lockdown: "full" | "profile-readonly-1" | "profile-readonly-2") => {
      const url = clickhouseUrl({ host: "localhost", port: localPort, database: "default" }, { maxRows: 10, timeoutMs: 10_000, lockdown });
      const response = await fetch(`http://127.0.0.1:${localPort}/${url.search}`, { method: "POST", headers: { "X-ClickHouse-User": user, "X-ClickHouse-Key": "pw" }, body: "SELECT 1" });
      return { status: response.status, body: await response.text() };
    };
    // What the client tries first fails with "Cannot modify …"; the fallback it picks works.
    expect((await as("dashboards_ro1", "full")).body).toMatch(/Cannot modify 'max_\w+' setting/);
    expect((await as("dashboards_ro1", "profile-readonly-1")).status).toBe(200);
    expect((await as("dashboards_ro2", "full")).body).toMatch(/Cannot modify 'readonly' setting/);
    expect((await as("dashboards_ro2", "profile-readonly-2")).status).toBe(200);
  });

  it("binds typed parameters", async () => {
    const result = await run("SELECT {n:UInt8} + 1 AS x, {s:String} AS s", { params: { n: 41, s: "it's" } });
    expect(result.ok && result.body.data).toEqual([[42, "it's"]]);
  });
});

/*
 * The whole path (guarded HTTPS, TLS, JSON) against ClickHouse's public,
 * read-only playground: LIVE_TESTS=1 pnpm test tests/clickhouse-client.test.ts
 */
describe.skipIf(!process.env.LIVE_TESTS)("ClickHouse playground (live)", () => {
  const play = { host: "play.clickhouse.com", port: 443, database: "default", user: "explorer", password: "", sslMode: "verify-full" as const };

  it("runs a query and returns typed rows", async () => {
    const result = await queryClickhouse(play, "SELECT number AS n, toString(number) AS s FROM numbers(5)", {}, 3);
    expect(result).toEqual({ columns: ["n", "s"], rows: [{ n: 0, s: "0" }, { n: 1, s: "1" }, { n: 2, s: "2" }], truncated: true });
  });

  it("lists tables", async () => {
    const result = await listClickhouseTables(play);
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.columns).toEqual(["database", "table", "engine", "total_rows", "columns"]);
  });

  it("explains an unknown table", async () => {
    const error = await queryClickhouse(play, "SELECT * FROM no_such_table_here", {}, 1).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ClickhouseError);
    expect((error as ClickhouseError).code).toBe("bad_query");
  });
}, 60_000);

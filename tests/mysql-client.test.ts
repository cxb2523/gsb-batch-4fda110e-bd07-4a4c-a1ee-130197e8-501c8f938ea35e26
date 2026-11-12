import mysql, { type Connection } from "mysql2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  checkReadOnlySql,
  mysqlConnectionOptions,
  readOnlySessionStatements,
  readRows,
  WRITE_ACCESS_SQL,
} from "@/lib/sources/mysql/client";
import { MysqlError, toMysqlError } from "@/lib/sources/mysql/errors";
import { mysqlSource } from "@/lib/sources/mysql/source";
import { BlockedAddressError } from "@/lib/net/guarded-socket";

describe("checkReadOnlySql", () => {
  it.each(["SELECT 1", "  select * from t;", "WITH x AS (SELECT 1) SELECT * FROM x", "(SELECT 1) UNION (SELECT 2)", "-- note\nSELECT 1", "/* c */ SELECT 1", "SHOW TABLES"])(
    "allows %j",
    (sql) => expect(() => checkReadOnlySql(sql)).not.toThrow(),
  );

  it.each([
    ["INSERT INTO t VALUES (1)", "start with SELECT"],
    ["DROP TABLE t", "start with SELECT"],
    ["LOAD DATA LOCAL INFILE '/etc/passwd' INTO TABLE t", "start with SELECT"],
    ["SELECT 1 /*!50000 , (SELECT 2) */", "Executable comments"],
    ["/*M! DROP TABLE t */ SELECT 1", "Executable comments"],
    ["SELECT * FROM t INTO OUTFILE '/tmp/x'", "INTO OUTFILE"],
    ["SELECT * FROM t INTO DUMPFILE '/tmp/x'", "INTO OUTFILE"],
    ["SELECT * FROM t FOR UPDATE", "Locking reads"],
    ["SELECT * FROM t LOCK IN SHARE MODE", "Locking reads"],
  ])("refuses %j", (sql, reason) => {
    expect(() => checkReadOnlySql(sql)).toThrow(MysqlError);
    try {
      checkReadOnlySql(sql);
    } catch (error) {
      expect((error as MysqlError).code).toBe("read_only");
      expect((error as MysqlError).detail).toContain(reason);
    }
  });
});

describe("toMysqlError", () => {
  it.each<[object, string]>([
    [{ errno: 1045, message: "Access denied" }, "auth_failed"],
    [{ errno: 1049, message: "Unknown database" }, "database_not_found"],
    [{ errno: 1044, message: "Access denied to database" }, "permission_denied"],
    [{ errno: 3024, message: "maximum statement execution time exceeded" }, "query_timeout"],
    [{ errno: 1969, message: "Query execution was interrupted (max_statement_time exceeded)" }, "query_timeout"],
    [{ errno: 1792, message: "Cannot execute statement in a READ ONLY transaction." }, "read_only"],
    [{ errno: 1146, sqlState: "42S02", message: "Table 'shop.nope' doesn't exist" }, "bad_query"],
    [{ errno: 1064, sqlState: "42000", message: "You have an error in your SQL syntax" }, "bad_query"],
    [{ code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND" }, "host_not_found"],
    [{ code: "ECONNREFUSED", message: "connect ECONNREFUSED" }, "unreachable"],
    [{ code: "ETIMEDOUT", message: "connect ETIMEDOUT" }, "connect_timeout"],
    [{ code: "HANDSHAKE_NO_SSL_SUPPORT", message: "Server does not support secure connection" }, "tls_failed"],
    [{ code: "SELF_SIGNED_CERT_IN_CHAIN", message: "self-signed certificate in certificate chain" }, "tls_failed"],
  ])("classifies %j as %s", (error, code) => {
    expect(toMysqlError(error).code).toBe(code);
  });

  it("finds a blocked address inside a driver error", () => {
    const error = Object.assign(new Error("connect failed"), { cause: new BlockedAddressError("db.internal", "10.0.0.5") });
    expect(toMysqlError(error).code).toBe("host_blocked");
  });

  it("gives the agent something to act on for a timeout", () => {
    const shown = mysqlSource.toError(new MysqlError("query_timeout"));
    expect(shown?.error.message).toMatch(/shorter date range|aggregate/);
  });
});

/*
 * Against real servers, when they're running locally:
 *   docker run -d --name opendashboards-mysql-test -e MYSQL_ROOT_PASSWORD=rootpw -e MYSQL_DATABASE=shop -p 127.0.0.1:33306:3306 mysql:8.4
 *   docker run -d --name opendashboards-mariadb-test -e MARIADB_ROOT_PASSWORD=rootpw -e MARIADB_DATABASE=shop -p 127.0.0.1:33307:3306 mariadb:11.4 --ssl=ON
 *   MYSQL_TEST_PORTS=33306,33307 pnpm test tests/mysql-client.test.ts
 * They connect directly: the address guard would (rightly) refuse localhost.
 */
const ports = (process.env.MYSQL_TEST_PORTS ?? "").split(",").filter(Boolean).map(Number);

describe.skipIf(!ports.length).each(ports)("against the server on port %i", (port) => {
  const target = { host: "127.0.0.1", port, database: "shop", user: "root", password: "rootpw", sslMode: "require" as const };
  let admin: Connection;

  const connect = (overrides: Partial<typeof target> = {}) =>
    new Promise<Connection>((resolve, reject) => {
      const connection = mysql.createConnection(mysqlConnectionOptions({ ...target, ...overrides }));
      connection.on("error", () => {});
      connection.connect((error) => (error ? reject(error) : resolve(connection)));
    });
  const run = (connection: Connection, sql: string) =>
    new Promise<unknown>((resolve, reject) => connection.query(sql, (error, rows) => (error ? reject(error) : resolve(rows))));
  const readOnly = async (overrides: Partial<typeof target> = {}) => {
    const connection = await connect(overrides);
    const [{ version }] = (await run(connection, "SELECT VERSION() AS version")) as { version: string }[];
    for (const statement of readOnlySessionStatements(version, 1_000)) await run(connection, statement);
    return connection;
  };

  beforeAll(async () => {
    admin = await connect();
    await run(admin, "CREATE TABLE IF NOT EXISTS orders (id INT PRIMARY KEY, total DECIMAL(10,2), placed DATETIME, raw BLOB)");
    await run(admin, "DELETE FROM orders");
    await run(admin, "INSERT INTO orders VALUES (1, 10.50, '2026-11-01 10:00:00', X'0102'), (2, 20.00, '2026-11-02 11:00:00', NULL), (3, 5.25, '2026-11-03 12:00:00', NULL)");
    await run(admin, "CREATE USER IF NOT EXISTS 'reader'@'%' IDENTIFIED BY 'readerpw'");
    await run(admin, "GRANT SELECT ON shop.* TO 'reader'@'%'");
  });
  afterAll(() => admin?.destroy());

  it("connects over TLS", async () => {
    const connection = await connect();
    const rows = (await run(connection, "SHOW STATUS LIKE 'Ssl_cipher'")) as { Value: string }[];
    expect(rows[0]?.Value).not.toBe("");
    connection.destroy();
  });

  it("refuses writes and DDL in a read-only session, even as an admin", async () => {
    const connection = await readOnly();
    for (const sql of ["INSERT INTO orders VALUES (9, 1, NOW(), NULL)", "UPDATE orders SET total = 0", "DELETE FROM orders"]) {
      await expect(run(connection, sql)).rejects.toMatchObject({ errno: 1792 });
    }
    // DDL commits implicitly; the session-wide READ ONLY still refuses it.
    await expect(run(connection, "CREATE TABLE sneaky (x INT)")).rejects.toBeTruthy();
    await expect(run(connection, "DROP TABLE orders")).rejects.toBeTruthy();
    connection.destroy();
    const [{ n }] = (await run(admin, "SELECT COUNT(*) AS n FROM orders")) as { n: number }[];
    expect(n).toBe(3);
    const tables = (await run(admin, "SHOW TABLES LIKE 'sneaky'")) as unknown[];
    expect(tables).toHaveLength(0);
  });

  it("refuses more than one statement", async () => {
    const connection = await readOnly();
    await expect(run(connection, "SELECT 1; SELECT 2")).rejects.toMatchObject({ errno: 1064 });
    connection.destroy();
  });

  it("never sends a local file to the server", async () => {
    const connection = await connect();
    await expect(run(connection, "LOAD DATA LOCAL INFILE '/etc/hosts' INTO TABLE orders")).rejects.toBeTruthy();
    connection.destroy();
  });

  it("stops a query at the time limit", async () => {
    const connection = await readOnly();
    const heavy = "SELECT COUNT(*) FROM information_schema.COLUMNS a, information_schema.COLUMNS b, information_schema.COLUMNS c";
    const error = await run(connection, heavy).catch((e: unknown) => e);
    expect(toMysqlError(error).code).toBe("query_timeout");
    connection.destroy();
  });

  it("reads rows as JSON-friendly values and stops at the row limit", async () => {
    const connection = await readOnly();
    const result = await readRows(connection, "SELECT id, total, placed, raw FROM orders WHERE id >= ? ORDER BY id", [1], 2);
    expect(result.columns).toEqual(["id", "total", "placed", "raw"]);
    expect(result.rows).toEqual([
      { id: 1, total: 10.5, placed: "2026-11-01 10:00:00", raw: "0x0102" },
      { id: 2, total: 20, placed: "2026-11-02 11:00:00", raw: null },
    ]);
    expect(result.truncated).toBe(true);
  });

  it("tells a read-only user from one that can write", async () => {
    const asAdmin = await readOnly();
    expect(((await run(asAdmin, WRITE_ACCESS_SQL)) as { can_write: number }[])[0]?.can_write).toBe(1);
    asAdmin.destroy();
    const asReader = await readOnly({ user: "reader", password: "readerpw" });
    expect(((await run(asReader, WRITE_ACCESS_SQL)) as { can_write: number }[])[0]?.can_write).toBe(0);
    asReader.destroy();
  });
});

/*
 * The whole path (guarded socket, TLS, read-only session) against Rfam's
 * public, read-only MySQL 8 server: LIVE_TESTS=1 pnpm test tests/mysql-client.test.ts
 * Its certificate isn't publicly trusted, so this uses "Encrypt only".
 */
describe.skipIf(!process.env.LIVE_TESTS)("Rfam public MySQL (live)", () => {
  const rfam = { host: "mysql-rfam-public.ebi.ac.uk", port: 4497, database: "Rfam", user: "rfamro", password: "", sslMode: "require" as const };

  it("connects, reads, and stops at the row limit", async () => {
    const { queryMysql } = await import("@/lib/sources/mysql/client");
    const result = await queryMysql(rfam, "SELECT rfam_acc, rfam_id FROM family WHERE rfam_acc LIKE ? ORDER BY rfam_acc", ["RF0000%"], 3);
    expect(result.columns).toEqual(["rfam_acc", "rfam_id"]);
    expect(result.rows).toHaveLength(3);
    expect(result.truncated).toBe(true);
  });

  it("lists tables with their columns", async () => {
    const { listMysqlTables } = await import("@/lib/sources/mysql/client");
    const result = await listMysqlTables(rfam);
    expect(result.rows.some((row) => row.table === "family")).toBe(true);
  });

  it("reports that this public user can't write", async () => {
    const { testMysqlConnection } = await import("@/lib/sources/mysql/client");
    const check = await testMysqlConnection(rfam);
    expect(check.serverVersion).toMatch(/^8\./);
    expect(check.canWrite).toBe(false);
  });

  it("refuses to connect when the certificate must be verified", async () => {
    const { testMysqlConnection } = await import("@/lib/sources/mysql/client");
    const error = await testMysqlConnection({ ...rfam, sslMode: "verify-full" }).catch((e: unknown) => e);
    expect((error as MysqlError).code).toBe("tls_failed");
  });
}, 60_000);

import net from "node:net";

import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { postgresClientConfig } from "@/lib/sources/postgres/client";

/*
 * A user's Postgres server must only ever get the password the user gave.
 * pg treats an empty password as missing and falls back to PGPASSWORD (and
 * ~/.pgpass), which on our servers can be OUR database's password. This fake
 * server asks for the password in cleartext and records what arrives.
 */

let server: net.Server;
let port: number;
let received: string[] = [];

/** Answers a startup with "send your password in cleartext", records it, then refuses the login. */
function handle(socket: net.Socket) {
  let buffer = Buffer.alloc(0);
  let startedUp = false;
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (!startedUp) {
      if (buffer.length < 4) return;
      const length = buffer.readInt32BE(0);
      if (buffer.length < length) return;
      buffer = buffer.subarray(length);
      startedUp = true;
      // AuthenticationCleartextPassword: 'R', length 8, code 3.
      const ask = Buffer.alloc(9);
      ask.write("R", 0);
      ask.writeInt32BE(8, 1);
      ask.writeInt32BE(3, 5);
      socket.write(ask);
    }
    if (buffer.length >= 5 && buffer.toString("utf8", 0, 1) === "p") {
      const length = buffer.readInt32BE(1);
      if (buffer.length < 1 + length) return;
      received.push(buffer.toString("utf8", 5, 1 + length - 1));
      // ErrorResponse: invalid_password, so the client stops.
      const fields = Buffer.from("SFATAL\0C28P01\0Mpassword authentication failed\0\0");
      const error = Buffer.alloc(5);
      error.write("E", 0);
      error.writeInt32BE(4 + fields.length, 1);
      socket.end(Buffer.concat([error, fields]));
    }
  });
  socket.on("error", () => {});
}

const OUR_PASSWORD = "our-own-database-password";
const target = { host: "127.0.0.1", port: 0, database: "theirs", user: "someone", sslMode: "require" as const };

async function passwordSent(config: pg.ClientConfig): Promise<string | undefined> {
  received = [];
  // Plain TCP to the local fake server: TLS and the address guard aren't what's under test.
  const client = new pg.Client({ ...config, host: "127.0.0.1", port, ssl: false });
  client.on("error", () => {});
  await client.connect().catch(() => {});
  await client.end().catch(() => {});
  return received[0];
}

beforeAll(async () => {
  server = net.createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as net.AddressInfo).port;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const saved = { PGPASSWORD: process.env.PGPASSWORD };
beforeAll(() => {
  process.env.PGPASSWORD = OUR_PASSWORD;
});
afterEach(() => {
  process.env.PGPASSWORD = OUR_PASSWORD;
});
afterAll(() => {
  if (saved.PGPASSWORD === undefined) delete process.env.PGPASSWORD;
  else process.env.PGPASSWORD = saved.PGPASSWORD;
});

describe("the Postgres connector's password", () => {
  it("is exactly the user's, even when empty and PGPASSWORD is set", async () => {
    expect(await passwordSent(postgresClientConfig({ ...target, password: "" }))).toBe("");
  });

  it("is the user's own when they gave one", async () => {
    expect(await passwordSent(postgresClientConfig({ ...target, password: "their-password" }))).toBe("their-password");
  });

  it("refuses an empty host, user or database rather than letting pg fill it from our environment", () => {
    for (const field of ["host", "user", "database"] as const) {
      expect(() => postgresClientConfig({ ...target, password: "x", [field]: "" })).toThrow();
    }
  });

  it("guards against what pg does with a plain empty string", async () => {
    // Why the connector passes a function: with a string, pg sends our environment's password.
    expect(await passwordSent({ ...postgresClientConfig({ ...target, password: "" }), password: "" })).toBe(OUR_PASSWORD);
  });
});

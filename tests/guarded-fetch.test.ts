import dns from "node:dns";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createGuardedFetch, OriginNotAllowedError, RedirectRefusedError, ResponseTooLargeError } from "@/lib/net/guarded-fetch";
import { BlockedAddressError } from "@/lib/net/guarded-socket";

const limits = { maxBytes: 1_000, timeoutMs: 2_000 };

describe("guardedFetch, with the production policy", () => {
  it("only accepts an https origin", () => {
    expect(() => createGuardedFetch({ origin: "http://example.com", ...limits })).toThrow(OriginNotAllowedError);
    expect(() => createGuardedFetch({ origin: "ftp://example.com", ...limits })).toThrow(OriginNotAllowedError);
  });

  it.each([
    "https://127.0.0.1/",
    "https://2130706433/",
    "https://0x7f.1/",
    "https://0177.0.0.1/",
    "https://10.0.0.1/",
    "https://192.168.1.1/",
    "https://169.254.169.254/latest/meta-data/",
    "https://100.100.100.200/",
    "https://0.0.0.0/",
    "https://[::1]/",
    "https://[::ffff:127.0.0.1]/",
    "https://[::ffff:a9fe:a9fe]/",
    "https://[64:ff9b::a9fe:a9fe]/",
    "https://[2002:a9fe:a9fe::1]/",
    "https://[fd00:ec2::254]/",
    "https://[fe80::1]/",
  ])("refuses %s before connecting", async (url) => {
    const origin = new URL(url).origin;
    const guarded = createGuardedFetch({ origin, ...limits });
    await expect(guarded(url)).rejects.toBeInstanceOf(BlockedAddressError);
    await guarded.close();
  });

  it("refuses a name that resolves to a private address", async () => {
    const guarded = createGuardedFetch({ origin: "https://localhost:8443", ...limits });
    await expect(guarded("https://localhost:8443/mcp")).rejects.toSatisfy((error) => hasCause(error, BlockedAddressError));
    await guarded.close();
  });

  describe("a name that resolves to a public and a private address", () => {
    afterEach(() => vi.restoreAllMocks());

    it("is refused: every address must be public", async () => {
      vi.spyOn(dns, "lookup").mockImplementation(((_host: string, _options: unknown, callback: (e: null, a: dns.LookupAddress[]) => void) =>
        callback(null, [
          { address: "93.184.215.14", family: 4 },
          { address: "10.0.0.7", family: 4 },
        ])) as unknown as typeof dns.lookup);
      const guarded = createGuardedFetch({ origin: "https://mixed.example.org", ...limits });
      await expect(guarded("https://mixed.example.org/mcp")).rejects.toSatisfy((error) => hasCause(error, BlockedAddressError));
      await guarded.close();
    });
  });

  it("refuses anything outside its origin, and user info", async () => {
    const guarded = createGuardedFetch({ origin: "https://mcp.example.com", ...limits });
    for (const url of ["https://evil.example.com/", "https://mcp.example.com:8443/", "http://mcp.example.com/", "https://user:pass@mcp.example.com/"]) {
      await expect(guarded(url)).rejects.toBeInstanceOf(OriginNotAllowedError);
    }
    await guarded.close();
  });

  describe("our own database", () => {
    const saved = { url: process.env.DATABASE_URL, unpooled: process.env.DATABASE_URL_UNPOOLED };
    beforeAll(() => {
      process.env.DATABASE_URL = "postgres://owner:secret@ep-our-db-pooler.c-1.us-east-1.aws.neon.tech/app";
      process.env.DATABASE_URL_UNPOOLED = "postgres://owner:secret@ep-our-db.c-1.us-east-1.aws.neon.tech/app";
    });
    afterAll(() => {
      process.env.DATABASE_URL = saved.url;
      if (saved.unpooled === undefined) delete process.env.DATABASE_URL_UNPOOLED;
      else process.env.DATABASE_URL_UNPOOLED = saved.unpooled;
    });

    it.each(["ep-our-db-pooler.c-1.us-east-1.aws.neon.tech", "ep-our-db.c-1.us-east-1.aws.neon.tech", "EP-OUR-DB.c-1.us-east-1.aws.neon.tech."])("refuses %s by name", async (host) => {
      const guarded = createGuardedFetch({ origin: `https://${host}`, ...limits });
      await expect(guarded(`https://${host}/`)).rejects.toBeInstanceOf(BlockedAddressError);
      await guarded.close();
    });

    it("still allows another Neon database", async () => {
      const { isOwnHost } = await import("@/lib/net/own-hosts");
      expect(isOwnHost("ep-someone-else.c-1.us-east-1.aws.neon.tech")).toBe(false);
    });
  });
});

/*
 * Behaviour after connecting, against a local server. The test hooks only
 * widen the address policy to 127.0.0.1 and allow plain HTTP for it; every
 * other rule is the production one.
 */
describe("guardedFetch, against a local server", () => {
  let server: http.Server;
  let origin: string;
  const seen: { path: string; headers: http.IncomingHttpHeaders }[] = [];
  const hooks = { allowAddress: (address: string) => address === "127.0.0.1", allowHttp: true };

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      seen.push({ path: req.url ?? "", headers: req.headers });
      if (req.url === "/redirect") return res.writeHead(302, { Location: "/elsewhere" }).end();
      if (req.url === "/redirect-307") return res.writeHead(307, { Location: "https://evil.example.com/steal" }).end();
      if (req.url === "/big-declared") return res.writeHead(200, { "Content-Length": "5000" }).end("x".repeat(5000));
      if (req.url === "/big-streamed") {
        res.writeHead(200);
        for (let i = 0; i < 50; i++) res.write("x".repeat(100));
        return res.end();
      }
      if (req.url === "/slow") {
        res.writeHead(200);
        const timer = setInterval(() => res.write("."), 200);
        return req.on("close", () => clearInterval(timer));
      }
      res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}');
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const make = (overrides: Partial<typeof limits> = {}) => createGuardedFetch({ origin, ...limits, ...overrides }, hooks);

  it("fetches from its origin", async () => {
    const guarded = make();
    const response = await guarded(`${origin}/ok`, { headers: { Authorization: "Bearer key-1" } });
    expect(await response.json()).toEqual({ ok: true });
    expect(seen.at(-1)?.headers.authorization).toBe("Bearer key-1");
    await guarded.close();
  });

  it.each(["/redirect", "/redirect-307"])("refuses the redirect at %s, whatever the caller asked", async (path) => {
    const guarded = make();
    const before = seen.length;
    await expect(guarded(`${origin}${path}`, { redirect: "follow" })).rejects.toBeInstanceOf(RedirectRefusedError);
    // Nothing was requested at the redirect's target.
    expect(seen.slice(before).map((entry) => entry.path)).toEqual([path]);
    await guarded.close();
  });

  it("refuses a body over the cap, declared or streamed", async () => {
    const guarded = make();
    await expect(guarded(`${origin}/big-declared`)).rejects.toBeInstanceOf(ResponseTooLargeError);
    const streamed = await guarded(`${origin}/big-streamed`);
    await expect(streamed.text()).rejects.toBeInstanceOf(ResponseTooLargeError);
    await guarded.close();
  });

  it("gives up on a response that drips past the deadline", async () => {
    const guarded = make({ timeoutMs: 600, maxBytes: 1_000_000 });
    const started = Date.now();
    await expect(guarded(`${origin}/slow`).then((response) => response.text())).rejects.toBeTruthy();
    expect(Date.now() - started).toBeLessThan(3_000);
    await guarded.close();
  });

  it("refuses another port on the same host", async () => {
    const guarded = make();
    await expect(guarded("http://127.0.0.1:9/")).rejects.toBeInstanceOf(OriginNotAllowedError);
    await guarded.close();
  });

  describe("with proxy environment variables set", () => {
    const saved = { http: process.env.HTTP_PROXY, https: process.env.HTTPS_PROXY, all: process.env.ALL_PROXY };
    beforeAll(() => {
      process.env.HTTP_PROXY = process.env.HTTPS_PROXY = process.env.ALL_PROXY = "http://127.0.0.1:9";
    });
    afterAll(() => {
      for (const [key, value] of [["HTTP_PROXY", saved.http], ["HTTPS_PROXY", saved.https], ["ALL_PROXY", saved.all]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    it("ignores them and goes straight to the origin", async () => {
      const guarded = make();
      const response = await guarded(`${origin}/ok`);
      expect(response.status).toBe(200);
      await guarded.close();
    });
  });
});

function hasCause(error: unknown, type: new (...args: never[]) => Error): boolean {
  for (let e: unknown = error, depth = 0; e && depth < 8; e = (e as { cause?: unknown }).cause, depth++) {
    if (e instanceof type) return true;
  }
  return false;
}

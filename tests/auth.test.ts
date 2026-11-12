import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import { AuthConfigError, getAuthProvider, type AuthProvider } from "@/lib/auth";
import { devProvider } from "@/lib/auth/providers/dev";
import { AUTHORIZATION_HEADER, supabaseProvider } from "@/lib/auth/providers/supabase";

const SUPABASE_URL = "https://project.supabase.co";
const USER = "6f1c2d3e-0000-4000-8000-000000000001";
const EMAIL = "ada@example.com";
const DEV = { id: "dev-user", email: "user@example.dev" };
const headers = (values: Record<string, string>) => new Headers(values);

type Keys = Awaited<ReturnType<typeof generateKeyPair>>;
let keys: Keys;
let otherKeys: Keys;
let supabase: AuthProvider;

type TokenOptions = {
  claims?: Record<string, unknown>;
  issuer?: string;
  audience?: string;
  subject?: string;
  expires?: string;
  signWith?: Keys;
};

function sign({ claims, issuer, audience, subject, expires, signWith }: TokenOptions = {}) {
  return new SignJWT({ role: "authenticated", email: EMAIL, ...claims })
    .setProtectedHeader({ alg: "ES256", kid: "k1" })
    .setIssuer(issuer ?? `${SUPABASE_URL}/auth/v1`)
    .setAudience(audience ?? "authenticated")
    .setSubject(subject ?? USER)
    .setIssuedAt()
    .setExpirationTime(expires ?? "1h")
    .sign((signWith ?? keys).privateKey);
}

const request = (token: string) =>
  headers({ [AUTHORIZATION_HEADER]: `Bearer ${token}` });

beforeAll(async () => {
  keys = await generateKeyPair("ES256");
  otherKeys = await generateKeyPair("ES256");
  const jwk: JWK = { ...(await exportJWK(keys.publicKey)), kid: "k1", alg: "ES256", use: "sig" };
  supabase = supabaseProvider(SUPABASE_URL, createLocalJWKSet({ keys: [jwk] }));
});

describe("getAuthProvider", () => {
  const prod = { environment: "prod" as const, devUser: null, supabaseUrl: SUPABASE_URL };

  it("uses Supabase when it's configured, even locally", async () => {
    const local = getAuthProvider({ ...prod, environment: "local", devUser: DEV });
    await expect(local.authenticate(headers({}))).resolves.toEqual({ ok: false, reason: "signed_out" });
    await expect(getAuthProvider(prod).authenticate(headers({}))).resolves.toEqual({ ok: false, reason: "signed_out" });
  });

  it("refuses prod without Supabase", () => {
    expect(() => getAuthProvider({ ...prod, supabaseUrl: undefined })).toThrow(AuthConfigError);
  });

  it("refuses a dev user outside local", () => {
    expect(() => getAuthProvider({ ...prod, devUser: DEV })).toThrow(AuthConfigError);
  });

  it("refuses a dev user without an id or an email", () => {
    for (const devUser of [{ ...DEV, id: "" }, { ...DEV, email: "" }]) {
      expect(() => getAuthProvider({ environment: "local", devUser, supabaseUrl: undefined })).toThrow(AuthConfigError);
    }
  });

  it("uses local's dev user without Supabase", async () => {
    const provider = getAuthProvider({ environment: "local", devUser: DEV, supabaseUrl: undefined });
    await expect(provider.authenticate(headers({}))).resolves.toEqual({ ok: true, user: DEV });
  });
});

describe("supabaseProvider", () => {
  it("takes the user from a valid token", async () => {
    await expect(supabase.authenticate(request(await sign()))).resolves.toEqual({ ok: true, user: { id: USER, email: EMAIL } });
  });

  it("rejects a token without an email: every user has one", async () => {
    for (const email of [undefined, "", 42]) {
      await expect(supabase.authenticate(request(await sign({ claims: { email } })))).resolves.toEqual({ ok: false, reason: "invalid" });
    }
  });

  it("ignores X-User-Id", async () => {
    const forged = request(await sign());
    forged.set("x-user-id", "someone-else");
    await expect(supabase.authenticate(forged)).resolves.toEqual({ ok: true, user: { id: USER, email: EMAIL } });
  });

  it("rejects a missing or malformed Authorization header", async () => {
    await expect(supabase.authenticate(headers({}))).resolves.toEqual({ ok: false, reason: "signed_out" });
    await expect(supabase.authenticate(headers({ [AUTHORIZATION_HEADER]: "Basic abc" }))).resolves.toEqual({
      ok: false,
      reason: "signed_out",
    });
  });

  it.each<[string, TokenOptions]>([
    ["expired", { expires: "-1m" }],
    ["signed by another key", { signWith: undefined }],
    ["from another project", { issuer: "https://other.supabase.co/auth/v1" }],
    ["for another audience", { audience: "service" }],
    ["an anon-role token", { claims: { role: "anon" } }],
    ["an anonymous user's", { claims: { is_anonymous: true } }],
  ])("rejects a token that is %s", async (label, options) => {
    const token = await sign(label === "signed by another key" ? { signWith: otherKeys } : options);
    await expect(supabase.authenticate(request(token))).resolves.toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects an unsigned token", async () => {
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const payload = {
      sub: USER,
      role: "authenticated",
      iss: `${SUPABASE_URL}/auth/v1`,
      aud: "authenticated",
      exp: Math.floor(Date.now() / 1000) + 3600,
    };
    const token = `${encode({ alg: "none" })}.${encode(payload)}.`;
    await expect(supabase.authenticate(request(token))).resolves.toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects a token with an empty subject", async () => {
    await expect(supabase.authenticate(request(await sign({ subject: "" })))).resolves.toEqual({ ok: false, reason: "invalid" });
  });

  it("trusts whatever non-empty subject the token carries", async () => {
    const id = "a b/../c";
    await expect(supabase.authenticate(request(await sign({ subject: id })))).resolves.toEqual({ ok: true, user: { id, email: EMAIL } });
  });

  it("reports an outage, not a bad token, when the keys can't be fetched", async () => {
    const unreachable = supabaseProvider(SUPABASE_URL, async () => {
      throw new TypeError("fetch failed");
    });
    await expect(unreachable.authenticate(request(await sign()))).resolves.toEqual({ ok: false, reason: "unavailable" });
  });
});

describe("devProvider", () => {
  it("always returns the configured user, ignoring X-User-Id", async () => {
    const dev = devProvider(DEV);
    const expected = { ok: true, user: DEV };
    await expect(dev.authenticate(headers({}))).resolves.toEqual(expected);
    await expect(dev.authenticate(headers({ "x-user-id": "bob" }))).resolves.toEqual(expected);
  });
});

import "server-only";

import { createHash } from "node:crypto";

import { importPKCS8, SignJWT } from "jose";

import { readServiceAccountKey } from "./credential";

/**
 * Access tokens for a service account, shared by every Google source
 * (BigQuery, Search Console, Google Analytics). The account signs a short
 * assertion with its private key, and Google's fixed token endpoint swaps it
 * for an access token limited to one scope. The token URL in a key file is
 * never used (see ./credential.ts), and nothing here runs on our side but
 * the signing.
 */

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

/** Why a token couldn't be had. */
export class GoogleAuthError extends Error {
  constructor(
    /** key_rejected: Google refused the key (deleted, disabled, malformed). unavailable: the token endpoint failed. */
    readonly code: "key_rejected" | "unavailable",
    readonly detail?: string,
  ) {
    super(`Google sign-in failed: ${code}${detail ? ` (${detail})` : ""}`);
    this.name = "GoogleAuthError";
  }
}

// Tokens by key and scope, reused until shortly before they expire.
const tokens = new Map<string, { token: string; expiresAt: number }>();

/** An access token for the stored service account `credential`, for one `scope`. */
export async function googleAccessToken(credential: string, scope: string, signal: AbortSignal): Promise<string> {
  const key = readServiceAccountKey(credential);
  const cacheKey = createHash("sha256").update(key.client_email).update(key.private_key).update(scope).digest("hex");
  const cached = tokens.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  let assertion: string;
  try {
    const privateKey = await importPKCS8(key.private_key, "RS256");
    assertion = await new SignJWT({ scope })
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer(key.client_email)
      .setAudience(GOOGLE_TOKEN_URL)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);
  } catch {
    throw new GoogleAuthError("key_rejected", "The private key in this service account key can't be used.");
  }

  let response: Response;
  try {
    response = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
      redirect: "error",
      cache: "no-store",
      signal,
    });
  } catch (error) {
    throw new GoogleAuthError("unavailable", error instanceof Error ? error.message : String(error));
  }
  const body = (await response.json().catch(() => null)) as { access_token?: string; expires_in?: number; error?: string; error_description?: string } | null;
  if (!response.ok || !body?.access_token) {
    if (response.status >= 500) throw new GoogleAuthError("unavailable", `Token endpoint: HTTP ${response.status}`);
    // invalid_grant: the key was deleted or disabled, or the account was.
    throw new GoogleAuthError("key_rejected", body?.error_description ?? body?.error ?? `HTTP ${response.status}`);
  }
  tokens.set(cacheKey, { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 });
  return body.access_token;
}

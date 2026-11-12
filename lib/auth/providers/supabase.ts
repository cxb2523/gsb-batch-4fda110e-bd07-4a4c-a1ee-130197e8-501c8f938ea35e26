import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from "jose";

import type { AuthProvider } from "../provider";

/**
 * A gateway in front of OpenDashboards signs users in with Supabase and forwards their
 * access token. The token is verified against Supabase's public keys, so
 * identity is never taken from an unsigned header. Only Deployment Protection
 * keeps requests from reaching OpenDashboards without the gateway.
 */

export const AUTHORIZATION_HEADER = "authorization";

const BEARER_PATTERN = /^Bearer ([^\s]+)$/i;

/** Asymmetric only: OpenDashboards must never hold anything that can mint a token. */
const TOKEN_ALGORITHMS = ["ES256", "RS256"];

const authBase = (supabaseUrl: string) => `${supabaseUrl.replace(/\/+$/, "")}/auth/v1`;

/**
 * Checks a Supabase access token: signature, issuer, audience and expiry.
 * Only a signed-in, non-anonymous user passes. `keys` is injectable for tests.
 */
export function supabaseProvider(supabaseUrl: string, keys: JWTVerifyGetKey = sharedKeys(supabaseUrl)): AuthProvider {
  const issuer = authBase(supabaseUrl);
  return {
    async authenticate(headers) {
      const token = headers.get(AUTHORIZATION_HEADER)?.match(BEARER_PATTERN)?.[1];
      if (!token) return { ok: false, reason: "signed_out" };
      try {
        const { payload } = await jwtVerify(token, keys, { issuer, audience: "authenticated", algorithms: TOKEN_ALGORITHMS });
        if (payload.role !== "authenticated" || payload.is_anonymous === true) return { ok: false, reason: "invalid" };
        if (typeof payload.sub !== "string" || !payload.sub) return { ok: false, reason: "invalid" };
        // Every OpenDashboards user has an email; a token without one (a phone-only sign-in, say) isn't accepted.
        if (typeof payload.email !== "string" || !payload.email) return { ok: false, reason: "invalid" };
        return { ok: true, user: { id: payload.sub, email: payload.email } };
      } catch (error) {
        // No usable key set (or none in time) says nothing about the token.
        if (error instanceof errors.JWKSTimeout || error instanceof errors.JWKSInvalid) return { ok: false, reason: "unavailable" };
        if (error instanceof errors.JOSEError) return { ok: false, reason: "invalid" };
        return { ok: false, reason: "unavailable" };
      }
    },
  };
}

// One key set per project, so the fetched public keys are reused between requests.
const keySets = new Map<string, JWTVerifyGetKey>();

function sharedKeys(supabaseUrl: string): JWTVerifyGetKey {
  let keys = keySets.get(supabaseUrl);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`${authBase(supabaseUrl)}/.well-known/jwks.json`));
    keySets.set(supabaseUrl, keys);
  }
  return keys;
}

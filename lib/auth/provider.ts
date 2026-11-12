/**
 * How OpenDashboards learns who a request is for. Each way of signing in is a provider;
 * `proxy.ts` and `requireUser()` only ever talk to this interface.
 */

/**
 * Who a request is for. A provider promises `id` is stable, unique and
 * non-empty, and that every user has an email. OpenDashboards doesn't second-guess
 * either. Data is keyed by `id`, never by email: emails change.
 */
export type AuthUser = { id: string; email: string };

export type AuthOutcome =
  | { ok: true; user: AuthUser }
  /**
   * signed_out: no credentials at all. invalid: credentials that don't check
   * out. unavailable: the provider couldn't decide, which says nothing about
   * the user.
   */
  | { ok: false; reason: "signed_out" | "invalid" | "unavailable" };

export interface HeaderReader {
  get(name: string): string | null;
}

export interface AuthProvider {
  authenticate(headers: HeaderReader): Promise<AuthOutcome>;
}

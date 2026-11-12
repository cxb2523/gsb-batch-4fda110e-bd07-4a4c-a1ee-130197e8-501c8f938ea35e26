import type { AuthProvider, AuthUser } from "../provider";

/** Local development: every request is the configured user. */
export function devProvider(user: AuthUser): AuthProvider {
  return {
    authenticate: async () => ({ ok: true, user: { id: user.id, email: user.email } }),
  };
}

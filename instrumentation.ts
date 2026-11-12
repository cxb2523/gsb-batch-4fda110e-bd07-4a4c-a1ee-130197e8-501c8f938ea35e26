/**
 * Runs once when the server starts. It sets how patiently outbound
 * connections are opened, and checks configuration so a misconfigured
 * production deployment fails loudly instead of at the first request. Each
 * check also runs per request (proxy, secret storage), so this is the early
 * warning, not the only guard.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { configureConnectTimeouts } = await import("@/lib/net/connect-timeouts");
  const { validateConfig } = await import("@/config");

  configureConnectTimeouts();
  // Vercel never runs `next start`, so next.config.ts doesn't check secrets there.
  validateConfig({ withSecrets: true });
}

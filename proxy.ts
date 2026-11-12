import { NextResponse, type NextRequest } from "next/server";

import { getAuthProvider, type AuthProvider } from "@/lib/auth";
import { isPublicPath } from "@/lib/auth/public-paths";
import { count } from "@/lib/metrics";

/**
 * Rejects every request the auth provider doesn't recognize, before any page,
 * Route Handler or Server Action runs. `requireUser()` checks again close to
 * the data, as the Next.js docs recommend.
 */
export async function proxy(request: NextRequest) {
  // The landing page is for people who haven't signed in yet.
  if (isPublicPath(request.nextUrl.pathname)) return NextResponse.next();

  let provider: AuthProvider;
  try {
    provider = getAuthProvider();
  } catch {
    count("opendashboards.auth.rejected", { reason: "misconfigured" });
    return new NextResponse("Service unavailable", { status: 503 });
  }

  const result = await provider.authenticate(request.headers);
  if (!result.ok) {
    // Counted only here: requireUser() re-checks every request that passes.
    count("opendashboards.auth.rejected", { reason: result.reason });
    if (result.reason === "unavailable") return new NextResponse("Service unavailable", { status: 503 });
    return new NextResponse("Unauthorized", { status: 401 });
  }
  return NextResponse.next();
}

export const config = {
  // Everything except Next's static build output.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

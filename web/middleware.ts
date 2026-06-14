import { NextResponse, type NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

/**
 * OPTIMISTIC auth UX only — NOT the security gate.
 *
 * Per CVE-2025-29927, middleware can be bypassed, so it must never be the sole
 * authorization check. The real gate is the data layer (requireTenant /
 * getCurrentTenantId, run in server components/actions). Here we only:
 *   1. Expose the requested path as `x-pathname` so the data layer can build a
 *      ?redirect back-link.
 *   2. Fast-redirect to /login when there's no session COOKIE (a presence check,
 *      not validation — no DB/crypto) on a protected path, so logged-out users
 *      don't briefly render a protected page before the data layer bounces them.
 * A forged cookie passes here but is still rejected by the data layer.
 */
const PUBLIC_PREFIXES = ["/login", "/signup", "/logout", "/api/auth"];

export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-pathname", pathname);

  const isPublic = PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  if (!isPublic && !getSessionCookie(request)) {
    const url = new URL("/login", request.url);
    url.searchParams.set("redirect", pathname);
    return NextResponse.redirect(url);
  }

  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  // Run on everything except Next internals and static assets.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};

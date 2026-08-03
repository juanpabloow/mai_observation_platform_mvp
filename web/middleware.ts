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
// /invite is public: the accept page handles its own auth (prompting sign-in
// while preserving the token in the URL) and the real gate is the accept action
// at the data layer. (Middleware can't carry the token through its /login bounce.)
// /api/handoff is the MACHINE handoff API: cookieless Bearer-token requests must
// reach the route (which does its own auth) instead of being redirected to /login.
// /api/health is the public uptime probe: it must return 200/503 cookieless.
// /api/scheduling is the MACHINE scheduling API (Bearer token, like /api/handoff).
// /api/crm is the MACHINE CRM API (Bearer token, like /api/handoff) — C-5.
// /book is the PUBLIC booking page and /api/booking its public endpoints — both
// cookieless and self-protected (site-slug scoping + rate limiting).
// /forgot-password and /reset-password are the account-recovery pages: their
// whole audience is logged-out users, so they must never bounce to /login.
const PUBLIC_PREFIXES = [
  "/login",
  "/signup",
  "/logout",
  "/forgot-password",
  "/reset-password",
  "/api/auth",
  "/invite",
  "/api/handoff",
  "/api/health",
  "/api/scheduling",
  "/api/crm",
  "/api/booking",
  "/book",
];

export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-pathname", pathname);
  // The query string too, so the server can read URL-expressed scope (the inbox's
  // ?workflow=, W-2) the same way it reads a workflow path segment — seeding the scope
  // provider on hard-load with no flash.
  requestHeaders.set("x-search", request.nextUrl.search);

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

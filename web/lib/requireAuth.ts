import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { getServerSession } from "./session";
import { getTenantIdForUser } from "@worker/db/repositories/tenantMembers.js";

/**
 * THE data-layer authorization gate (CVE-2025-29927-aware).
 *
 * These run in Server Components / Server Actions / Route Handlers — i.e. where
 * data is actually served — so authorization is enforced at the data layer, NOT
 * in middleware alone (middleware is bypassable). Middleware additionally does an
 * optimistic cookie-presence redirect for fast UX, but it is never the only gate:
 * even a forged/bypassed middleware request is rejected here.
 *
 * On failure they `redirect()` (which throws NEXT_REDIRECT and unwinds) rather
 * than returning, so a caller can safely treat the return value as authorized.
 */

/** Build the login URL, preserving the attempted internal path as ?redirect. */
function loginUrl(attempted: string | null): string {
  if (
    attempted &&
    attempted.startsWith("/") &&
    !attempted.startsWith("//") &&
    !attempted.startsWith("/\\") &&
    !attempted.startsWith("/login") &&
    !attempted.startsWith("/signup")
  ) {
    return `/login?redirect=${encodeURIComponent(attempted)}`;
  }
  return "/login";
}

/** Require a logged-in user, or redirect to /login. */
export async function requireSession(): Promise<{ userId: string; email: string }> {
  const session = await getServerSession();
  if (!session?.user?.id) {
    const h = await headers();
    redirect(loginUrl(h.get("x-pathname")));
  }
  return { userId: session.user.id, email: session.user.email };
}

/**
 * Require a logged-in user WITH a tenant, returning { userId, tenantId }.
 * - No session → redirect to /login (the common logged-out case).
 * - Session but no tenant membership → shouldn't happen (signup provisions a
 *   tenant); handled defensively by redirecting to /login?error=no-tenant rather
 *   than serving data or 500ing.
 */
export async function requireTenant(): Promise<{ userId: string; tenantId: string }> {
  const session = await getServerSession();
  if (!session?.user?.id) {
    const h = await headers();
    redirect(loginUrl(h.get("x-pathname")));
  }
  const userId = session.user.id;
  const tenantId = await getTenantIdForUser(userId);
  if (!tenantId) {
    redirect("/login?error=no-tenant");
  }
  return { userId, tenantId };
}

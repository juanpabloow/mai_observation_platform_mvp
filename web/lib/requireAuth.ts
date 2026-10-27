import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { getServerSession } from "./session";
import { getTenantIdForUser } from "@worker/db/repositories/tenantMembers.js";
import { safeInternalPath } from "./safeRedirect";

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

/**
 * Build the login URL, preserving the attempted internal path (+ its query, so Agenda comes
 * back on the same week and filters) as ?redirect. When the browser still carried a session
 * cookie that no longer resolves, the session ENDED (expired or was closed elsewhere) —
 * ?reason=ended lets the login screen say so instead of looking like a first visit.
 */
async function loginUrl(): Promise<string> {
  const h = await headers();
  const attempted = `${h.get("x-pathname") ?? ""}${h.get("x-search") ?? ""}`;
  const target = safeInternalPath(attempted, "");
  const jar = await cookies();
  // "better-auth.session_token", or "__Secure-better-auth.session_token" over https.
  const hadCookie = jar.getAll().some((c) => c.name === "better-auth.session_token" || c.name === "__Secure-better-auth.session_token");
  const q = new URLSearchParams();
  if (hadCookie) q.set("reason", "ended");
  if (target) q.set("redirect", target);
  const s = q.toString();
  return s ? `/login?${s}` : "/login";
}

/** Require a logged-in user, or redirect to /login. */
export async function requireSession(): Promise<{ userId: string; email: string }> {
  const session = await getServerSession();
  if (!session?.user?.id) redirect(await loginUrl());
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
  if (!session?.user?.id) redirect(await loginUrl());
  const userId = session.user.id;
  const tenantId = await getTenantIdForUser(userId);
  if (!tenantId) {
    redirect("/login?error=no-tenant");
  }
  return { userId, tenantId };
}

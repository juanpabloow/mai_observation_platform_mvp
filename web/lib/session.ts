import { cache } from "react";
import { headers } from "next/headers";
import { auth } from "./auth";
import { IDLE_TIMEOUT_MS } from "./sessionPolicy";
import { getSessionPolicyRow, reconcileLegacySessions } from "@worker/db/repositories/authSessions.js";
import { validateUnderPolicy } from "./sessionValidation";

/**
 * Read the current session SERVER-SIDE from the request cookies.
 *
 * This is the canonical session check and MUST be called where data is actually
 * served or mutated — Server Components, Server Actions, and Route Handlers — so
 * authorization is enforced at the DATA LAYER. We deliberately do NOT gate
 * access in Next.js middleware alone: middleware can be bypassed via a crafted
 * header (CVE-2025-29927), so it can never be the only check.
 *
 * Returns `{ user, session }` when authenticated, or `null` when not.
 *
 * Wrapped in React.cache so the many consumers in one render (the access-scope
 * resolvers, the header, the sidebar) share a single session validation.
 */
export const getServerSession = cache(async () => {
  return underPolicy(await auth.api.getSession({ headers: await headers() }));
});

/** The same check for a Route Handler that has the request headers in hand. */
export async function getSessionFromHeaders(h: Headers): Promise<Raw> {
  return underPolicy(await auth.api.getSession({ headers: h }));
}

type Raw = Awaited<ReturnType<typeof auth.api.getSession>>;

/**
 * ACCESO-1: a session written by the PREVIOUS code (deploy overlap or code-only rollback) is
 * reconciled and then RE-READ and judged on its current stored state — see
 * lib/sessionValidation.ts. Sessions this code wrote pay one in-memory comparison.
 */
function underPolicy(s: Raw): Promise<Raw> {
  return validateUnderPolicy(s, {
    now: () => new Date(),
    reconcile: (sessionId) => reconcileLegacySessions({ idleMs: IDLE_TIMEOUT_MS, sessionId }),
    read: getSessionPolicyRow,
  });
}

export type ServerSession = Awaited<ReturnType<typeof getServerSession>>;

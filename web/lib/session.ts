import { headers } from "next/headers";
import { auth } from "./auth";

/**
 * Read the current session SERVER-SIDE from the request cookies.
 *
 * This is the canonical session check and MUST be called where data is actually
 * served or mutated — Server Components, Server Actions, and Route Handlers — so
 * authorization is enforced at the DATA LAYER. We deliberately do NOT gate
 * access in Next.js middleware alone: middleware can be bypassed via a crafted
 * header (CVE-2025-29927), so it can never be the only check. (No route
 * protection is wired yet — that's the next step — but this helper is the hook
 * those checks will use.)
 *
 * Returns `{ user, session }` when authenticated, or `null` when not.
 */
export async function getServerSession() {
  return auth.api.getSession({ headers: await headers() });
}

export type ServerSession = Awaited<ReturnType<typeof getServerSession>>;

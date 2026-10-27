import { getSessionFromHeaders } from "@/lib/session";
import { IDLE_TIMEOUT_MS, endReason } from "@/lib/sessionPolicy";
import { recordSessionActivity } from "@worker/db/repositories/authSessions.js";

/**
 * The browser's window onto its OWN session deadline (components/session/SessionGuard.tsx).
 *
 *   GET   → the current deadline. READ-ONLY: it never counts as activity and never extends
 *           anything (Better Auth's refresh is off), so the guard may call it on focus, on
 *           reconnect or after the laptop wakes up without keeping a session alive.
 *   POST  → "the person just pressed a key / clicked / touched": restart the 2-hour idle
 *           clock of a NON-persistent session, never past its absolute end. Sent only from
 *           real interaction events — polling, Agenda/Inbox refreshes and background fetches
 *           never call it.
 *
 * Both answer 401 {state:"ended"} once the session is gone (expired, revoked, signed out),
 * which is how another tab or a revocation is noticed. Self-protected (public in middleware,
 * so a stale cookie gets JSON instead of a redirect to /login). POST is same-origin only.
 */
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store" };

function payload(s: { persistent?: boolean | null; expiresAt: Date; absoluteExpiresAt?: Date | null }) {
  const absolute = s.absoluteExpiresAt ?? s.expiresAt;
  return {
    state: "active" as const,
    persistent: s.persistent === true,
    expiresAt: s.expiresAt.getTime(),
    absoluteExpiresAt: absolute.getTime(),
    reason: endReason({ persistent: s.persistent === true, absoluteExpiresAt: absolute, expiresAt: s.expiresAt }),
    serverNow: Date.now(),
  };
}

const ended = () => Response.json({ state: "ended" }, { status: 401, headers: NO_STORE });

export async function GET(req: Request): Promise<Response> {
  const s = await getSessionFromHeaders(req.headers).catch(() => null);
  if (!s?.session) return ended();
  return Response.json(payload(s.session), { headers: NO_STORE });
}

function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return false;
  if (!origin) return site === "same-origin";
  return origin === new URL(req.url).origin || origin === process.env.BETTER_AUTH_URL?.replace(/\/+$/, "");
}

export async function POST(req: Request): Promise<Response> {
  if (!sameOrigin(req)) return Response.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
  const s = await getSessionFromHeaders(req.headers).catch(() => null);
  if (!s?.session) return ended();
  const next = await recordSessionActivity({
    userId: s.user.id,
    sessionId: s.session.id,
    now: new Date(),
    idleMs: IDLE_TIMEOUT_MS,
  });
  if (!next) return ended();
  return Response.json(
    payload({ persistent: next.persistent, expiresAt: next.expires_at, absoluteExpiresAt: next.absolute_expires_at }),
    { headers: NO_STORE },
  );
}

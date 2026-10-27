"use server";

import { randomBytes } from "node:crypto";
import { headers } from "next/headers";
import { auth, isGoogleReauthAvailable } from "./auth";
import { getServerSession } from "./session";
import {
  REAUTH_WINDOW_MS,
  activeAgo,
  describeUserAgent,
  isRecentlyReauthenticated,
  sessionTypeLabel,
  storedSessionDeadline,
} from "./sessionPolicy";
import { REAUTH_STATE_KEY, reauthIdentifier, type ReauthChallenge } from "./auth-session-policy";
import {
  deleteAllOtherSessionsForUser,
  deleteOtherSessionForUser,
  listActiveSessionsForUser,
  markSessionReauthenticated,
} from "@worker/db/repositories/authSessions.js";

/**
 * Seguridad → Sesiones — the server half. Replaces Better Auth's HTTP list/revoke endpoints
 * (disabled in auth.ts because they close other sessions without re-authentication).
 *
 * RULES (all checked HERE, never trusted from the browser):
 *  - a person only ever sees and closes THEIR sessions (every query is keyed by the user id
 *    of the validated session);
 *  - closing the CURRENT session is plain sign-out (authClient.signOut) — no proof needed;
 *  - closing ANOTHER session, or all the others, needs a recent authentication ON THIS
 *    SESSION (reauthenticatedAt within REAUTH_WINDOW_MS), proven with a method the account
 *    actually has: its password, or Google for an account linked to Google. A Google-only
 *    account is never asked for a password.
 */

export interface SessionView {
  id: string;
  device: string;
  kind: "phone" | "computer" | "unknown";
  type: string;
  lastActive: string;
}

export interface SessionsPayload {
  current: SessionView;
  others: SessionView[];
  /** password: has one. google: can PROVE a recent Google sign-in here (auth_time available).
   *  googleLinked: signs in with Google (even when it cannot prove freshness). */
  methods: { password: boolean; google: boolean; googleLinked: boolean };
  /** True while a recent authentication still unlocks closing other sessions. */
  recentAuth: boolean;
  email: string;
}

type Current = NonNullable<Awaited<ReturnType<typeof getServerSession>>>;

async function requireCurrent(): Promise<Current> {
  const s = await getServerSession();
  if (!s?.session?.id || !s.user?.id) throw new Error("UNAUTHENTICATED");
  return s;
}

async function accountMethods(): Promise<{ password: boolean; google: boolean; googleLinked: boolean }> {
  const accounts = await auth.api.listUserAccounts({ headers: await headers() });
  const googleLinked = accounts.some((a) => a.providerId === "google");
  return {
    password: accounts.some((a) => a.providerId === "credential"),
    google: isGoogleReauthAvailable && googleLinked,
    googleLinked,
  };
}

function view(row: {
  id: string;
  user_agent: string | null;
  created_at: Date;
  last_activity_at: Date | null;
  persistent: boolean;
  absolute_expires_at: Date | null;
  auth_method: string | null;
}, now: Date): SessionView {
  const ua = describeUserAgent(row.user_agent);
  return {
    id: row.id,
    device: ua.label,
    kind: ua.kind,
    type: sessionTypeLabel({ persistent: row.persistent, absoluteExpiresAt: row.absolute_expires_at, authMethod: row.auth_method }),
    // A legacy session (written by the previous code) has no recorded interaction: say so
    // rather than presenting its creation or a refresh as activity.
    lastActive: row.last_activity_at ? activeAgo(row.last_activity_at, now) : row.auth_method === "legacy" ? "Actividad no registrada" : activeAgo(row.created_at, now),
  };
}

export async function listMySessionsAction(): Promise<{ ok: true; data: SessionsPayload } | { ok: false; error: string }> {
  try {
    const s = await requireCurrent();
    const now = new Date();
    const [all, methods] = await Promise.all([listActiveSessionsForUser(s.user.id, now), accountMethods()]);
    // Judge every row by the policy, not only by its stored expiresAt (a row the previous code
    // slid can still say "valid" after its idle end).
    const rows = all.filter(
      (r) =>
        storedSessionDeadline({
          createdAt: r.created_at,
          expiresAt: r.expires_at,
          absoluteExpiresAt: r.absolute_expires_at,
          persistent: r.persistent,
          lastActivityAt: r.last_activity_at,
        }).getTime() > now.getTime(),
    );
    const currentRow = rows.find((r) => r.id === s.session.id);
    const current: SessionView = currentRow
      ? { ...view(currentRow, now), lastActive: "Activa ahora" }
      : { id: s.session.id, device: describeUserAgent(null).label, kind: "unknown", type: "", lastActive: "Activa ahora" };
    return {
      ok: true,
      data: {
        current,
        others: rows.filter((r) => r.id !== s.session.id).map((r) => view(r, now)),
        methods,
        recentAuth: isRecentlyReauthenticated(s.session.reauthenticatedAt as Date | null | undefined, now),
        email: s.user.email,
      },
    };
  } catch {
    return { ok: false, error: "No pudimos cargar las otras sesiones. Tu sesión actual no se ve afectada." };
  }
}

export type RevokeResult = { ok: true; closed: number } | { ok: false; needsReauth: true } | { ok: false; error: string };

async function guardRecent(s: Current): Promise<boolean> {
  return isRecentlyReauthenticated(s.session.reauthenticatedAt as Date | null | undefined, new Date());
}

export async function revokeSessionAction(sessionId: string): Promise<RevokeResult> {
  const s = await requireCurrent().catch(() => null);
  if (!s) return { ok: false, error: "Tu sesión terminó. Vuelve a entrar." };
  if (typeof sessionId !== "string" || !sessionId || sessionId === s.session.id) {
    return { ok: false, error: "Esa sesión no se puede cerrar desde aquí." };
  }
  if (!(await guardRecent(s))) return { ok: false, needsReauth: true };
  const closed = await deleteOtherSessionForUser({ userId: s.user.id, sessionId, currentSessionId: s.session.id });
  // A foreign or already-gone id closes nothing — and says nothing about other users.
  return { ok: true, closed: closed ? 1 : 0 };
}

export async function revokeOtherSessionsAction(): Promise<RevokeResult> {
  const s = await requireCurrent().catch(() => null);
  if (!s) return { ok: false, error: "Tu sesión terminó. Vuelve a entrar." };
  if (!(await guardRecent(s))) return { ok: false, needsReauth: true };
  const closed = await deleteAllOtherSessionsForUser({ userId: s.user.id, currentSessionId: s.session.id });
  return { ok: true, closed };
}

// ---------------------------------------------------------------------------------------
// Re-authentication.

/** Wrong-password throttle per session (in-memory: correct while the web service runs one
 *  replica — the same caveat as Better Auth's rate limit in auth.ts). */
const FAILS = new Map<string, { count: number; since: number }>();
const MAX_FAILS = 5;
const FAIL_WINDOW_MS = 15 * 60_000;

export async function reauthWithPasswordAction(password: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const s = await requireCurrent().catch(() => null);
  if (!s) return { ok: false, error: "Tu sesión terminó. Vuelve a entrar." };
  const methods = await accountMethods();
  if (!methods.password) return { ok: false, error: "Tu cuenta no tiene contraseña. Confirma con Google." };
  const now = Date.now();
  const f = FAILS.get(s.session.id);
  if (f && now - f.since < FAIL_WINDOW_MS && f.count >= MAX_FAILS) {
    return { ok: false, error: "Demasiados intentos. Espera unos minutos e inténtalo otra vez." };
  }
  if (typeof password !== "string" || !password) return { ok: false, error: "Escribe tu contraseña." };
  let valid = false;
  try {
    const r = await auth.api.verifyPassword({ body: { password }, headers: await headers() });
    valid = r.status === true;
  } catch {
    valid = false;
  }
  if (!valid) {
    const next = f && now - f.since < FAIL_WINDOW_MS ? { count: f.count + 1, since: f.since } : { count: 1, since: now };
    FAILS.set(s.session.id, next);
    return { ok: false, error: "Contraseña incorrecta. Inténtalo otra vez." };
  }
  FAILS.delete(s.session.id);
  await markSessionReauthenticated({ userId: s.user.id, sessionId: s.session.id, at: new Date() });
  return { ok: true };
}

/**
 * Start a Google re-authentication: a single-use challenge bound to THIS session and THIS
 * account's email, valid 10 minutes, stored server-side. The browser only gets an opaque
 * nonce to carry through Google (Better Auth keeps it inside the encrypted OAuth state).
 */
export async function startGoogleReauthAction(): Promise<{ ok: true; stateKey: string; nonce: string; email: string } | { ok: false; error: string }> {
  const s = await requireCurrent().catch(() => null);
  if (!s) return { ok: false, error: "Tu sesión terminó. Vuelve a entrar." };
  const methods = await accountMethods();
  if (!methods.google) {
    return {
      ok: false,
      error: methods.googleLinked
        ? "Por ahora no podemos confirmar tu identidad con Google en esta plataforma."
        : "Tu cuenta no está conectada con Google.",
    };
  }
  const nonce = randomBytes(24).toString("base64url");
  const challenge: ReauthChallenge = { token: s.session.token, email: s.user.email };
  const ctx = await auth.$context;
  await ctx.internalAdapter.createVerificationValue({
    identifier: reauthIdentifier(nonce),
    value: JSON.stringify(challenge),
    expiresAt: new Date(Date.now() + REAUTH_WINDOW_MS),
  });
  return { ok: true, stateKey: REAUTH_STATE_KEY, nonce, email: s.user.email };
}

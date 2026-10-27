/**
 * ACCESO-1 — the last word on whether a session Better Auth just read may be trusted.
 *
 * Better Auth checks its own `expiresAt`. That is the whole story for sessions this code wrote
 * (fast path: nothing to do). A row the PREVIOUS code wrote or slid (deploy overlap, code
 * rollback) is reconciled first — and then, ALWAYS, the session is RE-READ and judged on its
 * stored state at this moment: another request may have reconciled it, it may have run out, or
 * it may have been revoked between Better Auth's read and ours. The answer never renews or
 * extends anything; it is either the session with its real limits, or null.
 *
 * Dependencies are injected so concurrent interleavings can be tested deterministically
 * (test/unit/accessSessionValidation.test.ts); production uses the repository functions.
 */
import { storedSessionDeadline } from "./sessionPolicy";
import type { SessionPolicyRow } from "@worker/db/repositories/authSessions.js";

export interface ValidationDeps {
  now(): Date;
  reconcile(sessionId: string): Promise<unknown>;
  read(sessionId: string): Promise<SessionPolicyRow | null>;
}

type Shape = {
  session: {
    id: string;
    userId: string;
    createdAt: Date | string;
    expiresAt: Date | string;
    absoluteExpiresAt?: Date | string | null;
    persistent?: boolean | null;
    lastActivityAt?: Date | string | null;
    authMethod?: string | null;
  };
  user: { id: string };
};

const d = (v: Date | string | null | undefined) => (v ? new Date(v) : null);

/** Does this session, AS READ, already satisfy the policy? (Then no write and no re-read.) */
export function isUnderPolicy(s: Shape["session"]): boolean {
  const expires = d(s.expiresAt)!;
  const abs = d(s.absoluteExpiresAt);
  if (!abs) return false;
  const deadline = storedSessionDeadline({
    createdAt: d(s.createdAt)!,
    expiresAt: expires,
    absoluteExpiresAt: abs,
    persistent: s.persistent === true,
    lastActivityAt: d(s.lastActivityAt),
  });
  return deadline.getTime() === expires.getTime();
}

export async function validateUnderPolicy<S extends Shape | null>(s: S, deps: ValidationDeps): Promise<S | null> {
  if (!s?.session) return s;
  if (isUnderPolicy(s.session)) return s;
  await deps.reconcile(s.session.id);
  // Whatever the reconcile returned (it may have found nothing because another request got
  // there first), judge the row as it is NOW.
  const row = await deps.read(s.session.id);
  if (!row || row.user_id !== s.user.id) return null; // revoked / signed out / not this user
  const deadline = storedSessionDeadline({
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    absoluteExpiresAt: row.absolute_expires_at,
    persistent: row.persistent,
    lastActivityAt: row.last_activity_at,
  });
  if (deadline.getTime() <= deps.now().getTime()) return null; // ran out (here or elsewhere)
  return {
    ...s,
    session: {
      ...s.session,
      expiresAt: deadline,
      absoluteExpiresAt: row.absolute_expires_at,
      persistent: row.persistent,
      lastActivityAt: row.last_activity_at,
      authMethod: row.auth_method,
    },
  };
}


import { query } from '../client.js';

/**
 * ACCESO-1 — the reads/writes behind Seguridad → Sesiones and the inactivity clock, on Better
 * Auth's own `session` table (columns from migrations 1781200000000 + 1822000000000).
 *
 * EVERY statement is keyed by the OWNER's user id: a person can only ever list, touch or
 * delete their own sessions — a foreign session id simply matches nothing. Tokens never leave
 * this module (the UI works with session ids).
 *
 * Deleting the row IS the revocation: Better Auth looks the cookie's token up on every request
 * (no cookie cache is configured), so the next request of the revoked browser — page, server
 * action, API or poll — finds nothing and is signed out.
 */

export interface UserSessionRow {
  id: string;
  user_agent: string | null;
  created_at: Date;
  last_activity_at: Date | null;
  expires_at: Date;
  absolute_expires_at: Date | null;
  persistent: boolean;
  auth_method: string | null;
}

/** The user's sessions that are still valid at `now`, most recently active first. */
export async function listActiveSessionsForUser(userId: string, now: Date = new Date()): Promise<UserSessionRow[]> {
  const result = await query<UserSessionRow>(
    `SELECT id, "userAgent" AS user_agent, "createdAt" AS created_at,
            "lastActivityAt" AS last_activity_at, "expiresAt" AS expires_at,
            "absoluteExpiresAt" AS absolute_expires_at, persistent, "authMethod" AS auth_method
       FROM "session"
      WHERE "userId" = $1 AND "expiresAt" > $2
      ORDER BY COALESCE("lastActivityAt", "createdAt") DESC`,
    [userId, now],
  );
  return result.rows;
}

/** Revoke ONE of the user's other sessions. Never the current one (that is sign-out). */
export async function deleteOtherSessionForUser(params: {
  userId: string;
  sessionId: string;
  currentSessionId: string;
}): Promise<boolean> {
  if (params.sessionId === params.currentSessionId) return false;
  const result = await query(
    `DELETE FROM "session" WHERE id = $1 AND "userId" = $2 AND id <> $3`,
    [params.sessionId, params.userId, params.currentSessionId],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Revoke every session of the user except the current one. Returns how many closed. */
export async function deleteAllOtherSessionsForUser(params: { userId: string; currentSessionId: string }): Promise<number> {
  const result = await query(`DELETE FROM "session" WHERE "userId" = $1 AND id <> $2`, [
    params.userId,
    params.currentSessionId,
  ]);
  return result.rowCount ?? 0;
}

/** The person re-proved their identity on THIS session (scoped to the owner). */
export async function markSessionReauthenticated(params: { userId: string; sessionId: string; at: Date }): Promise<boolean> {
  const result = await query(
    `UPDATE "session" SET "reauthenticatedAt" = $3, "updatedAt" = $3
      WHERE id = $1 AND "userId" = $2 AND "expiresAt" > $3`,
    [params.sessionId, params.userId, params.at],
  );
  return (result.rowCount ?? 0) > 0;
}

export interface SessionDeadline {
  expires_at: Date;
  absolute_expires_at: Date | null;
  persistent: boolean;
}

/**
 * A REAL interaction: restart the idle clock of a NON-persistent, still-valid session —
 * atomically, and never past its absolute end (LEAST). A persistent or already-expired
 * session is left untouched and its current deadline is returned (or null if gone).
 * `idleMs` comes from web/lib/sessionPolicy.ts (IDLE_TIMEOUT_MS).
 */
export async function recordSessionActivity(params: {
  userId: string;
  sessionId: string;
  now: Date;
  idleMs: number;
}): Promise<SessionDeadline | null> {
  const updated = await query<SessionDeadline>(
    `UPDATE "session"
        SET "lastActivityAt" = $3,
            "expiresAt" = LEAST($3::timestamptz + ($4::bigint * interval '1 millisecond'), "absoluteExpiresAt"),
            "updatedAt" = $3
      WHERE id = $1 AND "userId" = $2 AND persistent = false
        AND "absoluteExpiresAt" IS NOT NULL AND "expiresAt" > $3
      RETURNING "expiresAt" AS expires_at, "absoluteExpiresAt" AS absolute_expires_at, persistent`,
    [params.sessionId, params.userId, params.now, params.idleMs],
  );
  if (updated.rows[0]) return updated.rows[0];
  const current = await query<SessionDeadline>(
    `SELECT "expiresAt" AS expires_at, "absoluteExpiresAt" AS absolute_expires_at, persistent
       FROM "session" WHERE id = $1 AND "userId" = $2 AND "expiresAt" > $3`,
    [params.sessionId, params.userId, params.now],
  );
  return current.rows[0] ?? null;
}

/** The policy-relevant state of ONE session, as stored right now. */
export interface SessionPolicyRow {
  id: string;
  user_id: string;
  created_at: Date;
  expires_at: Date;
  absolute_expires_at: Date | null;
  persistent: boolean;
  last_activity_at: Date | null;
  auth_method: string | null;
}

const POLICY_COLUMNS = `s.id, s."userId" AS user_id, s."createdAt" AS created_at, s."expiresAt" AS expires_at,
            s."absoluteExpiresAt" AS absolute_expires_at, s.persistent,
            s."lastActivityAt" AS last_activity_at, s."authMethod" AS auth_method`;

/** Re-read a session's CURRENT state (never writes). Null when it no longer exists. */
export async function getSessionPolicyRow(sessionId: string): Promise<SessionPolicyRow | null> {
  const r = await query<SessionPolicyRow>(`SELECT ${POLICY_COLUMNS} FROM "session" s WHERE s.id = $1`, [sessionId]);
  return r.rows[0] ?? null;
}

/**
 * Bring sessions written by the PREVIOUS code under the policy — rows it created (no
 * absoluteExpiresAt) or slid with its 7-day refresh (past their absolute end, or past their
 * idle end). That happens while a deploy overlaps the old version and after a code-only
 * rollback. It NEVER extends anything and NEVER invents activity — reconciling at start-up,
 * on a read or on a poll is not an interaction:
 *   - no absolute end yet → LEGACY: persistent, absolute = its current deadline (capped at 30
 *     days from creation), method 'legacy'. Its activity is unknown (the old code only kept
 *     refresh times, which are reads), so lastActivityAt stays NULL;
 *   - persistent → expiresAt = min(expiresAt, absolute end);
 *   - not persistent → expiresAt = min(expiresAt, absolute end, LAST RECORDED real activity +
 *     idle window). Interaction the person had while the OLD code served is not recorded
 *     anywhere, so it cannot count: the session ends on the last activity the new code saw.
 * The result may already be in the past: that session is over. Idempotent; `sessionId`
 * limits it to one row (the per-request path).
 */
export async function reconcileLegacySessions(params: { idleMs: number; sessionId?: string }): Promise<SessionPolicyRow[]> {
  const r = await query<SessionPolicyRow>(
    `UPDATE "session" s
        SET "absoluteExpiresAt" = x.abs,
            persistent = x.persistent,
            "authMethod" = COALESCE(s."authMethod", 'legacy'),
            "expiresAt" = CASE WHEN x.persistent THEN LEAST(s."expiresAt", x.abs)
                               ELSE LEAST(s."expiresAt", x.abs, COALESCE(s."lastActivityAt", s."createdAt") + ($1::bigint * interval '1 millisecond')) END
       FROM (SELECT id,
                    COALESCE("absoluteExpiresAt", LEAST("expiresAt", "createdAt" + interval '30 days')) AS abs,
                    CASE WHEN "absoluteExpiresAt" IS NULL THEN true ELSE persistent END AS persistent
               FROM "session"
              WHERE ("absoluteExpiresAt" IS NULL
                     OR "expiresAt" > "absoluteExpiresAt"
                     OR (NOT persistent AND "expiresAt" > COALESCE("lastActivityAt", "createdAt") + ($1::bigint * interval '1 millisecond')))
                AND ($2::text IS NULL OR id = $2)) x
      WHERE s.id = x.id
      RETURNING ${POLICY_COLUMNS}`,
    [params.idleMs, params.sessionId ?? null],
  );
  return r.rows;
}

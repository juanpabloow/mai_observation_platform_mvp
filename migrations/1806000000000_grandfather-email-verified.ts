import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * MF-1 item 8 — GRANDFATHER existing accounts before email verification is enforced.
 *
 * web/lib/auth.ts flips on `requireEmailVerification`, which blocks SIGN-IN for any account
 * whose email is not verified. That closes the invitation-hijack (an attacker can no longer
 * sign in with — and accept an invite for — an email they never proved they own). But turning
 * it on without preparation would lock out every EXISTING email/password user who never
 * verified. So, at cutover, mark every currently-unverified account as verified: nobody who
 * can sign in today loses access, and the gate applies only to accounts created afterwards.
 * (Google users are already provider-verified.)
 *
 * REVERSIBLE: the ids flipped here are recorded in `_grandfathered_email_verified`, so `down`
 * restores exactly those rows (and only those) to unverified, then drops the record table.
 * This migration must run BEFORE the new code serves — with MF-1 item 1 the Railway
 * pre-deploy step runs it automatically, so there is no window of locked-out users.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS _grandfathered_email_verified (
      user_id text PRIMARY KEY,
      grandfathered_at timestamptz NOT NULL DEFAULT now()
    );
    -- Record the accounts we are about to flip (currently unverified), then flip them.
    INSERT INTO _grandfathered_email_verified (user_id)
      SELECT id FROM "user" WHERE "emailVerified" = false
    ON CONFLICT (user_id) DO NOTHING;
    UPDATE "user" SET "emailVerified" = true WHERE "emailVerified" = false;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    UPDATE "user" u SET "emailVerified" = false
      FROM _grandfathered_email_verified g
     WHERE u.id = g.user_id;
    DROP TABLE IF EXISTS _grandfathered_email_verified;
  `);
}

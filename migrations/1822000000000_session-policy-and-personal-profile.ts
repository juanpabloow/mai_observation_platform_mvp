import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * ACCESO-1 — session policy columns + the person's own profile (phone, photo).
 *
 * SESSION POLICY (Better Auth `session.additionalFields`, all `input: false` — no client can
 * write them; web/lib/auth.ts + web/lib/sessionPolicy.ts own every write):
 *   persistent         «Mantener mi sesión en este equipo» was chosen (and allowed).
 *   absoluteExpiresAt  the HARD end of the session: authentication + 30 days (persistent) or
 *                      + 12 hours (not persistent). Nothing ever moves it later.
 *   lastActivityAt     the last REAL interaction (keyboard / click / touch) the browser
 *                      reported. Polling and background requests never touch it.
 *   reauthenticatedAt  the last time the person re-proved their identity on THIS session
 *                      (password or Google); gates closing other sessions.
 *   authMethod         'password' | 'google' | 'legacy' — shown in Seguridad → Sesiones.
 * Better Auth's own `expiresAt` stays THE enforced deadline (it deletes the session once it
 * passes, in every endpoint); the policy only ever sets it to
 *   persistent:      absoluteExpiresAt
 *   not persistent:  min(lastActivityAt + 2 h, absoluteExpiresAt)
 *
 * BACKFILL (safe on production data, extends NOTHING): every session already open keeps the
 * deadline it has today. It is marked persistent with absoluteExpiresAt = its current
 * expiresAt, so no one is signed out by the deploy and no session lives one second longer
 * than it would have. Session refresh is switched off in the same release, so those
 * deadlines stop sliding.
 *
 * COMPATIBLE WITH THE PREVIOUS CODE (Railway applies this BEFORE the new code serves, and the
 * old code keeps serving meanwhile — and again after a code-only rollback). Everything is
 * additive and defaulted, so the old Better Auth config can still create, read, refresh,
 * list and revoke sessions. Deliberately NO "expiresAt <= absoluteExpiresAt" CHECK: the old
 * code's 7-day sliding refresh would violate it and fail requests. Rows the old code creates
 * or slides in that window are clamped by the new code instead
 * (src/db/repositories/authSessions.ts reconcileLegacySessions — at server start and on every
 * session read). Verified locally by test/migrations/acceso/run.sh.
 *
 * DOWN DESTROYS DATA: it drops user_profiles (phones) and user_avatars (photos) and the
 * session policy columns. It refuses to run while either table has rows unless
 * ACCESO_DOWN_ALLOW_DATA_LOSS=1. A code rollback does NOT need it (the old code works with
 * this schema).
 *
 * PERSONAL PROFILE — data about the PERSON who signs in (never a CRM contact, never a
 * professional's public booking profile):
 *   user_profiles  phone in E.164 + the ISO country it was entered with (server-validated
 *                  with libphonenumber), and when the optional "Completa tu perfil" step was
 *                  finished or skipped.
 *   user_avatars   the uploaded photo, PRIVATE: stored here (not in the public R2 bucket the
 *                  booking page uses) and served only through an authenticated route.
 * Both cascade with the auth user.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE "session"
      ADD COLUMN "persistent" boolean NOT NULL DEFAULT false,
      ADD COLUMN "absoluteExpiresAt" timestamptz,
      ADD COLUMN "lastActivityAt" timestamptz,
      ADD COLUMN "reauthenticatedAt" timestamptz,
      ADD COLUMN "authMethod" text;

    -- lastActivityAt stays NULL: the old code never recorded interaction ("updatedAt" is a
    -- refresh, i.e. a read), and a legacy session is persistent, so no idle clock applies.
    UPDATE "session"
       SET "persistent" = true,
           "absoluteExpiresAt" = "expiresAt",
           "authMethod" = 'legacy';

    ALTER TABLE "session"
      ADD CONSTRAINT session_auth_method_check
        CHECK ("authMethod" IS NULL OR "authMethod" IN ('password', 'google', 'legacy'));

    CREATE TABLE user_profiles (
      user_id text PRIMARY KEY REFERENCES "user" ("id") ON DELETE CASCADE,
      phone_e164 text CHECK (phone_e164 IS NULL OR phone_e164 ~ '^\\+[1-9][0-9]{6,14}$'),
      phone_country text CHECK (phone_country IS NULL OR phone_country ~ '^[A-Z]{2}$'),
      onboarded_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CHECK ((phone_e164 IS NULL) = (phone_country IS NULL))
    );

    CREATE TABLE user_avatars (
      user_id text PRIMARY KEY REFERENCES "user" ("id") ON DELETE CASCADE,
      content_type text NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp')),
      bytes bytea NOT NULL CHECK (octet_length(bytes) BETWEEN 1 AND 921600),
      sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  if (process.env.ACCESO_DOWN_ALLOW_DATA_LOSS !== '1') {
    pgm.sql(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM user_profiles) OR EXISTS (SELECT 1 FROM user_avatars) THEN
          RAISE EXCEPTION 'Refusing to drop user_profiles/user_avatars: they hold people''s phones and photos. Export them first, then re-run with ACCESO_DOWN_ALLOW_DATA_LOSS=1.';
        END IF;
      END $$;
    `);
  }
  pgm.sql(`
    DROP TABLE IF EXISTS user_avatars;
    DROP TABLE IF EXISTS user_profiles;
    ALTER TABLE "session"
      DROP CONSTRAINT IF EXISTS session_auth_method_check,
      DROP COLUMN IF EXISTS "authMethod",
      DROP COLUMN IF EXISTS "reauthenticatedAt",
      DROP COLUMN IF EXISTS "lastActivityAt",
      DROP COLUMN IF EXISTS "absoluteExpiresAt",
      DROP COLUMN IF EXISTS "persistent";
  `);
}

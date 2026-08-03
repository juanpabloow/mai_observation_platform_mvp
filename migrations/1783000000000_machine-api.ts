import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * C-5 machine API. Three additive, reversible changes:
 *
 *  1. handoff_tokens.capabilities text[] — per-token capability scoping (audit E12,
 *     "risk ①"). text[] + a GIN index is the simplest fit: a small fixed vocabulary of
 *     flat dot-separated strings, checked with array containment / .includes(); no
 *     nested structure to justify JSONB.
 *
 *     ZERO-BREAKAGE: the column is ADDED with a DEFAULT of the legacy authority
 *     { handoff, scheduling.read, scheduling.write }, so EVERY existing token receives
 *     exactly that in the same DDL — there is no window in which a live token has no
 *     capabilities. The default is then reset to '{}' so tokens issued AFTER this phase
 *     are deny-by-default unless the issuer picks capabilities. The separate backfill
 *     script (backfill:token-capabilities) is an idempotent confirm that prints counts.
 *
 *  2. contact_notes.author_kind ('user' | 'automation') + idempotency_key — an
 *     automation (n8n) may author a note; created_by_user_id is already nullable, but a
 *     bare null is indistinguishable from a deleted member (renders "System"), so an
 *     explicit kind lets the C-4 timeline attribute automation notes honestly.
 *     idempotency_key makes POST notes replay-safe (agents retry), mirroring
 *     appointments.idempotency_key.
 *
 *  3. crm_activity_events.actor_kind ('user' | 'automation') — same reasoning for the
 *     audit facts (tag/consent/stage changes) a machine writes, so the timeline shows
 *     automation-driven changes as "Automation" rather than "System".
 *
 * All existing rows default to 'user'/legacy-triple (what they effectively are today).
 */

export async function up(pgm: MigrationBuilder): Promise<void> {
  // 1. Token capabilities — legacy triple for existing rows, then deny-by-default going forward.
  pgm.sql(`
    ALTER TABLE handoff_tokens
      ADD COLUMN capabilities text[] NOT NULL
      DEFAULT ARRAY['handoff','scheduling.read','scheduling.write']::text[];
    ALTER TABLE handoff_tokens ALTER COLUMN capabilities SET DEFAULT '{}'::text[];
    CREATE INDEX handoff_tokens_capabilities_idx ON handoff_tokens USING GIN (capabilities);
  `);

  // 2. Automation-authored + idempotent notes.
  pgm.sql(`
    ALTER TABLE contact_notes
      ADD COLUMN author_kind text NOT NULL DEFAULT 'user'
      CHECK (author_kind IN ('user','automation'));
    ALTER TABLE contact_notes ADD COLUMN idempotency_key text;
    CREATE UNIQUE INDEX contact_notes_idempotency_uniq
      ON contact_notes (tenant_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL;
  `);

  // 3. Automation-attributed audit facts.
  pgm.sql(`
    ALTER TABLE crm_activity_events
      ADD COLUMN actor_kind text NOT NULL DEFAULT 'user'
      CHECK (actor_kind IN ('user','automation'));
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`ALTER TABLE crm_activity_events DROP COLUMN actor_kind;`);
  pgm.sql(`
    DROP INDEX IF EXISTS contact_notes_idempotency_uniq;
    ALTER TABLE contact_notes DROP COLUMN idempotency_key;
    ALTER TABLE contact_notes DROP COLUMN author_kind;
  `);
  pgm.sql(`
    DROP INDEX IF EXISTS handoff_tokens_capabilities_idx;
    ALTER TABLE handoff_tokens DROP COLUMN capabilities;
  `);
}

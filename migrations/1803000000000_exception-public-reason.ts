import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * PUBLIC REASON of a block (schedule_exceptions) — what MAY be told to a customer, kept
 * apart from `reason`, which stays INTERNAL (it can hold medical, personal or team detail
 * and is never returned by the machine API nor sent to a model).
 *
 * A CONTROLLED list, chosen explicitly by a person in the block form:
 *   vacation     "Vacaciones"        — a professional's block only
 *   unavailable  "No disponible"     — a professional's block or a site closure
 *   site_closed  "Cierre de la sede" — a site-wide block only (staff_id NULL)
 * NULL = nothing communicable — the DEFAULT, also for every existing block. Nothing is
 * derived from `reason` (no copy, no keyword classification). There is deliberately no
 * medical code.
 *
 * Additive and safe to apply before the code that reads it. DOWN refuses while any block
 * carries a public reason (a person's explicit choice is not dropped silently).
 *
 * Number note: 1802 is taken by feature/reviews-external-fresha (not merged yet). With
 * node-pg-migrate's order check, apply 1802 before 1803 in any database that will get both.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE schedule_exceptions
      ADD COLUMN public_reason text,
      ADD CONSTRAINT schedule_exceptions_public_reason_check
        CHECK (public_reason IS NULL OR public_reason IN ('vacation', 'unavailable', 'site_closed')),
      ADD CONSTRAINT schedule_exceptions_public_reason_scope_check
        CHECK (
          public_reason IS NULL
          OR (public_reason = 'vacation' AND staff_id IS NOT NULL)
          OR (public_reason = 'site_closed' AND staff_id IS NULL)
          OR public_reason = 'unavailable'
        );
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM schedule_exceptions WHERE public_reason IS NOT NULL) THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
          MESSAGE = 'Cannot drop schedule_exceptions.public_reason while blocks carry one. Clear them explicitly first; nothing was changed.';
      END IF;
    END $$;
    ALTER TABLE schedule_exceptions
      DROP CONSTRAINT schedule_exceptions_public_reason_scope_check,
      DROP CONSTRAINT schedule_exceptions_public_reason_check,
      DROP COLUMN public_reason;
  `);
}

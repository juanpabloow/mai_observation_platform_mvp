import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * FEATURED SERVICES. One additive, reversible column so an operator can mark the 2–3
 * signature services an AI agent should offer FIRST when a customer hasn't said what they
 * want (durations differ, so the agent must pick a service before it can check availability).
 *
 * `featured boolean NOT NULL DEFAULT false` — no backfill needed: default false is correct
 * (the operator opts a service in). Ordering "featured first" is done in SQL
 * (ORDER BY featured DESC, name); with no featured rows configured the API falls back to the
 * full list, so a bare `featured DESC` never produces an empty offer. No index: the
 * per-(tenant,client) service catalogue is tiny.
 *
 * `display_order` was considered and DEFERRED: without a reorder UI every row would be NULL
 * and it would add nothing over name-ordering; featured services are ordered by name, which
 * is stable. Add it in a later phase alongside a drag-to-order control if wanted.
 */

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`ALTER TABLE services ADD COLUMN featured boolean NOT NULL DEFAULT false;`);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`ALTER TABLE services DROP COLUMN featured;`);
}

import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * COSTOS DE IA → Ejecuciones — the n8n plan of each connection, typed in by the agency (n8n's API
 * does not expose the quota): how many production executions a cycle allows and the day of the
 * month the counter restarts. Both NULL = not configured (the screen then shows usage without a
 * limit). Reset day 1–28 so every month has it. Additive and nullable. Reversible.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE n8n_connections
      ADD COLUMN plan_monthly_executions integer
        CONSTRAINT n8n_connections_plan_executions_check CHECK (plan_monthly_executions IS NULL OR plan_monthly_executions BETWEEN 1 AND 100000000),
      ADD COLUMN plan_reset_day smallint
        CONSTRAINT n8n_connections_plan_reset_day_check CHECK (plan_reset_day IS NULL OR plan_reset_day BETWEEN 1 AND 28);
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE n8n_connections DROP COLUMN plan_reset_day, DROP COLUMN plan_monthly_executions;
  `);
}

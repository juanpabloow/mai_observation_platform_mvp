import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * VALUE DASHBOARD — read index for Q4a / Q5 (appointments filtered by tenant, client and
 * created_at; until now the only per-client appointment index was on start_at).
 *
 * Built CONCURRENTLY so it never blocks the agenda: a plain CREATE INDEX holds a SHARE lock on
 * `appointments` for the whole build, refusing every INSERT/UPDATE/DELETE (bookings, the bot,
 * the agenda) until it finishes. CONCURRENTLY takes SHARE UPDATE EXCLUSIVE instead: reads and
 * writes keep flowing; only other DDL/VACUUM on the table waits.
 *
 * How the real runner executes it (`npm run migrate:prod` = node-pg-migrate --tsx, v8, which
 * by default wraps ALL pending migrations in ONE transaction): `pgm.noTransaction()` makes the
 * runner COMMIT what ran before (1812 included), run each `pgm.sql` below as its own
 * statement outside any transaction, and BEGIN again afterwards. CONCURRENTLY is impossible
 * inside a transaction, hence the separate migration and one statement per `pgm.sql`.
 *
 * Failure / retry: a CONCURRENTLY build that fails or times out leaves an INVALID index behind
 * and the migration unrecorded. The first step drops any leftover of that name, so simply
 * re-running the deploy repairs it. `lock_timeout` bounds the wait for transactions already
 * touching `appointments` (the build must wait for them): if one is stuck, the step fails in
 * 10 s instead of stalling the pre-deploy, and the deploy can be retried.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.noTransaction();
  pgm.sql(`SET lock_timeout = '10s'`);
  pgm.sql(`DROP INDEX CONCURRENTLY IF EXISTS appointments_tenant_client_created_idx`);
  pgm.sql(`CREATE INDEX CONCURRENTLY appointments_tenant_client_created_idx ON appointments (tenant_id, client_id, created_at)`);
  pgm.sql(`RESET lock_timeout`);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.noTransaction();
  pgm.sql(`DROP INDEX CONCURRENTLY IF EXISTS appointments_tenant_client_created_idx`);
}

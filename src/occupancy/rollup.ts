import { logger } from '../logger.js';
import { recordOccupancyFailure } from './failures.js';
import { OCCUPANCY_FUTURE_DAYS, OCCUPANCY_PAST_DAYS } from './hooks.js';
import { recomputeStaffDays } from './compute.js';
import { claimDirtyBatch, clearDirty, markDirtyWindowAll, type ClaimedDirtyRow } from '../db/repositories/scheduling/occupancy.js';

/**
 * JP-8 §1 — the occupancy workers.
 *  - the DRAIN job (every ~2 min): recompute the dirty (staff, day) rows that writes enqueued, then
 *    clear them. Dirty rows are grouped by professional so one engine load covers a staff's days.
 *  - the NIGHTLY pass (every ~24 h, and once at boot): re-enqueue the rolling window [−35, +30] for
 *    every bookable professional, so the passage of time and any hours/break/closure edit is always
 *    reconciled even if a dirty-mark was missed.
 * Both follow the repo's periodic-job shape: a module-level handle, a `running` reentry guard, an
 * unref'd timer, and fail-safe error handling (a failure is swallowed + counted, never thrown).
 */

const DEFAULT_ROLLUP_INTERVAL_SECONDS = 120;
const DEFAULT_NIGHTLY_INTERVAL_SECONDS = 86_400;
const DRAIN_BATCH = 500;

export interface RollupResult {
  claimed: number;
  recomputed: number; // (staff, day) rows recomputed
}

let draining = false;

/** Recompute one claimed batch of dirty days. Groups rows by professional so each staff's days load
 *  the engine once; a per-staff failure leaves that group's rows dirty (retried next pass). */
export async function runOccupancyRollupOnce(opts: { limit?: number } = {}): Promise<RollupResult> {
  if (draining) return { claimed: 0, recomputed: 0 };
  draining = true;
  try {
    const batch = await claimDirtyBatch(opts.limit ?? DRAIN_BATCH);
    if (batch.length === 0) return { claimed: 0, recomputed: 0 };

    const groups = new Map<string, { key: ClaimedDirtyRow; rows: ClaimedDirtyRow[] }>();
    for (const row of batch) {
      const k = `${row.tenantId}|${row.clientId}|${row.siteId}|${row.staffId}`;
      const g = groups.get(k) ?? { key: row, rows: [] };
      g.rows.push(row);
      groups.set(k, g);
    }

    let recomputed = 0;
    for (const { key, rows } of groups.values()) {
      try {
        await recomputeStaffDays(key.tenantId, key.clientId, key.siteId, key.staffId, rows.map((r) => r.day));
        for (const row of rows) await clearDirty(row);
        recomputed += rows.length;
      } catch (err) {
        // Leave this group's rows dirty so the next pass retries; never throw.
        recordOccupancyFailure({ job: 'occupancy-rollup', staffId: key.staffId }, err);
      }
    }
    if (recomputed > 0) logger.info({ claimed: batch.length, recomputed }, 'occupancy: recomputed dirty days');
    return { claimed: batch.length, recomputed };
  } catch (err) {
    recordOccupancyFailure({ job: 'occupancy-rollup-cycle' }, err);
    return { claimed: 0, recomputed: 0 };
  } finally {
    draining = false;
  }
}

/** Re-enqueue the rolling window for every bookable professional. Idempotent — just marks dirty; the
 *  drain job does the recompute. */
export async function runOccupancyNightlyOnce(): Promise<void> {
  try {
    await markDirtyWindowAll(OCCUPANCY_PAST_DAYS, OCCUPANCY_FUTURE_DAYS);
    logger.info({ pastDays: OCCUPANCY_PAST_DAYS, futureDays: OCCUPANCY_FUTURE_DAYS }, 'occupancy: nightly rolling window enqueued');
  } catch (err) {
    recordOccupancyFailure({ job: 'occupancy-nightly' }, err);
  }
}

let drainHandle: NodeJS.Timeout | null = null;
let nightlyHandle: NodeJS.Timeout | null = null;

export function startOccupancyRollup(env: NodeJS.ProcessEnv = process.env): void {
  if (drainHandle) return;
  const secs = Number(env.OCCUPANCY_ROLLUP_INTERVAL_SECONDS) || DEFAULT_ROLLUP_INTERVAL_SECONDS;
  drainHandle = setInterval(() => void runOccupancyRollupOnce(), secs * 1000);
  drainHandle.unref();
  logger.info({ intervalSeconds: secs }, 'occupancy rollup drain started');
}

export function stopOccupancyRollup(): void {
  if (drainHandle) {
    clearInterval(drainHandle);
    drainHandle = null;
  }
}

export function startOccupancyNightly(env: NodeJS.ProcessEnv = process.env): void {
  if (nightlyHandle) return;
  const secs = Number(env.OCCUPANCY_NIGHTLY_INTERVAL_SECONDS) || DEFAULT_NIGHTLY_INTERVAL_SECONDS;
  // Enqueue once shortly after boot so a fresh worker fills the window without waiting a full day.
  nightlyHandle = setInterval(() => void runOccupancyNightlyOnce(), secs * 1000);
  nightlyHandle.unref();
  void runOccupancyNightlyOnce();
  logger.info({ intervalSeconds: secs }, 'occupancy nightly window job started');
}

export function stopOccupancyNightly(): void {
  if (nightlyHandle) {
    clearInterval(nightlyHandle);
    nightlyHandle = null;
  }
}

/**
 * IMMEDIATE WALK-IN — the ONE exception to a site's minimum notice: an authorised operator
 * registering, from the agenda, someone who is already here ("Atención sin cita · ahora").
 *
 * Only the minimum notice is waived, and only for a start inside the immediate window
 * [now, now + window]; every other rule still applies on the server (hours, breaks, blocks,
 * absences, appointments, buffers, horizon, the professional's services, permissions).
 * Nothing else can ask for it: the bot API and the public page build their booking input
 * themselves and never set the flag (test/integration/immediateWalkIn.test.ts). A later
 * time offered when there is no room now is a NORMAL booking with the normal notice.
 */
export const IMMEDIATE_WINDOW_MIN = 15;

/** Minutes ahead that still count as "now": at least one slot of the site's grid. */
export function immediateWindowMin(slotIntervalMin: number): number {
  return Math.max(IMMEDIATE_WINDOW_MIN, Number.isFinite(slotIntervalMin) ? slotIntervalMin : 0);
}

/** Is `startAt` an immediate start at `now` for this grid? */
export function isImmediateStart(startAt: Date, now: Date, slotIntervalMin: number): boolean {
  const d = startAt.getTime() - now.getTime();
  return d >= -60_000 && d <= immediateWindowMin(slotIntervalMin) * 60_000;
}

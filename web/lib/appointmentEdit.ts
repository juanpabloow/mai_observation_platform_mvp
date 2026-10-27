/**
 * JP-5 — pure helpers for editing an appointment IN PLACE (service / professional / time), shared
 * by the inline editors and unit-tested. No React, no I/O: the editor computes the preview and the
 * live conflict from these, and the SERVER re-checks every change on save (it is the authority; it
 * uses the full blocked window incl. buffers — see src/scheduling/booking.ts). The operator never
 * sees buffers, so the live conflict overlaps on the VISIBLE service interval, which is what the
 * agenda draws and what the "Choca con…" line refers to.
 */

/** The minimum an already-loaded day appointment needs for the conflict check + its label. */
export interface EditableAppt {
  id: string;
  staff_id: string;
  staff_name: string | null;
  start_at: string;
  service_end_at: string;
  status: string;
  service_name: string;
  contact_name?: string | null;
  guest_name?: string | null;
}

export interface Candidate {
  staffId: string;
  /** Epoch ms of the candidate's start and end (the visible service interval). */
  startMs: number;
  endMs: number;
  /** The appointment being edited — never conflicts with itself. */
  excludeId: string;
}

/** Two half-open intervals overlap iff aStart < bEnd and bStart < aEnd. */
function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * The FIRST active appointment of `staffId` whose visible interval overlaps the candidate's,
 * excluding the appointment being edited and any cancelled one (cancelled never blocks — mirrors
 * the engine's `status <> 'cancelled'` overlap filter). null when the slot is clear.
 */
export function findOverlap(appts: readonly EditableAppt[], cand: Candidate): EditableAppt | null {
  for (const a of appts) {
    if (a.id === cand.excludeId || a.staff_id !== cand.staffId || a.status === "cancelled") continue;
    const s = Date.parse(a.start_at);
    const e = Date.parse(a.service_end_at);
    if (Number.isNaN(s) || Number.isNaN(e)) continue;
    if (overlaps(cand.startMs, cand.endMs, s, e)) return a;
  }
  return null;
}

/** The customer label of a conflicting appointment (contact name, else the typed walk-in name). */
export function apptWho(a: EditableAppt): string {
  return (a.contact_name ?? a.guest_name ?? "").trim() || "otra cita";
}

/** Is this appointment in the FUTURE (so a time/artist change goes through reschedule, with its
 *  availability rules) vs PAST/completed (a correction, no availability rules)?  A terminal state
 *  that only ever exists in the past (completed/no_show) is always a correction. */
export function isReschedule(status: string, startAtMs: number, nowMs: number): boolean {
  if (status === "completed" || status === "no_show" || status === "cancelled") return false;
  return startAtMs > nowMs;
}

/** Minutes → "45 min" / "1 h" / "1 h 30 min". */
export function durationText(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/**
 * Appointment STATUS vocabulary for the agenda's preview and detail — labels, the
 * header tone of each state, and the transitions an operator may pick.
 *
 * NEXT_STATUSES mirrors the booking engine's LEGAL_STATUS (src/scheduling/booking.ts)
 * so the selector never OFFERS a change the server would refuse; the server still
 * validates every transition (this list is UX, not the gate).
 */

export type AppointmentStatus = "scheduled" | "confirmed" | "completed" | "cancelled" | "no_show";

export const STATUS_NAME: Record<string, string> = {
  scheduled: "Sin confirmar",
  confirmed: "Confirmada",
  completed: "Completada",
  cancelled: "Cancelada",
  no_show: "Inasistencia",
};

/** The colour of a STATE (preview header, status chip) — `.u-status-*` in globals.css.
 * Deliberately not the card's service pastel, so the two can never be confused. */
export function statusToneClass(status: string): string {
  return `u-status-${status in STATUS_NAME ? status : "scheduled"}`;
}

export const NEXT_STATUSES: Record<string, AppointmentStatus[]> = {
  scheduled: ["confirmed", "completed", "no_show", "cancelled"],
  confirmed: ["completed", "no_show", "cancelled"],
  completed: [],
  cancelled: [],
  no_show: [],
};

/** Transitions that can't be undone from the agenda — they ask for confirmation first. */
export const DESTRUCTIVE: ReadonlySet<string> = new Set(["cancelled", "no_show"]);

export const isLive = (status: string) => status === "scheduled" || status === "confirmed";

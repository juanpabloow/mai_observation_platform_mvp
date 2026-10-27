import { NEXT_STATUSES, type AppointmentStatus } from "../components/scheduling/agenda/status";

/**
 * Which actions the appointment DETAIL offers — one decision shared by the desktop panel
 * and the phone sheet, unit-tested (test/unit/appointmentActionPlan.test.ts).
 *
 * `canModify` is NOT a UI rule: the agenda page computes it per appointment on the
 * server with the SAME predicates every appointment action's gate applies
 * (canOperateScheduling + canAccessSchedulingSite + canAccessSchedulingStaff — see
 * gateAppointment in lib/schedulingActions.ts). A staff login viewing another
 * professional's appointment gets `false`, so it is offered nothing the server would
 * refuse; the server still checks every request regardless.
 *
 * Reading is unchanged: whoever may see the appointment still sees it. The activity
 * history goes through that same gate on the server, so it follows `canModify` too.
 */
type Target = Exclude<AppointmentStatus, "scheduled">;

export interface ActionPlan {
  /** May act on THIS appointment (operate the agenda AND the server's per-appointment gate). */
  allowed: boolean;
  /** Every legal next state (engine's LEGAL_STATUS mirror), empty when not allowed.
   *  "completed" only once the appointment has started — the server refuses it before
   *  (transitionStatus · requireStartedToComplete), on desktop and phone alike. */
  transitions: Target[];
  /** Live and not started yet: "Completar se habilita al empezar la cita". */
  completeWaitsForStart: boolean;
  /** Desktop state menu: the transitions minus "completed" (that one is the footer primary). */
  stateMenu: Target[];
  /** Desktop footer primary "Completar cita". */
  complete: boolean;
  /** Phone footer primary: the next valid step (Sin confirmar → Confirmar, Confirmada → Completar). */
  primary: Target | null;
  reschedule: boolean;
  /** JP-4 «Cambiar servicio» — change the booked service (scheduled/confirmed/completed).
   *  Offered for completed too (D3); a completed appointment with a recorded payment is
   *  routed to void → re-charge inside the flow, and the server refuses it anyway. */
  changeService: boolean;
  /** JP-4 «Corregir hora o profesional» — a CORRECTION (past/completed allowed), distinct
   *  from Reagendar. Any status except cancelled; the server refuses an artist change on a
   *  paid appointment (void → re-charge). */
  correctTime: boolean;
  /** "Ver actividad" — the server reads it through the same appointment gate. */
  readActivity: boolean;
  /** "Enlace de reseña" — only for a COMPLETED appointment this login may act on. */
  reviewLink: boolean;
}

export function appointmentActionPlan(input: {
  canOperate: boolean;
  canModify: boolean;
  status: string;
  /** The appointment's start, and the clock it is compared with. */
  startAt: string;
  now: number;
}): ActionPlan {
  const allowed = input.canOperate && input.canModify;
  const live = input.status === "scheduled" || input.status === "confirmed";
  const started = Date.parse(input.startAt) <= input.now;
  const legal = (allowed && live ? NEXT_STATUSES[input.status] ?? [] : []).filter((t): t is Target => t !== "scheduled");
  const transitions = started ? legal : legal.filter((t) => t !== "completed");
  return {
    allowed,
    transitions,
    completeWaitsForStart: !started && legal.includes("completed"),
    stateMenu: transitions.filter((t) => t !== "completed"),
    complete: transitions.includes("completed"),
    primary: !allowed || !live ? null : input.status === "scheduled" ? "confirmed" : started ? "completed" : null,
    reschedule: allowed && live,
    changeService: allowed && (input.status === "scheduled" || input.status === "confirmed" || input.status === "completed"),
    correctTime: allowed && input.status !== "cancelled",
    readActivity: allowed,
    reviewLink: allowed && input.status === "completed",
  };
}

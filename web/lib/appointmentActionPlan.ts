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
  /** Every legal next state (engine's LEGAL_STATUS mirror), empty when not allowed. */
  transitions: Target[];
  /** Desktop state menu: the transitions minus "completed" (that one is the footer primary). */
  stateMenu: Target[];
  /** Desktop footer primary "Completar cita". */
  complete: boolean;
  /** Phone footer primary: the next valid step (Sin confirmar → Confirmar, Confirmada → Completar). */
  primary: Target | null;
  reschedule: boolean;
  /** "Ver actividad" — the server reads it through the same appointment gate. */
  readActivity: boolean;
}

export function appointmentActionPlan(input: { canOperate: boolean; canModify: boolean; status: string }): ActionPlan {
  const allowed = input.canOperate && input.canModify;
  const live = input.status === "scheduled" || input.status === "confirmed";
  const transitions = (allowed && live ? NEXT_STATUSES[input.status] ?? [] : []).filter((t): t is Target => t !== "scheduled");
  return {
    allowed,
    transitions,
    stateMenu: transitions.filter((t) => t !== "completed"),
    complete: transitions.includes("completed"),
    primary: !allowed || !live ? null : input.status === "scheduled" ? "confirmed" : "completed",
    reschedule: allowed && live,
    readActivity: allowed,
  };
}

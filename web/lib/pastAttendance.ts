import { fmtTime } from "./siteCalendar";

/**
 * «Registrar atención realizada» — what the agenda shows about a service that already
 * happened: the shapes the server returns (web/lib/schedulingActions.ts · checkPastAttendance)
 * and the Spanish the form reads them in. Pure; no server import, so the panel can use it.
 */

/** A schedule rule the exact interval runs into (src/scheduling/pastAttendance.ts). */
export interface PastProblemView {
  code: string;
  from: string;
  until: string;
}

/** Another appointment of the professional in that time. */
export interface PastConflict {
  id: string;
  startAt: string;
  endAt: string;
  service: string;
  status: string;
  customer: string | null;
  /** Its local day at the site — to open it in the agenda. */
  dayKey: string;
}

export const PAST_STATUS_WORD: Record<string, string> = {
  scheduled: "Sin confirmar",
  confirmed: "Confirmada",
  completed: "Completada",
  no_show: "Inasistencia",
};

/** «Pausa de 13:00 a 14:00», «Termina a las 14:00» … — one line per rule, with its times. */
export function pastProblemText(p: PastProblemView, timeZone: string, staffFirst: string): string {
  const span = `de ${fmtTime(p.from, timeZone)} a ${fmtTime(p.until, timeZone)}`;
  switch (p.code) {
    case "not_ended":
      return `Aún no ha terminado: termina a las ${fmtTime(p.from, timeZone)}. Regístrala cuando termine.`;
    case "site_closed_day":
      return "La sede no abre ese día según su horario actual.";
    case "outside_site_hours":
      return `Fuera del horario de la sede (${span}).`;
    case "off_shift":
      return `Fuera del horario de ${staffFirst || "este profesional"} (${span}).`;
    case "break":
      return `Coincide con una pausa habitual (${span}).`;
    case "site_closure":
      return `Coincide con un bloqueo de la sede (${span}).`;
    case "absence":
      return `Coincide con un bloqueo o una ausencia de ${staffFirst || "este profesional"} (${span}).`;
    default:
      return `No estaba disponible ${span}.`;
  }
}

import type { DayExplanation, ExplainCause, SummaryCode } from "@worker/scheduling/availabilityExplain.js";
import { PUBLIC_REASON_LABEL, type PublicAbsenceReason } from "./publicAbsenceReason";

/**
 * What the machine API says about WHY a professional has no slots — the `explanation`
 * block of GET /api/scheduling/v1/availability?explain=true (contract version 1).
 *
 * Every customer-facing sentence here is built from CODES only (a cause, a public reason
 * chosen in the block form, the professional's name). Nothing is derived from the internal
 * block text, nothing is inferred from an empty slot list, and a block's end is never turned
 * into a "back on" date — `next_available` comes from real engine slots only.
 *
 * Messages are es-CO, short and safe to read out as is; an assistant may rephrase them but
 * must not add a reason they do not state.
 */

export const EXPLANATION_VERSION = 1;

export interface DayExplanationJson {
  date: string;
  status: "available" | "unavailable";
  slot_count: number;
  summary: SummaryCode;
  public_reason: PublicAbsenceReason | null;
  public_reason_label: string | null;
  customer_message: string;
  causes: Array<{
    code: ExplainCause["code"];
    coverage: "all" | "part";
    minutes: number;
    public_reason: PublicAbsenceReason | null;
  }>;
}

const NO_AVAILABILITY = (name: string) => `${name} no tiene disponibilidad para ese horario.`;

/** The one sentence for a day. Unconfirmed → the neutral "no availability" line. */
export function dayCustomerMessage(d: DayExplanation, staffName: string): string {
  if (d.status === "available") return `${staffName} tiene ${d.slot_count === 1 ? "1 horario disponible" : `${d.slot_count} horarios disponibles`} ese día.`;
  const cause = d.causes.find((c) => c.code === d.summary);
  const when = cause?.covers_whole_working_day ? "en esa fecha" : "en ese horario";
  switch (d.summary) {
    case "absence":
      if (d.public_reason === "vacation") return `${staffName} está de vacaciones ${when}.`;
      if (d.public_reason === "unavailable") return `${staffName} no está disponible ${when}.`;
      return NO_AVAILABILITY(staffName);
    case "site_closure":
      if (d.public_reason === "site_closed") return `La sede está cerrada ${when}.`;
      if (d.public_reason === "unavailable") return `La sede no está disponible ${when}.`;
      return NO_AVAILABILITY(staffName);
    case "site_closed_day":
      return "La sede no abre ese día.";
    case "outside_site_hours":
      return "La sede no atiende en ese horario.";
    case "off_shift":
      return cause?.no_shift_that_day ? `${staffName} no trabaja ese día.` : `${staffName} no trabaja en ese horario.`;
    case "booked":
      return `${staffName} ya tiene ocupado ese horario.`;
    case "service_does_not_fit":
      return `${staffName} no tiene un espacio suficiente para ese servicio en ese horario.`;
    case "no_valid_start_in_window":
      return "El servicio no alcanza a terminar dentro de ese horario.";
    case "min_notice":
      return "Ese horario ya no se puede reservar con tan poca anticipación.";
    case "beyond_booking_horizon":
      return "Todavía no se puede reservar con tanta anticipación.";
    case "in_the_past":
      return "Ese horario ya pasó.";
    default:
      return NO_AVAILABILITY(staffName);
  }
}

export function projectDay(d: DayExplanation, staffName: string): DayExplanationJson {
  return {
    date: d.date,
    status: d.status,
    slot_count: d.slot_count,
    summary: d.summary,
    public_reason: d.public_reason,
    public_reason_label: d.public_reason ? PUBLIC_REASON_LABEL[d.public_reason] : null,
    customer_message: dayCustomerMessage(d, staffName),
    causes: d.causes.map((c) => ({ code: c.code, coverage: c.coverage, minutes: c.minutes, public_reason: c.public_reason })),
  };
}

/**
 * The whole request for one professional: `available` (every day has slots), `partial`
 * (some do), `unavailable` (none). A single summary/public reason only when EVERY requested
 * day is unavailable for the SAME confirmed cause — otherwise `multiple` and the per-day list.
 */
export function rangeSummary(days: DayExplanation[], staffName: string): {
  status: "available" | "partial" | "unavailable";
  summary: SummaryCode;
  public_reason: PublicAbsenceReason | null;
  public_reason_label: string | null;
  customer_message: string;
} {
  const open = days.filter((d) => d.status === "available").length;
  if (days.length > 0 && open === days.length) {
    return { status: "available", summary: "available", public_reason: null, public_reason_label: null, customer_message: `${staffName} tiene disponibilidad en ese periodo.` };
  }
  if (open > 0) {
    return { status: "partial", summary: "available", public_reason: null, public_reason_label: null, customer_message: `${staffName} tiene disponibilidad solo algunos días de ese periodo.` };
  }
  if (days.length === 1) {
    const d = days[0];
    return { status: "unavailable", summary: d.summary, public_reason: d.public_reason, public_reason_label: d.public_reason ? PUBLIC_REASON_LABEL[d.public_reason] : null, customer_message: dayCustomerMessage(d, staffName) };
  }
  const first = days[0];
  const same = days.every((d) => d.summary === first.summary && d.public_reason === first.public_reason);
  if (!same) {
    return { status: "unavailable", summary: "multiple", public_reason: null, public_reason_label: null, customer_message: `${staffName} no tiene disponibilidad en esas fechas.` };
  }
  const plural = dayCustomerMessage(first, staffName).replace("en esa fecha", "en esas fechas").replace("ese día", "esos días");
  return {
    status: "unavailable",
    summary: first.summary,
    public_reason: first.public_reason,
    public_reason_label: first.public_reason ? PUBLIC_REASON_LABEL[first.public_reason] : null,
    customer_message: plural,
  };
}

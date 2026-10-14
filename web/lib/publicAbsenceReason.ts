import type { PublicAbsenceReason } from "@worker/scheduling/availabilityExplain.js";

/**
 * PUBLIC REASON of a block — the ONLY absence detail that may reach a customer (via the
 * assistant). A controlled list chosen explicitly in the block form; `null` ("No mostrar
 * motivo") is the default. The internal `reason` text is never copied, classified or sent.
 * Pure and client-safe: the forms, the server actions and the API share it.
 */

export type { PublicAbsenceReason };

export const PUBLIC_REASONS: readonly PublicAbsenceReason[] = ["vacation", "unavailable", "site_closed"];

export const PUBLIC_REASON_LABEL: Record<PublicAbsenceReason, string> = {
  vacation: "Vacaciones",
  unavailable: "No disponible",
  site_closed: "Cierre de la sede",
};

/** Which codes a block of this scope may carry (mirrors the DB CHECK of migration 1803). */
export function publicReasonsFor(scope: "staff" | "site"): PublicAbsenceReason[] {
  return scope === "staff" ? ["vacation", "unavailable"] : ["site_closed", "unavailable"];
}

/** Form/server input → a code allowed for the scope, null (= not shown), or an error. */
export function parsePublicReason(
  raw: unknown,
  scope: "staff" | "site",
): { ok: true; value: PublicAbsenceReason | null } | { ok: false; error: string } {
  if (raw === null || raw === undefined || raw === "") return { ok: true, value: null };
  if (typeof raw !== "string" || !(PUBLIC_REASONS as readonly string[]).includes(raw)) {
    return { ok: false, error: "Motivo para el cliente no válido." };
  }
  const code = raw as PublicAbsenceReason;
  if (!publicReasonsFor(scope).includes(code)) {
    return { ok: false, error: scope === "staff" ? "«Cierre de la sede» solo aplica a un bloqueo de toda la sede." : "«Vacaciones» solo aplica a un profesional." };
  }
  return { ok: true, value: code };
}

/** What the assistant may say for this choice — the preview shown under the selector. */
export function publicReasonPreview(code: PublicAbsenceReason | null, who: string | null): string {
  const name = who?.trim() || "El profesional";
  switch (code) {
    case "vacation":
      return `«${name} está de vacaciones en esa fecha.»`;
    case "unavailable":
      return who ? `«${name} no está disponible en esa fecha.»` : "«La sede no está disponible en esa fecha.»";
    case "site_closed":
      return "«La sede está cerrada en esa fecha.»";
    default:
      return who ? `«${name} no tiene disponibilidad para ese horario.»` : "«No hay disponibilidad para ese horario.»";
  }
}

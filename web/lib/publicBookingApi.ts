import type { BookingError } from "@worker/scheduling/booking.js";
import type { PublicServiceRow, PublicStaffRow } from "@worker/db/repositories/scheduling/publicCatalog.js";
import { serviceCategory, type ApptCategory } from "@/lib/agendaCategory";

/**
 * The PUBLIC booking API's response vocabulary — one place for the headers, the single
 * generic 404, the Spanish customer-facing errors, and the minimal projections.
 *
 * Nothing in here may name a tenant_id, client_id, contact, conversation, permission,
 * buffer, token or env value: these shapes ARE the public contract, and
 * test/integration/publicBookingRoutes.test.ts asserts it on real responses.
 * Pure (no I/O, no secrets) so it is unit-testable.
 */

/** Sent on every public booking API response. `no-store`: availability and
 * confirmations are per-moment / per-person and must never be cached by a proxy. */
export const PUBLIC_API_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Cache-Control": "private, no-store, max-age=0",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Robots-Tag": "noindex, nofollow",
});

export function publicJson(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...PUBLIC_API_HEADERS, ...extra } });
}

export function publicError(status: number, code: string, message: string, extra: Record<string, string> = {}): Response {
  return publicJson({ error: { code, message } }, status, extra);
}

/**
 * THE generic 404 — byte-identical for an unknown slug, an inactive site, a default
 * client, a disabled module, the global kill switch, and a module disabled mid-flight.
 * Never vary it per reason: the sameness is what prevents enumeration.
 */
export const PUBLIC_NOT_FOUND_MESSAGE = "Esta página de reservas no está disponible.";
export function publicNotFound(): Response {
  return publicError(404, "not_found", PUBLIC_NOT_FOUND_MESSAGE);
}

export function publicRateLimited(retryAfterSec?: number): Response {
  return publicError(
    429,
    "rate_limited",
    "Hiciste demasiados intentos seguidos. Espera unos minutos y vuelve a intentarlo.",
    retryAfterSec ? { "Retry-After": String(retryAfterSec) } : {},
  );
}

export function publicInvalid(message = "Revisa los datos e inténtalo de nuevo."): Response {
  return publicError(422, "invalid_body", message);
}

/**
 * Booking-engine error → the customer's response. `module_disabled` is NOT here: the
 * route collapses it to publicNotFound() (a concurrent disable must look like any
 * other unavailable page, never a 403 that proves the site existed).
 */
const ENGINE_ERRORS: Partial<Record<BookingError, { status: number; code: string; message: string }>> = {
  conflict_slot: {
    status: 409,
    code: "slot_taken",
    message: "Ese horario se acaba de ocupar. Elige otra hora; ya actualizamos la disponibilidad.",
  },
  unavailable: {
    status: 409,
    code: "slot_taken",
    message: "Ese horario ya no está disponible. Elige otra hora; ya actualizamos la disponibilidad.",
  },
  no_staff: {
    status: 409,
    code: "staff_unavailable",
    message: "Ese profesional no está disponible a esa hora. Elige otra hora u otro profesional.",
  },
  conflict_idempotency: {
    status: 409,
    code: "duplicate_request",
    message: "Esta solicitud ya se usó para otra reserva. Recarga la página y vuelve a intentarlo.",
  },
  not_found: {
    status: 409,
    code: "service_unavailable",
    message: "Este servicio ya no está disponible en esta sede. Elige otro servicio.",
  },
  invalid_phone: {
    status: 422,
    code: "invalid_phone",
    message: "No pudimos leer el teléfono. Escríbelo con el indicativo del país, por ejemplo +57 300 123 4567.",
  },
  active_limit: {
    status: 409,
    code: "active_limit",
    message: "Este número ya tiene el máximo de citas próximas en esta sede. Si necesitas otra, comunícate con la sede.",
  },
};

export function publicEngineError(error: BookingError): Response {
  const e = ENGINE_ERRORS[error];
  // Anything unexpected becomes a generic, safe message — never the engine's English text.
  return e ? publicError(e.status, e.code, e.message) : publicError(400, "booking_failed", "No pudimos completar la reserva. Inténtalo de nuevo.");
}

// ── Projections ─────────────────────────────────────────────────────────────────

type WeeklyHours = Partial<Record<string, Array<{ start: string; end: string }>>>;
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

export interface PublicSite {
  name: string;
  address: string | null;
  timezone: string;
  /** Weekdays the site never opens ("sun"…"sat"). Empty when no hours are configured
   * (unknown is treated as open, exactly like the internal agenda). */
  closed_weekdays: string[];
}

export function projectPublicSite(site: { name: string; address: string | null; timezone: string; opening_hours: unknown }): PublicSite {
  const hours = (site.opening_hours && typeof site.opening_hours === "object" ? site.opening_hours : {}) as WeeklyHours;
  const configured = Object.values(hours).some((ranges) => Array.isArray(ranges) && ranges.length > 0);
  return {
    name: site.name,
    address: site.address,
    timezone: site.timezone,
    closed_weekdays: configured ? WEEKDAYS.filter((d) => !(hours[d]?.length)) : [],
  };
}

export interface PublicService {
  id: string;
  name: string;
  description: string | null;
  duration_min: number;
  price: string | null;
  /** The agenda colour family — decoration only. */
  family: ApptCategory;
}

export function projectPublicService(s: PublicServiceRow): PublicService {
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    duration_min: s.duration_min,
    price: s.price,
    family: serviceCategory(s.name, s.category),
  };
}

export interface PublicStaff {
  id: string;
  name: string;
  duration_min: number;
  price: string | null;
}

export function projectPublicStaff(s: PublicStaffRow): PublicStaff {
  return { id: s.id, name: s.name, duration_min: s.duration_min, price: s.price };
}

export interface PublicSlot {
  start_at: string;
  service_end_at: string;
  /** The professional the engine would assign for "Cualquier profesional". */
  staff_id: string;
  /** Every public professional free at this start. */
  available_staff_ids: string[];
}

/**
 * Engine slots → public slots, restricted to the professionals the page may show (an
 * inactive / no-chair one never appears even if the data still qualifies them). A slot
 * left with nobody is dropped.
 */
export function projectPublicSlots(
  slots: Array<{ start_at: Date; service_end_at: Date; staff_id: string; available_staff_ids: string[] }>,
  publicStaffIds: ReadonlySet<string>,
): PublicSlot[] {
  const out: PublicSlot[] = [];
  for (const s of slots) {
    const ids = s.available_staff_ids.filter((id) => publicStaffIds.has(id));
    if (ids.length === 0) continue;
    out.push({
      start_at: s.start_at.toISOString(),
      service_end_at: s.service_end_at.toISOString(),
      staff_id: publicStaffIds.has(s.staff_id) ? s.staff_id : ids[0],
      available_staff_ids: ids,
    });
  }
  return out;
}

export interface PublicConfirmation {
  /** The appointment's public_reference — a random UUID, never the row id. */
  reference: string;
  site: string;
  address: string | null;
  service: string;
  staff_name: string | null;
  start_at: string;
  service_end_at: string;
  duration_min: number;
  price: string | null;
  timezone: string;
}

export function projectPublicConfirmation(
  appt: {
    public_reference: string;
    service_name_snapshot: string;
    start_at: Date;
    service_end_at: Date;
    duration_min_snapshot: number;
    price_snapshot: string | null;
  },
  site: { name: string; address: string | null; timezone: string },
  staffName: string | null,
): PublicConfirmation {
  return {
    reference: appt.public_reference,
    site: site.name,
    address: site.address,
    service: appt.service_name_snapshot,
    staff_name: staffName,
    start_at: appt.start_at.toISOString(),
    service_end_at: appt.service_end_at.toISOString(),
    duration_min: appt.duration_min_snapshot,
    price: appt.price_snapshot,
    timezone: site.timezone,
  };
}

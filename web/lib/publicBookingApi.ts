import type { BookingError } from "@worker/scheduling/booking.js";
import type { PublicCategoryRow, PublicServiceRow, PublicStaffRow } from "@worker/db/repositories/scheduling/publicCatalog.js";
import type { PublicReviewRow, PublicSiteReviewRow, RatingSummary } from "@worker/db/repositories/scheduling/reviews.js";
import { serviceCategory, type ApptCategory } from "@/lib/agendaCategory";
import { directionsUrl, E164_RE, hoursLines, type CategoryLayout } from "@/lib/bookingPage";
import type { PromotionRow } from "@worker/db/repositories/scheduling/promotions.js";
import { appointmentRuleText, BENEFIT_LABEL } from "@worker/scheduling/promotions.js";

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

/**
 * The price changed between what the visitor saw and the commit: nothing was booked. The
 * response carries the CURRENT price so the page can show it and ask for acceptance —
 * it is the same public price the catalogue already shows, nothing internal.
 */
export function publicPriceChanged(price: string | null): Response {
  return publicJson(
    {
      error: {
        code: "price_changed",
        message: "El precio cambió mientras reservabas. Revisa el nuevo precio y confirma de nuevo.",
        price,
      },
    },
    409,
  );
}

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
  /** How many days ahead the site takes bookings — the calendar greys out the days past
   * it. A published booking rule, not an internal setting; the ENGINE still enforces it. */
  booking_horizon_days: number;
  /** The business's public WhatsApp (E.164) — null when not configured or malformed. */
  whatsapp: string | null;
  /** "Cómo llegar": the business's own Google Maps link, else a search for the address. */
  directions_url: string | null;
  /** Weekly hours as readable lines; empty when the site has none configured. */
  hours: Array<{ days: string; hours: string }>;
}

/** The engine's default horizon (src/scheduling/types.ts) when a site never set one. */
const DEFAULT_HORIZON_DAYS = 30;

export function projectPublicSite(site: {
  name: string;
  address: string | null;
  timezone: string;
  opening_hours: unknown;
  scheduling_config?: unknown;
  public_whatsapp?: string | null;
  public_maps_url?: string | null;
}): PublicSite {
  const hours = (site.opening_hours && typeof site.opening_hours === "object" ? site.opening_hours : {}) as WeeklyHours;
  const configured = Object.values(hours).some((ranges) => Array.isArray(ranges) && ranges.length > 0);
  const cfg = (site.scheduling_config && typeof site.scheduling_config === "object" ? site.scheduling_config : {}) as { booking_horizon_days?: unknown };
  const horizon = Number(cfg.booking_horizon_days);
  return {
    name: site.name,
    address: site.address,
    timezone: site.timezone,
    closed_weekdays: configured ? WEEKDAYS.filter((d) => !(hours[d]?.length)) : [],
    booking_horizon_days: Number.isInteger(horizon) && horizon > 0 && horizon <= 366 ? horizon : DEFAULT_HORIZON_DAYS,
    whatsapp: site.public_whatsapp && E164_RE.test(site.public_whatsapp) ? site.public_whatsapp : null,
    directions_url: directionsUrl(site),
    hours: hoursLines(site.opening_hours),
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
  /** APPROVED reviews only (migration 1801); null = no reviews yet. */
  rating: RatingSummary | null;
  /** Latest approved reviews of THIS service (≤ 3), newest first. */
  reviews: PublicReview[];
  /** Booking-page presentation (migration 1804). */
  category_id: string | null;
  recommended: boolean;
  image_url: string | null;
  includes: string[];
  /** Its explicit better alternative (a service id of this same list, or null). */
  upgrade_to: string | null;
}

export function projectPublicService(
  s: PublicServiceRow,
  ratings?: ReadonlyMap<string, RatingSummary>,
  reviews?: readonly PublicSiteReviewRow[],
): PublicService {
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    duration_min: s.duration_min,
    price: s.price,
    family: serviceCategory(s.name, s.category),
    rating: ratings?.get(s.id) ?? null,
    reviews: (reviews ?? []).filter((r) => r.service_id === s.id).map(projectPublicReview),
    category_id: s.public_category_id ?? null,
    recommended: Boolean(s.public_recommended),
    image_url: httpsOrNull(s.public_image_url ?? null),
    includes: (s.public_includes ?? []).filter((x) => typeof x === "string" && x.trim() !== ""),
    upgrade_to: s.public_upgrade_service_id ?? null,
  };
}

export interface PublicCategory {
  id: string;
  name: string;
  tagline: string | null;
  layout: CategoryLayout;
}

export function projectPublicCategory(c: PublicCategoryRow): PublicCategory {
  return { id: c.id, name: c.name, tagline: c.tagline, layout: c.layout };
}

/** One APPROVED review as a visitor sees it: author is "Nombre I.", never a contact field. */
export interface PublicReview {
  author: string;
  service: string;
  rating: number;
  comment: string | null;
  submitted_at: string;
}

export function projectPublicReview(r: Pick<PublicReviewRow, "author_display" | "service_name" | "rating" | "comment" | "submitted_at">): PublicReview {
  return { author: r.author_display, service: r.service_name, rating: r.rating, comment: r.comment, submitted_at: r.submitted_at.toISOString() };
}

export interface PublicStaff {
  id: string;
  name: string;
  duration_min: number;
  price: string | null;
  /** The professional's PUBLIC profile — null when the business has not published it. */
  title: string | null;
  bio: string | null;
  photo_url: string | null;
  /** Public services this professional performs at the site (ids of the catalogue). */
  service_ids: string[];
  /** APPROVED reviews only; null = none yet. */
  rating: RatingSummary | null;
  /** The latest approved reviews (≤ 10), newest first. */
  reviews: PublicReview[];
}

/** An https URL or nothing — a malformed or non-https value never reaches an <img>. */
function httpsOrNull(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

export function projectPublicStaff(
  s: PublicStaffRow,
  extra: { ratings?: ReadonlyMap<string, RatingSummary>; reviews?: readonly PublicReviewRow[] } = {},
): PublicStaff {
  return {
    id: s.id,
    name: s.name,
    duration_min: s.duration_min,
    price: s.price,
    title: s.public_title,
    bio: s.public_bio,
    photo_url: httpsOrNull(s.public_photo_url),
    service_ids: s.service_ids ?? [],
    rating: extra.ratings?.get(s.id) ?? null,
    reviews: (extra.reviews ?? []).filter((r) => r.staff_id === s.id).map(projectPublicReview),
  };
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

/** A promotion as the PUBLIC page may show it (published and on offer — the repository
 *  already filtered it). No status, version, staff ids or internal dates leave here. */
export interface PublicPromotion {
  id: string;
  name: string;
  description: string | null;
  conditions: string | null;
  image_url: string | null;
  benefit_label: string;
  rule_text: string | null;
  service_ids: string[];
}

export function projectPublicPromotion(p: PromotionRow): PublicPromotion {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    conditions: p.conditions,
    image_url: httpsOrNull(p.image_url),
    benefit_label: BENEFIT_LABEL[p.benefit_type],
    rule_text: appointmentRuleText(p),
    service_ids: p.service_ids,
  };
}

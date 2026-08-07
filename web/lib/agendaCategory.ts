/**
 * Appointment CATEGORY — the single place that decides which colour family an
 * agenda card wears.
 *
 * The palettes themselves live in globals.css (`.u-appt-*`, one class per
 * family); this module only maps an appointment onto a family name. Nothing here
 * emits a colour, so re-tinting the agenda is a CSS change, not a code change.
 *
 * STATE OUTRANKS SERVICE. A card that needs attention (an overlap, a no-show) is
 * red whatever the service is; an unconfirmed one is an outline; a cancelled one
 * is struck out and grey. Only when a card is in a normal state does the SERVICE
 * choose the family.
 *
 * TODO(agenda): services have no `category` column, so the family is inferred
 *   from the service NAME by keyword (bilingual EN/ES — the demo data is Spanish).
 *   A service whose name matches nothing falls back to the neutral CUT family.
 *   Add `services.category` (colour | grooming | cut | feature) and read it here;
 *   the keyword table then becomes the migration's backfill rule.
 * TODO(agenda): there is no `payment_due` / balance on an appointment, so the
 *   DANGER family is currently driven only by overlap + no-show. Wire the unpaid
 *   state in here once the model carries one.
 */

export type ApptCategory =
  | "color"
  | "grooming"
  | "cut"
  | "feature"
  | "danger"
  | "unassigned"
  | "tentative"
  | "cancelled";

/** The palette class for a family — see the `.u-appt-*` block in globals.css. */
const CATEGORY_CLASS: Record<ApptCategory, string> = {
  color: "u-appt-color",
  grooming: "u-appt-grooming",
  cut: "u-appt-cut",
  feature: "u-appt-feature",
  danger: "u-appt-danger",
  unassigned: "u-appt-unassigned",
  tentative: "u-appt-tentative",
  cancelled: "u-appt-cancelled",
};

export function apptCategoryClass(category: ApptCategory): string {
  return CATEGORY_CLASS[category];
}

/**
 * Service-name keywords, most specific FIRST — "keratin package" must land on
 * `feature` before "package"/"colour" can claim it. Accent-insensitive: the input
 * is normalised (NFD, marks stripped) so "queratina" and "coloración" both match.
 */
const SERVICE_KEYWORDS: Array<{ category: ApptCategory; words: string[] }> = [
  // FEATURE — the solid, high-emphasis block. Deliberately a SHORT list: it is
  // the premium treatment, not "anything sold as a package".
  { category: "feature", words: ["keratin", "queratina", "botox", "alisado", "premium", "transformation"] },
  {
    category: "color",
    words: ["colour", "color", "highlight", "mecha", "balayage", "tinte", "gloss", "toner", "bleach", "decolor"],
  },
  {
    category: "grooming",
    words: ["beard", "barba", "shave", "afeitad", "grooming", "moustache", "mustache", "bigote", "sculpt", "brow", "ceja"],
  },
  { category: "cut", words: ["cut", "corte", "fade", "trim", "haircut", "buzz", "kids", "nino", "peinado", "styling"] },
];

function normalise(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/** The family a SERVICE belongs to, ignoring appointment state. */
export function serviceCategory(serviceName: string): ApptCategory {
  const name = normalise(serviceName);
  for (const { category, words } of SERVICE_KEYWORDS) {
    if (words.some((w) => name.includes(w))) return category;
  }
  // Neutral fallback — never an unstyled card. See the TODO at the top.
  return "cut";
}

/**
 * The family an APPOINTMENT card wears. `attention` is the caller's derived
 * conflict flag (same barber, overlapping windows) — it is computed over the
 * whole range in the view, not per card, so it is passed in rather than sniffed.
 */
export function apptCategory(
  appt: { service_name: string; status: string; staff_name: string | null; origin: string },
  opts: { attention: boolean },
): ApptCategory {
  if (appt.status === "cancelled") return "cancelled";
  if (opts.attention || appt.status === "no_show") return "danger";
  // A walk-in nobody has picked up. staff_id is NOT NULL today so this cannot
  // occur yet (see the TODO on AgendaView) — the branch exists so the state
  // renders correctly the day an unassigned queue lands, instead of silently
  // looking like a normal booking.
  if (appt.origin === "walk_in" && !appt.staff_name) return "unassigned";
  if (appt.status === "scheduled") return "tentative";
  return serviceCategory(appt.service_name);
}

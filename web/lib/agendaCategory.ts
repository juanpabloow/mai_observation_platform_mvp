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
 * WHERE THE FAMILY COMES FROM, in order:
 *   1. `services.category` — what the operator actually chose. Authoritative.
 *   2. Keywords in the service NAME — the FALLBACK, for rows where nobody has set a
 *      category yet (bilingual EN/ES; the demo data is Spanish). Still guessing, but
 *      only for services that never got classified, and it is now correctable in one
 *      place instead of being the only mechanism.
 *   3. The neutral CUT family, so a card is never unstyled.
 *
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
 * The families a SERVICE can be stored as (services.category, CHECK-constrained).
 * The state families (danger/tentative/cancelled/unassigned) are deliberately NOT
 * storable: they describe an appointment, not a service.
 */
const STORABLE: readonly ApptCategory[] = ["color", "grooming", "cut", "feature"];

/** Narrow the raw column value; anything unexpected is treated as "not set". */
function fromColumn(category: string | null | undefined): ApptCategory | null {
  return category && (STORABLE as readonly string[]).includes(category) ? (category as ApptCategory) : null;
}

/**
 * Service-name keywords, most specific FIRST — "keratin package" must land on
 * `feature` before "package"/"colour" can claim it. Accent-insensitive: the input
 * is normalised (NFD, marks stripped) so "queratina" and "coloración" both match.
 *
 * This is now the FALLBACK only. It is also the classification rule the optional
 * backfill script applies (src/scripts/backfillServiceCategory.ts), so a shop that
 * runs it gets exactly today's colours, stored and editable.
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

/**
 * The family a SERVICE belongs to, ignoring appointment state.
 * `category` is the stored `services.category`; pass it whenever the caller has it.
 */
export function serviceCategory(serviceName: string, category?: string | null): ApptCategory {
  const stored = fromColumn(category);
  if (stored) return stored; // the operator's choice wins
  const name = normalise(serviceName);
  for (const { category: guess, words } of SERVICE_KEYWORDS) {
    if (words.some((w) => name.includes(w))) return guess;
  }
  // Neutral fallback — never an unstyled card.
  return "cut";
}

/**
 * The family an APPOINTMENT card wears. `attention` is the caller's derived
 * conflict flag (same barber, overlapping windows) — it is computed over the
 * whole range in the view, not per card, so it is passed in rather than sniffed.
 */
export function apptCategory(
  appt: {
    service_name: string;
    /** `services.category` for this appointment's service, when the service still
     *  exists. NULL/absent → the name-keyword fallback. The appointment itself keeps
     *  only a NAME snapshot, so a deleted service correctly falls back rather than
     *  rewriting history with a category it never had. */
    service_category?: string | null;
    status: string;
    staff_name: string | null;
    origin: string;
  },
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
  return serviceCategory(appt.service_name, appt.service_category);
}

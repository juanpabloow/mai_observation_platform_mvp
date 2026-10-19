/**
 * Server-side validation for a CAMPAIGN — pure functions so each rule is testable on its
 * own and the campaigns actions can't drift from the DB CHECKs (migration 1808). Mirrors
 * the catalog validators' shape (`FieldResult<T>`): blank/whitespace optional fields fold
 * to NULL; over-length is rejected naming the field.
 *
 * The brief (`bot_brief`) is what the assistant reads when someone writes from an ad of this
 * campaign (AT-3). DB CHECK: ≤1500 chars and, when present, non-blank.
 */

export const CAMPAIGN_NAME_MAX = 200;
export const CAMPAIGN_BRIEF_MAX = 1500;
export const EXTERNAL_CAMPAIGN_ID_MAX = 200;
export const AD_NAME_MAX = 200;
export const AD_NOTE_MAX = 500;
export const META_AD_ID_MAX = 200;

export type FieldResult<T> = { ok: true; value: T } | { ok: false; error: string };

export type CampaignStatusValue = "active" | "paused" | "ended";

/** name: required, trimmed, non-blank, ≤200 chars. */
export function normalizeCampaignName(raw: string | null | undefined): FieldResult<string> {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return { ok: false, error: "name: a campaign name is required." };
  if (trimmed.length > CAMPAIGN_NAME_MAX) {
    return { ok: false, error: `name: must be ${CAMPAIGN_NAME_MAX} characters or fewer.` };
  }
  return { ok: true, value: trimmed };
}

/** bot_brief: optional; blank/whitespace → NULL; ≤1500 chars; else rejected. */
export function normalizeCampaignBrief(raw: string | null | undefined): FieldResult<string | null> {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, value: null };
  if (trimmed.length > CAMPAIGN_BRIEF_MAX) {
    return { ok: false, error: `brief: must be ${CAMPAIGN_BRIEF_MAX} characters or fewer.` };
  }
  return { ok: true, value: trimmed };
}

/** external_campaign_id (the Meta campaign id): optional; blank → NULL; ≤200 chars. */
export function normalizeExternalCampaignId(raw: string | null | undefined): FieldResult<string | null> {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, value: null };
  if (trimmed.length > EXTERNAL_CAMPAIGN_ID_MAX) {
    return { ok: false, error: `external_campaign_id: must be ${EXTERNAL_CAMPAIGN_ID_MAX} characters or fewer.` };
  }
  return { ok: true, value: trimmed };
}

/** status: one of active | paused | ended. */
export function normalizeCampaignStatus(raw: string | null | undefined): FieldResult<CampaignStatusValue> {
  if (raw === "active" || raw === "paused" || raw === "ended") return { ok: true, value: raw };
  return { ok: false, error: "status: must be active, paused or ended." };
}

/** date: optional; blank → NULL; otherwise a YYYY-MM-DD calendar date. */
export function normalizeCampaignDate(raw: string | null | undefined): FieldResult<string | null> {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, value: null };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return { ok: false, error: "date: use YYYY-MM-DD." };
  const d = new Date(`${trimmed}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return { ok: false, error: "date: not a real date." };
  return { ok: true, value: trimmed };
}

/** end_date must not precede start_date (mirrors campaigns_date_range CHECK). */
export function validateDateRange(start: string | null, end: string | null): FieldResult<true> {
  if (start && end && end < start) return { ok: false, error: "La fecha de fin no puede ser anterior a la de inicio." };
  return { ok: true, value: true };
}

// ── AT-2b: per-ad name + note, and pre-register by Meta id ───────────────────────────

/** ad name: optional; blank → NULL; ≤200 chars (mirrors the ads.name CHECK). */
export function normalizeAdName(raw: string | null | undefined): FieldResult<string | null> {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, value: null };
  if (trimmed.length > AD_NAME_MAX) return { ok: false, error: `name: must be ${AD_NAME_MAX} characters or fewer.` };
  return { ok: true, value: trimmed };
}

/** ad bot_note: optional; blank → NULL; ≤500 chars (mirrors the ads.bot_note CHECK). */
export function normalizeAdNote(raw: string | null | undefined): FieldResult<string | null> {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, value: null };
  if (trimmed.length > AD_NOTE_MAX) return { ok: false, error: `note: must be ${AD_NOTE_MAX} characters or fewer.` };
  return { ok: true, value: trimmed };
}

/** Meta ad id for pre-register: required, DIGITS ONLY, ≤200 (the referral_source_id shape). */
export function normalizeMetaAdId(raw: string | null | undefined): FieldResult<string> {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return { ok: false, error: "id: el id del anuncio de Meta es obligatorio." };
  if (trimmed.length > META_AD_ID_MAX || !/^\d+$/.test(trimmed)) {
    return { ok: false, error: "id: debe ser solo dígitos (el id del anuncio en Meta)." };
  }
  return { ok: true, value: trimmed };
}

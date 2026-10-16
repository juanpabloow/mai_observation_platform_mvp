/**
 * Best-effort phone normalization to E.164 (matches the contacts.phone_e164 CHECK
 * `^\+[1-9][0-9]{6,14}$`). Returns null when the input can't be confidently
 * normalized (rather than storing a malformed number).
 *
 * DEFAULT behaviour (no `defaultRegion`): a leading '+' is trusted; a bare digit string is
 * assumed to ALREADY carry its country code (the WhatsApp `wa_id` form, e.g.
 * "573001112233"). This is unchanged from the original, so every stored identity keeps
 * normalizing to itself — do NOT alter it.
 *
 * REGION-AWARE (with `defaultRegion`, used only where a HUMAN may type a LOCAL number —
 * e.g. a customer giving a relative's number in chat): a number with no '+' whose length
 * matches the region's national format gets the region's country code prepended; a number
 * that already carries the code (or a '+') is left as-is; anything else is REJECTED (null)
 * so the caller can ask for the number with its country code rather than guess a wrong one.
 */

/** A dialing region: the country code to prepend and the local national-number length. */
export interface DialingRegion {
  /** Country calling code, digits only, no '+'. Colombia = "57". */
  countryCode: string;
  /** Length of a LOCAL national number (Colombia mobile = 10, e.g. 3058830676). */
  nationalLength: number;
}

/**
 * The dialing region for a site, DERIVED from its IANA timezone — so the default country
 * code is not a second thing an operator can set inconsistently with the timezone, and it
 * needs no column, no migration and no form field. Curated per market the platform serves;
 * an unmapped timezone returns null, and a local number there is REJECTED (asked to include
 * the country code) rather than guessed. Extend this map when onboarding a new country.
 */
const DIALING_REGIONS: Record<string, DialingRegion> = {
  'America/Bogota': { countryCode: '57', nationalLength: 10 }, // Colombia
};

export function dialingRegionForTimezone(tz: string | null | undefined): DialingRegion | null {
  if (!tz) return null;
  return DIALING_REGIONS[tz] ?? null;
}

function validE164(candidate: string): string | null {
  return /^\+[1-9][0-9]{6,14}$/.test(candidate) ? candidate : null;
}

/**
 * A WhatsApp business-scoped user id (BSUID): an ISO country code, then one or more
 * dot-separated opaque alphanumeric segments. Two shapes Meta issues:
 *   - direct:            "CO.1234567890"            (CC.<id>)
 *   - managed portfolio: "US.ENT.11815799212886844830"  (CC.ENT.<id>, extra segment)
 * The rule below accepts BOTH (and any future CC.<seg>.<seg>… form). A BSUID is a TRANSPORT
 * id, NEVER a phone. Deliberately narrow — other refs that merely contain letters
 * ("wa:573001112233", the documented n8n form) keep normalizing by their digits exactly as
 * before. Mirrored in SQL by BSUID_SQL_RE (contactIdentities.ts). Length-capped so a
 * pathological value can't be scanned forever.
 *
 * INVARIANT (regression guard for the class fixed by 1444d5a, now extended to the ENT
 * variant): any value matching this shape returns null from normalizeE164 BEFORE any digit
 * logic, so it can never be turned into an invented phone.
 */
const BSUID_MAX_LENGTH = 128;
const BSUID_SHAPE = /^[A-Za-z]{2}(?:\.[A-Za-z0-9]+)+$/;
export function isBsuid(value: string | null | undefined): boolean {
  const trimmed = (value ?? '').trim();
  return trimmed.length <= BSUID_MAX_LENGTH && BSUID_SHAPE.test(trimmed);
}

export function normalizeE164(
  input: string | null | undefined,
  opts?: { defaultRegion?: DialingRegion | null },
): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  // A BSUID ("CO.1234567890") is never a phone. Its letters used to be stripped and the
  // digits came out as an invented phone ("+1234567890") that could even collide with a
  // real one. It stays an opaque `external` identity (classifyIdentity). Only the BSUID
  // shape is refused: every other input normalizes exactly as before.
  if (isBsuid(trimmed)) return null;
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/[^0-9]/g, '');

  // REGION-AWARE path — only when a region is supplied AND there is no explicit '+'.
  const region = opts?.defaultRegion;
  if (!hasPlus && region) {
    const { countryCode: cc, nationalLength: n } = region;
    // A local national number ("3058830676") → prepend the country code.
    if (digits.length === n && digits[0] !== '0') return validE164(`+${cc}${digits}`);
    // Already carries the country code ("573058830676", the wa_id form) → keep it.
    if (digits.startsWith(cc) && digits.length === cc.length + n) return validE164(`+${digits}`);
    // Any other length matches no known format for this region → reject, don't guess.
    return null;
  }

  // DEFAULT path (unchanged): trust a '+', and treat a bare digit string as already
  // international. No region inference beyond that.
  if (digits.length < 7 || digits.length > 15) return null;
  if (digits[0] === '0') return null; // E.164 has no leading zero after the CC
  void hasPlus;
  return validE164(`+${digits}`);
}

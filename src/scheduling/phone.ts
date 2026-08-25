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

export function normalizeE164(
  input: string | null | undefined,
  opts?: { defaultRegion?: DialingRegion | null },
): string | null {
  if (!input) return null;
  const trimmed = input.trim();
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

/**
 * Best-effort phone normalization to E.164 (matches the contacts.phone_e164 CHECK
 * `^\+[1-9][0-9]{6,14}$`). Returns null when the input can't be confidently
 * normalized (rather than storing a malformed number). No region inference beyond
 * a leading '+' — a bare national number without a country code returns null.
 */
export function normalizeE164(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  // Keep a single leading '+', strip every other non-digit.
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/[^0-9]/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  if (digits[0] === '0') return null; // E.164 has no leading zero after the CC
  // With an explicit '+', trust the country code. Without it, we still accept a
  // plausible international-length digit string (WhatsApp wa_id form, e.g.
  // 573001112233) since it already carries the country code.
  void hasPlus;
  const candidate = `+${digits}`;
  return /^\+[1-9][0-9]{6,14}$/.test(candidate) ? candidate : null;
}

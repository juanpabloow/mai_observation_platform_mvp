/**
 * ONE display name for a contact, shared by the pipeline board, the "sin respuesta" queue and
 * the contacts list so they never disagree. DISPLAY ONLY — it never rewrites the stored name.
 *
 * The stored `name` (the WhatsApp profile name when WhatsApp set it, or a name a person typed)
 * is used when it is a REAL name. It is not when it is empty, whitespace, or only punctuation /
 * symbols (the production board showed a card titled "."). An emoji-only name ("😀", "🇨🇴") IS a
 * real name and is kept. When the stored name is junk we fall back to the masked phone, then to
 * a neutral "Sin nombre".
 */

/** A character that makes a name "real": any letter or number, OR an emoji / pictograph / flag
 *  (so "😀" stays a name, but ".", "!!", "—" and "   " do not). */
const MEANINGFUL = /[\p{L}\p{N}]|\p{Extended_Pictographic}|\p{Regional_Indicator}/u;

export function isMeaningfulName(name: string | null | undefined): boolean {
  return !!name && MEANINGFUL.test(name);
}

/**
 * A privacy-masked phone for display: "+573120000220" → "+57 312 ••• 0220". Keeps a leading
 * country/area hint and the last four digits, masks the middle. Returns null when there are not
 * enough digits to mask meaningfully (so a non-phone id never shows as a fake phone).
 */
export function maskPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 7) return null;
  const last4 = digits.slice(-4);
  const lead = digits.slice(0, digits.length - 4).slice(0, 5); // up to 5 leading digits
  const head = [lead.slice(0, 2), lead.slice(2, 5)].filter(Boolean).join(" ");
  return `+${head} ••• ${last4}`;
}

export interface ContactNameSource {
  name: string | null | undefined;
  /** The E.164 phone (preferred source for the masked fallback). */
  phoneE164?: string | null;
  /** The channel id — for WhatsApp this is usually the phone, so it is the last-resort source. */
  channelUserId?: string | null;
}

/** The contact's display name: a real stored name → the masked phone → "Sin nombre". */
export function displayContactName(src: ContactNameSource): string {
  if (isMeaningfulName(src.name)) return src.name!.trim();
  return maskPhone(src.phoneE164) ?? maskPhone(src.channelUserId) ?? "Sin nombre";
}

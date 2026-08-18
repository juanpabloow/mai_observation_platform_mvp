/**
 * Deterministic avatar colour for a contact.
 *
 * The disc's tone is derived from the contact's own identifier, so the SAME person
 * is the same colour everywhere — the queue row and the thread bubbles — and the
 * colour survives reloads, re-sorts and re-renders without anything being stored.
 * Nothing here emits a hex: the palette lives in globals.css as `.u-avatar-1…8`
 * (eight tones, each an accessible fill for white text in both themes), and this
 * only picks one.
 *
 * The hash is FNV-1a — tiny, dependency-free, and well spread over short strings
 * like "+57 318 598 0405", where the last digits are all that vary. A cheaper
 * charCode sum would put most of a shop's numbers on the same two colours.
 *
 * NOTE: colour is DECORATION here, never meaning. The row's state is carried by its
 * lane, its fill and its text — the disc only helps you re-find a person in a list.
 */

/** Number of tones in the palette (see `.u-avatar-*` in globals.css). */
export const AVATAR_TONE_COUNT = 8;

/**
 * The palette class for an id. Stable for the lifetime of that identifier.
 *
 * The input is NORMALISED first (lowercased, non-alphanumerics dropped) so the same
 * person hashes the same from every surface: the queue holds the raw channel id
 * ("573185980405"), the customer panel holds the formatted identity
 * ("+57 318 598 0405"), and both must land on one colour.
 */
export function avatarColor(id: string): string {
  return `u-avatar-${avatarToneIndex(id)}`;
}

/** The 1-based tone index for an id. Both the disc class and the tone variable derive
 *  from THIS, so a header tint can never disagree with the avatar beside it. */
export function avatarToneIndex(id: string): number {
  const key = id.toLowerCase().replace(/[^a-z0-9]/g, "");
  let h = 2166136261; // FNV-1a offset basis
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // >>> 0 makes the 32-bit hash unsigned before the modulo, so the index can never
  // come out negative (Math.imul returns a SIGNED int32).
  return ((h >>> 0) % AVATAR_TONE_COUNT) + 1;
}

/**
 * The tone as a CSS variable reference, for anything that needs the COLOUR rather than
 * the disc — e.g. the contact panel's header wash. Returning the var (not a hex) is
 * what keeps the eight tones defined in exactly one place, globals.css.
 */
export function avatarToneVar(id: string): string {
  return `var(--avatar-${avatarToneIndex(id)})`;
}

/**
 * The two-letter disc label for a STAFF name — first initial of the first two words.
 *
 * It lives beside `avatarColor` because the two are always spent together: a second
 * implementation somewhere else is how the same person ends up as "TS" on one surface and
 * "T1" on another. (Contacts has its own rule — `initialsFor` in lib/contactForm — because
 * a contact may have no name at all and falls back to a phone number.)
 */
export function staffInitials(name: string): string {
  const w = name.trim().split(/\s+/).filter(Boolean);
  return w.length === 0 ? "?" : w.slice(0, 2).map((x) => x[0]).join("").toUpperCase();
}

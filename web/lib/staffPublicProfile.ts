/**
 * STAFF PUBLIC PROFILE — the rules for what a business may publish about a professional
 * on its booking page (/book/{slug}): a short title and a presentation. Pure and
 * dependency-free, so the Team editor (desktop and phone), the server action and the
 * tests share one definition. The database CHECKs (migration 1800) repeat the length
 * limits; this layer adds the CONTENT rules a CHECK cannot say well.
 *
 * Content rules, and why:
 *  - Plain text only. Control characters are refused; line breaks are kept (at most one
 *    blank line in a row) so a presentation can have two short paragraphs.
 *  - No links, e-mail addresses or phone numbers. The page is public and anonymous:
 *    a presentation is not the place to publish an employee's contact details, and a
 *    link there would turn the booking page into a referral surface.
 */

export const PUBLIC_TITLE_MAX = 60;
export const PUBLIC_BIO_MAX = 600;

export type PublicProfileError = "too_long" | "control_chars" | "contact_or_link";

export type PublicTextResult = { ok: true; value: string | null } | { ok: false; error: PublicProfileError; max: number };

// Control characters except TAB (\t) and LF (\n), which are normalised below.
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u2028\u2029]/;
const LINK = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|co|net|org|io|app|me|link|ly)(\/|\b))/i;
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
/** Seven or more digits once spaces, dots, dashes and brackets are ignored. */
const PHONE = /(?:\+?\d[\s().-]*){7,}/;

function normalise(raw: string, multiline: boolean): string {
  let s = raw.replace(/\r\n?/g, "\n").replace(/\t/g, " ");
  if (!multiline) s = s.replace(/\n+/g, " ");
  s = s
    .split("\n")
    .map((line) => line.replace(/ {2,}/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

function check(raw: string | null | undefined, max: number, multiline: boolean): PublicTextResult {
  if (raw == null) return { ok: true, value: null };
  if (CONTROL.test(raw.replace(/[\r\n\t]/g, ""))) return { ok: false, error: "control_chars", max };
  const value = normalise(raw, multiline);
  if (value === "") return { ok: true, value: null };
  if (value.length > max) return { ok: false, error: "too_long", max };
  if (LINK.test(value) || EMAIL.test(value) || PHONE.test(value)) return { ok: false, error: "contact_or_link", max };
  return { ok: true, value };
}

/** The same content rules for any short public line of the booking page (a category name,
 * a tagline, one "Qué incluye" item). "" / whitespace → null. */
export function checkPublicLine(raw: string | null | undefined, max: number): PublicTextResult {
  return check(raw, max, false);
}

/** "" / whitespace → null (not published). */
export function checkPublicTitle(raw: string | null | undefined): PublicTextResult {
  return check(raw, PUBLIC_TITLE_MAX, false);
}

/** "" / whitespace → null (not published). */
export function checkPublicBio(raw: string | null | undefined): PublicTextResult {
  return check(raw, PUBLIC_BIO_MAX, true);
}

const MESSAGES: Record<"es" | "en", Record<PublicProfileError, (field: string, max: number) => string>> = {
  es: {
    too_long: (field, max) => `${field}: máximo ${max} caracteres.`,
    control_chars: (field) => `${field}: contiene caracteres no válidos.`,
    contact_or_link: (field) => `${field}: no incluyas enlaces, correos ni teléfonos; esta información es pública.`,
  },
  en: {
    too_long: (field, max) => `${field}: at most ${max} characters.`,
    control_chars: (field) => `${field}: contains characters that are not allowed.`,
    contact_or_link: (field) => `${field}: no links, e-mails or phone numbers — this text is public.`,
  },
};

export function publicProfileMessage(error: PublicProfileError, field: string, max: number, lang: "es" | "en" = "es"): string {
  return MESSAGES[lang][error](field, max);
}

/** First sentence of a presentation, for the artist card (the full text lives in the profile). */
export function bioLead(bio: string | null | undefined): string | null {
  const t = (bio ?? "").trim();
  if (!t) return null;
  const m = /^([\s\S]+?[.!?])(\s|$)/.exec(t);
  return (m ? m[1] : t).replace(/\s+/g, " ");
}

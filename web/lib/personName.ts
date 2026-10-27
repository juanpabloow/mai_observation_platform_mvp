/**
 * The person's name: ONE free field. Names are not validated against a shape — no "two
 * words", no ASCII-only, no letter whitelist (Ñ, tildes, apostrophes, hyphens, one-word
 * names, non-Latin scripts are all real). We only normalize whitespace and Unicode form and
 * refuse what is never a name: empty, control characters, absurd length.
 */
export const NAME_MAX = 120;

export type NameResult = { ok: true; name: string } | { ok: false; error: string };

export function normalizePersonName(raw: unknown): NameResult {
  const value = typeof raw === "string" ? raw.normalize("NFC").replace(/\s+/g, " ").trim() : "";
  if (!value) return { ok: false, error: "Escribe tu nombre." };
  if (/[\u0000-\u001f\u007f-\u009f\u200b\u200e\u200f\u2028-\u202e\u2066-\u2069]/.test(value)) {
    return { ok: false, error: "El nombre tiene caracteres que no se pueden usar." };
  }
  if ([...value].length > NAME_MAX) return { ok: false, error: `Usa como máximo ${NAME_MAX} caracteres.` };
  return { ok: true, name: value };
}

/** Up to two initials for the avatar fallback ("Valentina Ríos" → "VR", "Ana" → "A"). */
export function initialsOf(name: string | null | undefined): string {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  return words
    .slice(0, 2)
    .map((w) => [...w][0]!.toLocaleUpperCase("es"))
    .join("");
}

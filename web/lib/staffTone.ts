/**
 * The pastel identity tone of a professional — `.u-appt-staff-*` in globals.css (the
 * agenda's professional palette). Deterministic from the staff id, so the same person
 * wears the same colour on every visit; decoration only, never meaning (the name is
 * always written beside it).
 */
export const STAFF_TONES = ["slate", "lilac", "sage", "sand", "blue"] as const;
export type StaffTone = (typeof STAFF_TONES)[number];

export function staffTone(id: string): StaffTone {
  // FNV-1a — same spread-over-short-strings reasoning as lib/avatarColor.ts.
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return STAFF_TONES[(h >>> 0) % STAFF_TONES.length];
}

export function staffToneClass(id: string): string {
  return `u-appt-staff-${staffTone(id)}`;
}

/** Up to two initials, ignoring a bracketed environment tag ("[DEV] Ana Ruiz" → "AR"). */
export function initialsOf(name: string | null | undefined): string {
  const clean = (name ?? "").replace(/^\s*[[(][^\])]*[\])]\s*/, "").trim();
  const initials = clean
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w.match(/[\p{L}\p{N}]/u)?.[0] ?? "")
    .join("")
    .toLocaleUpperCase("es");
  return initials || "?";
}

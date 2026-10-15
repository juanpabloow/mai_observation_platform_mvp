/**
 * The ficha's form rules (inbox redesign: "Formularios de la ficha"): validated when the
 * field loses focus and again on save, with CONCRETE messages — empty, repeated tag, too
 * long. The limits are the SERVER's (web/lib/crmValidation.ts), so the form can never
 * accept what the action will refuse, nor refuse what it would accept.
 */

export const TAG_NAME_MAX = 60;
export const TASK_TITLE_MAX = 300;
export const NOTE_BODY_MAX = 10_000;

export function validateTaskTitle(raw: string): string | null {
  const v = raw.trim();
  if (!v) return "Escribe el título de la tarea.";
  if (v.length > TASK_TITLE_MAX) return `Máximo ${TASK_TITLE_MAX} caracteres.`;
  return null;
}

export function validateNoteBody(raw: string): string | null {
  const v = raw.trim();
  if (!v) return "Escribe la nota.";
  if (v.length > NOTE_BODY_MAX) return `Máximo ${NOTE_BODY_MAX.toLocaleString("es-CO")} caracteres.`;
  return null;
}

/** `existing` = names already on the contact or in the catalogue (case/accent-insensitive). */
export function validateTagName(raw: string, existing: readonly string[]): string | null {
  const v = raw.trim();
  if (!v) return "Escribe el nombre de la etiqueta.";
  if (v.length > TAG_NAME_MAX) return `Máximo ${TAG_NAME_MAX} caracteres.`;
  const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();
  if (existing.some((n) => fold(n) === fold(v))) return "Esa etiqueta ya existe.";
  return null;
}

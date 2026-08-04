/**
 * Semantic name matching for the machine API — the values an LLM handles reliably (a
 * service or staff NAME) instead of an opaque UUID it can transcribe wrong.
 *
 * `normalizeName` is the name-side sibling of the C-2 identity normalization
 * (classifyIdentity/normalizeE164 in contactIdentities): same principle — compare on the
 * MEANING, not the surface form — but for free-text names, so "Corte de Cabello",
 * "corte de cabello" and "CORTE DE CABELLO" (and accent variants) all collapse to one key.
 */

/** Case-insensitive, accent-insensitive, whitespace-collapsed key for name comparison. */
export function normalizeName(raw: string | null | undefined): string {
  if (raw == null) return '';
  return String(raw)
    .normalize('NFD') // split base char + combining accent
    .replace(/[\u0300-\u036f]/g, '') // drop the combining accents (á→a, é→e, ñ→n)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export interface NamedRow {
  id: string;
  name: string;
}

/** The outcome of resolving a name to an id. NEVER silently picks one of several. */
export type NameMatch =
  | { status: 'ok'; id: string; name: string }
  | { status: 'not_found'; valid: string[] }
  | { status: 'ambiguous'; candidates: NamedRow[] };

function uniqueSortedNames(rows: NamedRow[]): string[] {
  return [...new Set(rows.map((r) => r.name))].sort((a, b) => a.localeCompare(b));
}

/**
 * Resolve a free-text `rawName` against `rows` by normalized equality:
 *   - exactly one match → ok (the id);
 *   - none              → not_found, with the VALID names (so an agent can recover in one turn);
 *   - two or more       → ambiguous, with the candidates (never guess).
 * An empty/blank name is not_found (with the valid list), not an error to swallow.
 */
export function matchByName(rows: NamedRow[], rawName: string | null | undefined): NameMatch {
  const target = normalizeName(rawName);
  if (!target) return { status: 'not_found', valid: uniqueSortedNames(rows) };
  const hits = rows.filter((r) => normalizeName(r.name) === target);
  if (hits.length === 0) return { status: 'not_found', valid: uniqueSortedNames(rows) };
  if (hits.length > 1) return { status: 'ambiguous', candidates: hits.map((r) => ({ id: r.id, name: r.name })) };
  return { status: 'ok', id: hits[0].id, name: hits[0].name };
}

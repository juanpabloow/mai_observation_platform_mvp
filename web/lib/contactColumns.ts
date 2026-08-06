/**
 * The Contacts table column model. PURE (no React, no server imports) so both the
 * server page and the client toolbar agree on exactly which columns exist and
 * which are optional — and so it is unit-testable.
 *
 * The REQUIRED columns are the reference design's spine and are never togglable:
 * NAME · CHANNEL · STAGE · LAST ACTIVITY · NEXT APPT · OPEN TASKS. Everything the
 * Columns menu offers is additive and PRESENTATIONAL ONLY — `?cols=` can change
 * which columns render, never which rows are returned or what a value says.
 */

export const OPTIONAL_COLUMNS = [
  { key: "owner", label: "Owner" },
  { key: "visits", label: "Visits" },
  { key: "consent", label: "Consent" },
  { key: "created", label: "Created" },
] as const;

export type ContactColumnKey = (typeof OPTIONAL_COLUMNS)[number]["key"];

const VALID = new Set<string>(OPTIONAL_COLUMNS.map((c) => c.key));

/**
 * Parse `?cols=owner,visits` into the visible OPTIONAL columns. Unknown keys are
 * dropped and duplicates collapse, so a hand-edited URL can never produce a
 * broken header/row mismatch. Absent param ⇒ no optional columns.
 */
export function parseColumns(raw: string | undefined | null): ContactColumnKey[] {
  if (!raw) return [];
  const seen = new Set<ContactColumnKey>();
  for (const part of raw.split(",")) {
    const key = part.trim();
    if (VALID.has(key)) seen.add(key as ContactColumnKey);
  }
  // Emit in the canonical OPTIONAL_COLUMNS order, not the URL's order, so the
  // header and every row build their cells in the same sequence.
  return OPTIONAL_COLUMNS.filter((c) => seen.has(c.key)).map((c) => c.key);
}

/**
 * The Contacts table column model. PURE (no React, no server imports) so both the
 * server page and the client toolbar agree on exactly which columns exist and
 * which are optional — and so it is unit-testable.
 *
 * The REQUIRED columns are the OPERATIONAL spine — what a shop actually scans a
 * customer list for: NAME · EMAIL · PHONE · LAST VISIT · USUAL BARBER · APPTS. Everything the Columns menu offers is additive and PRESENTATIONAL
 * ONLY — `?cols=` can change which columns render, never which rows are returned or
 * what a value says.
 *
 * Channel, Stage and Next appt used to be part of that spine. They are still here,
 * one toggle away: the CRM-generic view (which channel, which funnel stage) is a
 * different question from the operational one, and only one of them can own the
 * default seven columns.
 */

export const OPTIONAL_COLUMNS = [
  { key: "channel", label: "Canal" },
  { key: "stage", label: "Stage" },
  { key: "owner", label: "Dueño" },
  { key: "nextAppt", label: "Próxima cita" },
  { key: "visits", label: "Visitas" },
  { key: "consent", label: "Consentimiento" },
  { key: "created", label: "Creado" },
  { key: "openTasks", label: "Tareas abiertas" },
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

/**
 * Rows per page on the contacts list.
 *
 * A constant rather than a magic 50 in the page, because the redesign's numbered
 * pagination needs the SAME value in three places — the `limit` on the query, the
 * `offset` arithmetic, and the "Mostrando 1–15 de 312" line. Three copies of a page
 * size is how a footer starts claiming a range the list does not show.
 *
 * 25, down from the old keyset page's 50: the design's rows are 54px (up from 46px) and
 * it paginates by number rather than by "load more", so a page should be about what fits
 * a screen — scrolling past a second screenful only to find a pager is the worst of both
 * models.
 */
export const PAGE_SIZE = 25;

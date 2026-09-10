/**
 * The listing's filter/sort VOCABULARY, in a module with no "use client".
 *
 * These live apart from the toolbar that renders them because both sides need
 * them: the server page validates `?sort=`/`?range=` against these lists before
 * they reach the data layer, and the client popovers render the same options.
 * Exporting them from the `"use client"` toolbar looked fine and typechecked,
 * but across the client boundary a non-component export becomes a client
 * REFERENCE — so `SORTS.map(...)` on the server threw
 * "p.SORTS.map is not a function" at build time. Plain data belongs in a plain
 * module.
 */

export const SORTS = [
  { key: "recent", label: "más recientes" },
  { key: "oldest", label: "más antiguas" },
  { key: "longest", label: "más largas" },
] as const;

export type SortKey = (typeof SORTS)[number]["key"];

export const RANGES = [
  { key: "30d", label: "Últimos 30 días" },
  { key: "90d", label: "Últimos 90 días" },
  { key: "all", label: "Todo el histórico" },
] as const;

export type RangeKey = (typeof RANGES)[number]["key"];

export const SORT_KEYS: ReadonlySet<string> = new Set(SORTS.map((s) => s.key));
export const RANGE_KEYS: ReadonlySet<string> = new Set(RANGES.map((r) => r.key));

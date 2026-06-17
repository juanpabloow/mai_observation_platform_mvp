import Link from "next/link";

export interface FilterChip {
  /** Human label, e.g. `wa_id equals 573…` or `Status: error`. */
  label: string;
  /** URL with this one filter removed (page reset). */
  removeHref: string;
}

/**
 * Active-filter chips, rendered SERVER-SIDE from the URL params, so a shared or
 * reloaded URL shows the same chips. Each ✕ is a plain Link to the URL with that
 * one filter removed; "Clear all" links to the URL with all filters removed.
 */
export function FilterChips({ chips, clearAllHref }: { chips: FilterChip[]; clearAllHref: string }) {
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {chips.map((chip, i) => (
        <span
          key={`${i}:${chip.label}`}
          className="inline-flex items-center gap-1.5 rounded-full border border-black/10 bg-black/[0.03] py-1 pl-3 pr-1.5 text-sm dark:border-line-strong dark:bg-subtle"
        >
          <span className="text-neutral-700 dark:text-foreground">{chip.label}</span>
          <Link
            href={chip.removeHref}
            aria-label={`Remove filter ${chip.label}`}
            className="flex size-5 items-center justify-center rounded-full text-neutral-500 transition-colors hover:bg-black/10 hover:text-foreground dark:hover:bg-subtle"
          >
            ✕
          </Link>
        </span>
      ))}
      {chips.length > 1 ? (
        <Link
          href={clearAllHref}
          className="rounded-full px-2.5 py-1 text-sm text-neutral-500 transition-colors hover:text-foreground"
        >
          Clear all
        </Link>
      ) : null}
    </div>
  );
}

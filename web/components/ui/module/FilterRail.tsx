"use client";

import { useId } from "react";

/**
 * A list's FILTERS, drawn two ways from ONE model so they cannot disagree:
 *   - FilterRail   the desktop side menu (inside SurfaceBody): a heading, the options
 *                  with their counts, a hairline between groups (e.g. «Archivados»);
 *   - FilterSelect the phone/tablet picker (inside SurfaceToolbar, below lg), the same
 *                  options as a native <select> — reliable, labelled, 44px.
 * Counts are the module's real numbers; a filter never invents one.
 */

export interface FilterOption {
  value: string;
  label: string;
  count?: number;
  /** Tailwind classes for a colour dot (e.g. the agenda colour of a category). */
  dot?: string;
}
export interface FilterGroup {
  /** Heading of the group (the first group's is the rail title, e.g. «Categorías»). */
  label?: string;
  options: FilterOption[];
}

export function FilterRail({ groups, value, onChange }: { groups: FilterGroup[]; value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex flex-col gap-0.5">
      {groups.map((g, i) => (
        <div key={g.label ?? i} className="flex flex-col gap-0.5">
          {i > 0 ? <span aria-hidden className="mx-2 my-2 h-px bg-line" /> : null}
          {g.label ? <p className="px-2.5 pb-1.5 pt-0.5 text-[0.6875rem] font-semibold uppercase tracking-[0.06em] text-faint">{g.label}</p> : null}
          {g.options.map((o) => {
            const on = o.value === value;
            return (
              <button
                key={o.value}
                type="button"
                aria-pressed={on}
                onClick={() => onChange(o.value)}
                className={`u-focus flex h-[2.25rem] w-full min-w-0 items-center gap-2.5 rounded-sch-control px-2.5 text-left text-[0.8438rem] transition-colors ${
                  on ? "bg-subtle font-semibold text-foreground" : "text-muted hover:bg-subtle hover:text-foreground"
                }`}
              >
                {o.dot ? <span aria-hidden className={`size-2 shrink-0 rounded-full ${o.dot}`} /> : null}
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                {o.count !== undefined ? (
                  <span className={`u-mono shrink-0 rounded-full px-1.5 py-px text-[0.6875rem] ${on ? "bg-surface text-foreground" : "bg-chip text-muted"}`}>
                    {o.count}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** The same filters as a native picker, for widths without the side menu (below lg). */
export function FilterSelect({
  groups,
  value,
  onChange,
  label,
  className = "",
  always = false,
}: {
  groups: FilterGroup[];
  value: string;
  onChange: (v: string) => void;
  label: string;
  className?: string;
  /** Show it at every width (screens with too little to filter for a side menu). */
  always?: boolean;
}) {
  const id = useId();
  const opt = (o: FilterOption) => (
    <option key={o.value} value={o.value}>
      {o.count !== undefined ? `${o.label} · ${o.count}` : o.label}
    </option>
  );
  return (
    <div className={`relative min-w-0 ${always ? "" : "lg:hidden"} ${className}`}>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="u-focus h-[44px] w-full appearance-none rounded-sch-control border border-line-strong bg-surface pl-3 pr-9 text-base text-foreground outline-none lg:h-[2.5rem] lg:text-sm"
      >
        {groups.map((g, i) =>
          i === 0 || !g.label ? (
            g.options.map(opt)
          ) : (
            <optgroup key={g.label} label={g.label}>
              {g.options.map(opt)}
            </optgroup>
          ),
        )}
      </select>
      <svg aria-hidden viewBox="0 0 16 16" className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d="M4 6l4 4 4-4" />
      </svg>
    </div>
  );
}

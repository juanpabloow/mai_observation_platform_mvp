"use client";

import { useId } from "react";
import type { Site } from "../AdminPanel";

/**
 * Which site a site-scoped settings screen is changing. With ONE site there is nothing to
 * pick, so nothing is drawn (no selector, no panel). With several, a labelled picker and a
 * line that says plainly what the changes apply to.
 */
export function SitePicker({
  sites,
  value,
  onChange,
  what,
}: {
  sites: Site[];
  value: string;
  onChange: (id: string) => void;
  /** «el contacto público», «las reglas»… — completes «Los cambios de … se aplican a». */
  what: string;
}) {
  const id = useId();
  if (sites.length <= 1) return null;
  const site = sites.find((s) => s.id === value);
  return (
    <div className="flex w-full flex-wrap items-center gap-x-3 gap-y-1.5">
      <label htmlFor={id} className="text-[0.8125rem] font-medium text-foreground">
        Sede
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="u-focus h-[44px] min-w-[12rem] rounded-sch-control border border-line-strong bg-surface px-3 text-base text-foreground lg:h-[2.5rem] lg:text-sm"
      >
        {sites.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
            {s.active ? "" : " (inactiva)"}
          </option>
        ))}
      </select>
      <span className="text-[0.7812rem] text-muted">
        Los cambios de {what} se aplican solo a <strong className="font-semibold text-foreground">{site?.name}</strong>.
      </span>
    </div>
  );
}

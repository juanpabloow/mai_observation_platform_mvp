"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { OUTLINE_CLS } from "@/components/ui/primitives";
import { RANGES, SORTS, type RangeKey, type SortKey } from "@/lib/meetingsFilters";

/**
 * The listing's CONTROL BAND — `Filtrar`, `Orden` and the removable range chip.
 *
 * These are client components because a popover is client state, but they hold
 * NO list state: every one is a pure URL-param writer, so the server page stays
 * the single source of truth and a filter stays deep-linkable.
 *
 * Mirrors the Contacts toolbar's Menu deliberately (same trigger class, same
 * click-outside + Escape, same `role="menuitemradio"` options) rather than
 * inventing a second popover for the same job.
 */

function useApply() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  return {
    searchParams,
    apply: (patch: Record<string, string>) => {
      const p = new URLSearchParams(searchParams.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v) p.set(k, v);
        else p.delete(k);
      }
      // Anything that changes WHICH rows match invalidates the page number.
      p.delete("page");
      const qs = p.toString();
      router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
  };
}

function Chevron() {
  return (
    <svg viewBox="0 0 16 16" className="size-2.5 shrink-0 text-faint" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path d="M4 6.5 8 10.5l4-4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Menu({
  label,
  icon,
  active = false,
  width = "w-60",
  children,
}: {
  label: string;
  icon?: React.ReactNode;
  active?: boolean;
  width?: string;
  children: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`${OUTLINE_CLS} ${active ? "border-ink text-foreground" : ""}`}
      >
        {icon}
        {label}
        <Chevron />
      </button>
      {open ? (
        <div
          role="menu"
          className={`absolute right-0 top-[calc(100%+0.25rem)] z-30 ${width} overflow-hidden rounded-lg border border-line bg-surface py-1 shadow-[var(--shadow-float)]`}
        >
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </div>
  );
}

function MenuOption({ label, selected, onSelect }: { label: string; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      onClick={onSelect}
      className={`flex min-h-9 w-full items-center gap-2 px-3 text-left text-sm transition-colors hover:bg-subtle ${
        selected ? "font-medium text-foreground" : "text-muted"
      }`}
    >
      <span className="flex-1">{label}</span>
      {selected ? (
        <svg viewBox="0 0 16 16" className="size-3 shrink-0 text-accent" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden>
          <path d="M3.4 8.4l3 3 6.2-6.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : null}
    </button>
  );
}

function MenuLabel({ children }: { children: React.ReactNode }) {
  return <p className="px-3 pb-1 pt-2 text-[0.6875rem] font-semibold text-faint">{children}</p>;
}

/** `Orden` — the sort the listing is currently in, named in the trigger. */
export function MeetingsSortMenu({ sort }: { sort: SortKey }) {
  const { apply } = useApply();
  const current = SORTS.find((s) => s.key === sort) ?? SORTS[0];
  return (
    <Menu label={`Orden: ${current.label}`} width="w-56">
      {(close) => (
        <>
          <MenuLabel>Ordenar por</MenuLabel>
          {SORTS.map((s) => (
            <MenuOption
              key={s.key}
              label={s.label[0].toUpperCase() + s.label.slice(1)}
              selected={s.key === sort}
              onSelect={() => {
                apply({ sort: s.key === "recent" ? "" : s.key });
                close();
              }}
            />
          ))}
        </>
      )}
    </Menu>
  );
}

/**
 * `Filtrar` — what the pill row cannot hold. The pills are the four buckets an
 * operator lives in; the date range composes WITH a pill, so it belongs here.
 */
export function MeetingsFilterMenu({ range }: { range: RangeKey }) {
  const { apply } = useApply();
  return (
    <Menu
      label="Filtrar"
      active={range !== "30d"}
      icon={
        <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
          <path d="M2.5 4h11M4.5 8h7M6.5 12h3" strokeLinecap="round" />
        </svg>
      }
    >
      {(close) => (
        <>
          <MenuLabel>Rango de fechas</MenuLabel>
          {RANGES.map((r) => (
            <MenuOption
              key={r.key}
              label={r.label}
              selected={r.key === range}
              onSelect={() => {
                apply({ range: r.key === "30d" ? "" : r.key });
                close();
              }}
            />
          ))}
        </>
      )}
    </Menu>
  );
}

/**
 * The ACTIVE-filter chip. It exists so a narrowed list always says so in words:
 * a listing quietly showing 30 days while claiming 128 meetings is the classic
 * way a filter gets forgotten.
 */
export function ActiveRangeChip({ range }: { range: RangeKey }) {
  const { apply } = useApply();
  const label = RANGES.find((r) => r.key === range)?.label ?? RANGES[0].label;
  if (range === "all") return null;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-lg border border-line-strong bg-chip py-1 pl-2.5 pr-1.5 text-[0.78125rem] text-foreground">
      {label}
      <button
        type="button"
        onClick={() => apply({ range: "all" })}
        aria-label={`Quitar el filtro ${label}`}
        className="u-focus rounded text-faint transition-colors hover:text-foreground"
      >
        <svg viewBox="0 0 16 16" className="size-2.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
          <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
      </button>
    </span>
  );
}

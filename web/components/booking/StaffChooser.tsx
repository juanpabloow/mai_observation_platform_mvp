"use client";

import { initialsOf, staffToneClass } from "@/lib/staffTone";

/**
 * "¿Con quién?" — round chips: "Cualquier profesional" first (the engine assigns
 * whoever is free), then each professional who performs the chosen service, wearing
 * their pastel agenda tone on the avatar. A radio group; only names, never contact data.
 * PRESENTATIONAL.
 */

export interface StaffOption {
  id: string;
  name: string;
}

export function StaffAvatar({ id, name, size = "md" }: { id: string | null; name: string | null; size?: "sm" | "md" }) {
  const dims = size === "sm" ? "size-6 text-[0.625rem]" : "size-[34px] text-xs";
  if (!id) {
    return (
      <span aria-hidden className={`flex shrink-0 items-center justify-center rounded-full bg-subtle text-muted ${dims}`}>
        ✱
      </span>
    );
  }
  // Fill/ink read straight from the tone's variables — NOT `u-appt-swatch`, whose
  // `display: inline-block` would beat `flex` and knock the initials off-centre.
  return (
    <span
      aria-hidden
      className={`${staffToneClass(id)} flex shrink-0 items-center justify-center rounded-full bg-[var(--appt-fill)] font-semibold leading-none text-[var(--appt-ink)] ${dims}`}
    >
      {initialsOf(name)}
    </span>
  );
}

export function StaffChooser({
  staff,
  selected,
  onSelect,
  loading,
  error,
  disabled,
}: {
  staff: StaffOption[];
  /** "" = Cualquier profesional. */
  selected: string;
  onSelect: (id: string) => void;
  loading: boolean;
  error: string | null;
  /** No service chosen yet — the professionals depend on it. */
  disabled?: boolean;
}) {
  if (loading) {
    return (
      <div className="flex flex-wrap gap-2" aria-busy="true">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="h-[48px] w-40 animate-pulse rounded-full bg-subtle" />
        ))}
        <p className="sr-only" role="status">
          Cargando profesionales…
        </p>
      </div>
    );
  }
  if (error) return <p className="rounded-xl border border-line bg-subtle/40 p-3 text-xs text-muted">{error}</p>;

  const options: StaffOption[] = [{ id: "", name: "Cualquier profesional" }, ...(disabled ? [] : staff)];
  return (
    <div role="radiogroup" aria-label="Profesional" className="flex flex-wrap gap-2">
      {options.map((o) => {
        const active = selected === o.id;
        return (
          <button
            key={o.id || "any"}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onSelect(o.id)}
            className={`u-focus flex h-[48px] items-center gap-2.5 rounded-full border-[1.5px] pl-1.5 pr-4 transition-colors ${
              active ? "border-foreground bg-subtle" : "border-line bg-surface hover:border-line-strong"
            }`}
          >
            <StaffAvatar id={o.id || null} name={o.name} />
            <span className="whitespace-nowrap text-sm text-foreground">{o.name}</span>
          </button>
        );
      })}
    </div>
  );
}

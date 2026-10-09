"use client";

import { useState } from "react";
import { apptCategoryClass, type ApptCategory } from "@/lib/agendaCategory";
import { priceLabelCOP } from "@/lib/money";

/**
 * The site's bookable services, GROUPED by category in collapsible sections. Each
 * service is a row (radio · colour dot · name · duration · price); a closed section
 * that holds the current choice says so ("✓ Corte clásico") so nothing chosen is ever
 * hidden. The section holding the selection — or the first one — starts open.
 * PRESENTATIONAL: the list comes from the public catalogue.
 */

export interface ServiceOption {
  id: string;
  name: string;
  description: string | null;
  duration_min: number;
  price: string | null;
  family: ApptCategory;
}

export function priceText(price: string | null): string {
  return priceLabelCOP(price) ?? "Precio a consultar";
}

/** Customer-facing section names, in the order a barbershop menu reads. */
const GROUPS: Array<{ family: ApptCategory; label: string }> = [
  { family: "cut", label: "Cortes" },
  { family: "grooming", label: "Barba y cuidado" },
  { family: "color", label: "Color" },
  { family: "feature", label: "Tratamientos" },
];

export function ServiceList({
  services,
  selected,
  onSelect,
}: {
  services: ServiceOption[];
  selected: string;
  onSelect: (id: string) => void;
}) {
  const groups = GROUPS.map((g) => ({ ...g, items: services.filter((s) => s.family === g.family) }));
  // Anything outside the four families still shows, under "Otros".
  const known = new Set(GROUPS.map((g) => g.family));
  const others = services.filter((s) => !known.has(s.family));
  if (others.length) groups.push({ family: "cut", label: "Otros", items: others });
  const visible = groups.filter((g) => g.items.length > 0);

  const initial = visible.find((g) => g.items.some((s) => s.id === selected))?.label ?? visible[0]?.label;
  const [open, setOpen] = useState<Record<string, boolean>>(initial ? { [initial]: true } : {});

  if (services.length === 0) {
    return (
      <div className="flex flex-col items-center gap-1 rounded-xl border border-line bg-subtle/40 px-4 py-10 text-center">
        <p className="text-sm font-semibold">Aún no hay servicios para reservar</p>
        <p className="max-w-xs text-xs text-muted">Esta sede todavía no publicó servicios en línea. Comunícate directamente con ella.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3.5">
      {visible.map((g) => {
        const isOpen = Boolean(open[g.label]);
        const picked = g.items.find((s) => s.id === selected);
        const panelId = `svc-group-${g.label.replace(/\s+/g, "-").toLowerCase()}`;
        return (
          <div key={g.label} className="flex flex-col overflow-hidden rounded-xl border border-line">
            <button
              type="button"
              aria-expanded={isOpen}
              aria-controls={panelId}
              onClick={() => setOpen((o) => ({ ...o, [g.label]: !o[g.label] }))}
              className="u-focus flex min-h-[52px] items-center gap-3 bg-surface px-4 text-left transition-colors hover:bg-subtle/60"
            >
              <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
                <span className="text-[15px] font-semibold text-foreground">{g.label}</span>
                <span className="text-[13px] text-muted">
                  {g.items.length} {g.items.length === 1 ? "servicio" : "servicios"}
                </span>
              </span>
              {!isOpen && picked ? (
                <span className="max-w-[150px] truncate whitespace-nowrap rounded-md bg-success/10 px-2 py-0.5 text-[12.5px] text-success">
                  ✓ {picked.name}
                </span>
              ) : null}
              <svg
                aria-hidden
                viewBox="0 0 16 16"
                className={`size-4 shrink-0 text-muted transition-transform ${isOpen ? "rotate-180" : ""}`}
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
              >
                <path d="M4 6l4 4 4-4" />
              </svg>
            </button>
            {isOpen ? (
              <div id={panelId} role="radiogroup" aria-label={g.label} className="flex flex-col border-t border-line">
                {g.items.map((s, i) => {
                  const active = s.id === selected;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => onSelect(s.id)}
                      className={`u-focus flex min-h-[56px] items-center gap-3 px-4 py-2 text-left transition-colors ${
                        i ? "border-t border-line" : ""
                      } ${active ? "bg-subtle shadow-[inset_3px_0_0_var(--foreground)]" : "bg-surface hover:bg-subtle/60"}`}
                    >
                      <span
                        aria-hidden
                        className={`flex size-5 shrink-0 items-center justify-center rounded-full border-[1.5px] ${
                          active ? "border-foreground" : "border-line-strong"
                        }`}
                      >
                        <span className={`size-2.5 rounded-full ${active ? "bg-foreground" : "bg-transparent"}`} />
                      </span>
                      <span aria-hidden className={`u-appt-service ${apptCategoryClass(s.family)} size-2 shrink-0 rounded-full bg-[var(--appt-ink)] opacity-60`} />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="text-[15px] text-foreground">{s.name}</span>
                        {s.description ? <span className="truncate text-xs text-muted">{s.description}</span> : null}
                      </span>
                      <span className="u-mono shrink-0 text-[13px] text-muted">{s.duration_min} min</span>
                      <span className="w-[84px] shrink-0 text-right text-[13.5px] text-foreground sm:w-[116px] sm:text-sm">
                        {priceText(s.price)}
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

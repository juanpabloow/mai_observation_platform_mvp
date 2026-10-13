"use client";

import { useId, useState } from "react";
import type { ApptCategory } from "@/lib/agendaCategory";
import { priceLabelCOP } from "@/lib/money";
import { needsMore } from "@/lib/publicBookingFlow";
import { IconCheck, IconClock, IconPlus, LINK_BTN, ring, SERIF, type ServiceOption } from "./ui";

/**
 * STEP 1 — Elige tu servicio. One service per booking (no cart). The categories are the
 * catalogue's real families; "Ver más" expands the description IN PLACE and never
 * selects. The full description is always the one stored — never a shortened copy.
 */

/** Customer-facing names of the stored service families, in menu order. */
const FAMILIES: Array<{ family: ApptCategory; label: string }> = [
  { family: "cut", label: "Cortes" },
  { family: "grooming", label: "Barba y cuidado" },
  { family: "color", label: "Color" },
  { family: "feature", label: "Tratamientos" },
];

export function serviceGroups(services: ServiceOption[]): Array<{ key: string; label: string; items: ServiceOption[] }> {
  const known = new Set(FAMILIES.map((f) => f.family));
  const groups = FAMILIES.map((f) => ({ key: f.family as string, label: f.label, items: services.filter((s) => s.family === f.family) }));
  const others = services.filter((s) => !known.has(s.family));
  if (others.length) groups.push({ key: "other", label: "Otros", items: others });
  return groups.filter((g) => g.items.length > 0);
}

export function ServiceStep({
  services,
  selected,
  onSelect,
}: {
  services: ServiceOption[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const [cat, setCat] = useState<string>("all");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const groups = serviceGroups(services);
  const shown = cat === "all" ? groups : groups.filter((g) => g.key === cat);

  if (services.length === 0) {
    return (
      <div className="flex flex-col gap-1 rounded-[16px] border border-pb-line bg-white p-4">
        <span className="text-[16px] font-[590]">Aún no hay servicios para reservar en línea</span>
        <span className="text-[14px] leading-[1.45] text-pb-muted">Esta sede todavía no publicó servicios. Comunícate directamente con ella.</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-[18px]">
      {groups.length > 1 ? (
        <div
          role="group"
          aria-label="Categorías"
          className="pb-nosb -mx-4 flex gap-2 overflow-x-auto px-4 lg:mx-0 lg:flex-wrap lg:overflow-visible lg:px-0"
        >
          {[{ key: "all", label: "Todos" }, ...groups].map((c) => {
            const on = cat === c.key;
            return (
              <button
                key={c.key}
                type="button"
                aria-pressed={on}
                onClick={() => setCat(c.key)}
                className={`flex min-h-[44px] flex-none items-center whitespace-nowrap rounded-[12px] border px-[18px] text-[15px] ${
                  on ? "border-pb-ink bg-pb-ink text-white" : "border-pb-line2 bg-white text-pb-ink"
                }`}
              >
                {c.label}
              </button>
            );
          })}
        </div>
      ) : null}

      <div className="flex flex-col gap-[22px]">
        {shown.map((g) => (
          <section key={g.key} aria-label={g.label} className="flex flex-col gap-2.5">
            <h2 className={`${SERIF} m-0 text-[23px] leading-tight`}>{g.label}</h2>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(min(300px,100%),1fr))] gap-2.5">
              {g.items.map((s) => (
                <ServiceCard
                  key={s.id}
                  service={s}
                  selected={selected === s.id}
                  expanded={!!open[s.id]}
                  onToggle={() => setOpen((o) => ({ ...o, [s.id]: !o[s.id] }))}
                  onSelect={() => onSelect(s.id)}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function ServiceCard({
  service: s,
  selected,
  expanded,
  onToggle,
  onSelect,
}: {
  service: ServiceOption;
  selected: boolean;
  expanded: boolean;
  onToggle: () => void;
  onSelect: () => void;
}) {
  const descId = useId();
  const price = priceLabelCOP(s.price) ?? "Precio a consultar";
  const more = needsMore(s.description);
  return (
    <div className={`flex items-start gap-3.5 rounded-[16px] p-3.5 ${ring(selected)}`}>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <button
          type="button"
          aria-pressed={selected}
          aria-describedby={s.description ? descId : undefined}
          onClick={onSelect}
          className="flex min-w-0 flex-col gap-[5px] rounded-[8px] bg-transparent p-0 text-left"
        >
          <span className="text-[16.5px] font-[590] leading-[1.3] [overflow-wrap:anywhere]">{s.name}</span>
          <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[13.5px] text-pb-muted [font-variant-numeric:tabular-nums]">
            <span className="flex items-center gap-[5px]">
              <IconClock />
              {s.duration_min} min
            </span>
            <span className="text-[15px] font-semibold text-pb-ink">{price}</span>
            {selected ? <span className="sr-only">Seleccionado</span> : null}
          </span>
        </button>
        {s.description ? (
          <p
            id={descId}
            className={`m-0 whitespace-pre-line text-[14px] leading-[1.45] text-pb-tx2 [overflow-wrap:anywhere] ${
              expanded ? "" : "line-clamp-2"
            }`}
          >
            {s.description}
          </p>
        ) : null}
        {more ? (
          <button type="button" aria-expanded={expanded} onClick={onToggle} className={`${LINK_BTN} -mb-2.5 -ml-2 -mt-1 self-start`}>
            {expanded ? "Ver menos" : "Ver más"}
            <span className="sr-only"> sobre {s.name}</span>
          </button>
        ) : null}
      </div>
      <button
        type="button"
        tabIndex={-1}
        aria-hidden
        onClick={onSelect}
        className={`flex size-11 flex-none items-center justify-center rounded-full border p-0 ${
          selected ? "border-pb-ink bg-pb-ink" : "border-pb-line2 bg-white"
        }`}
      >
        {selected ? <IconCheck /> : <IconPlus />}
      </button>
    </div>
  );
}

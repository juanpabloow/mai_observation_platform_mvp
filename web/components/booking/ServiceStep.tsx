"use client";

import { useEffect, useId, useState } from "react";
import type { ApptCategory } from "@/lib/agendaCategory";
import { pageSections, upgradeOffer, whatsappLink, type PageService } from "@/lib/bookingPage";
import { priceLabelCOP } from "@/lib/money";
import { needsMore } from "@/lib/publicBookingFlow";
import { PromotionCard } from "./PromotionCard";
import {
  CTA_BASE,
  ctaTone,
  IconArrow,
  IconCheck,
  IconClock,
  IconPlus,
  IconUp,
  IconWhatsApp,
  LINK_BTN,
  RatingButton,
  ring,
  SERIF,
  type CategoryView,
  type ServiceOption,
} from "./ui";

/**
 * STEP 1 — Elige tu experiencia. One service per booking (no cart).
 *
 * With the business's own booking categories (migration 1804) the step asks "¿Qué
 * quieres vivir hoy?" and shows them in the business's order: a `featured` group as large
 * cards (only COMPLETE services — image, description, what it includes, duration and
 * price), `list` groups as cards, and `contact` groups as a small WhatsApp link. A
 * business that never configured categories keeps the previous grouping by family.
 *
 * "Ver más" expands the description IN PLACE and never selects. The rating is a button
 * that opens the service's reviews; it is shown only when there are approved ones.
 * Choosing a service with an explicit better alternative offers it, with the REAL price
 * difference — switching is always a separate, deliberate tap.
 */

/** Customer-facing names of the stored service families, in menu order (legacy mode). */
const FAMILIES: Array<{ family: ApptCategory; label: string }> = [
  { family: "cut", label: "Cortes" },
  { family: "grooming", label: "Barba y cuidado" },
  { family: "color", label: "Color" },
  { family: "feature", label: "Tratamientos" },
];

export function serviceGroups<T extends ServiceOption>(services: T[]): Array<{ key: string; label: string; items: T[] }> {
  const known = new Set(FAMILIES.map((f) => f.family));
  const groups = FAMILIES.map((f) => ({ key: f.family as string, label: f.label, items: services.filter((s) => s.family === f.family) }));
  const others = services.filter((s) => !known.has(s.family));
  if (others.length) groups.push({ key: "other", label: "Otros", items: others });
  return groups.filter((g) => g.items.length > 0);
}

/** A ServiceOption as the presentation rules read it (absent fields = not configured). */
export function asPageService(s: ServiceOption): ServiceOption & PageService {
  return {
    ...s,
    category_id: s.category_id ?? null,
    recommended: Boolean(s.recommended),
    image_url: s.image_url ?? null,
    includes: s.includes ?? [],
    upgrade_to: s.upgrade_to ?? null,
  };
}

const prefersReducedMotion = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** A promotion as the page receives it (projectPublicPromotion). */
export interface PublicPromotionView {
  id: string;
  name: string;
  description: string | null;
  conditions: string | null;
  image_url: string | null;
  benefit_label: string;
  rule_text: string | null;
  service_ids: string[];
}

export function ServiceStep({
  services,
  categories,
  promotions = [],
  selected,
  onSelect,
  onReserve,
  onOpenReviews,
  siteName,
  whatsapp,
  willRecheck,
}: {
  services: ServiceOption[];
  categories: CategoryView[];
  selected: string | null;
  onSelect: (id: string) => void;
  /** "Reservar mi experiencia": choose and go on to the artist. */
  onReserve: (id: string) => void;
  onOpenReviews: (service: ServiceOption, trigger: HTMLElement) => void;
  siteName: string;
  whatsapp: string | null;
  /** An artist or a time is already chosen: switching service re-checks them. */
  willRecheck: boolean;
  promotions?: PublicPromotionView[];
}) {
  const all = services.map(asPageService);
  const page = pageSections(all, categories, { hasWhatsapp: Boolean(whatsapp) });

  if (services.length === 0 && !(page && page.contacts.length)) {
    return (
      <div className="flex flex-col gap-1 rounded-[16px] border border-pb-line bg-white p-4">
        <span className="text-[16px] font-[590]">Aún no hay servicios para reservar en línea</span>
        <span className="text-[14px] leading-[1.45] text-pb-muted">Esta sede todavía no publicó servicios. Comunícate directamente con ella.</span>
      </div>
    );
  }

  const cardProps = { all, selected, onSelect, onOpenReviews, willRecheck };

  if (!page) {
    return (
      <div className="flex flex-col gap-[22px]">
        <LegacyCatalogue services={all} {...cardProps} />
        <PromotionsBlock promotions={promotions} services={all} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-[18px]">
      <h2 className={`${SERIF} m-0 text-[24px] leading-tight lg:text-[26px]`}>¿Qué quieres vivir hoy?</h2>
      {(() => {
        const nav = [...page.sections.map((g) => ({ key: g.key, name: g.name })), ...(promotions.length ? [{ key: "promos", name: "Promociones" }] : [])];
        return nav.length > 1 ? <SectionNav sections={nav} /> : null;
      })()}
      <div className="flex flex-col gap-[26px]">
        {page.sections.map((g) => (
          <section key={g.key} id={`pb-sec-${g.key}`} aria-labelledby={`pb-sec-h-${g.key}`} className="flex scroll-mt-4 flex-col gap-2.5">
            <div className="flex flex-col gap-0.5">
              <h3 id={`pb-sec-h-${g.key}`} className={`${SERIF} m-0 leading-tight ${g.layout === "featured" ? "text-[27px]" : "text-[23px]"}`}>
                {g.name}
              </h3>
              {g.tagline ? <p className="m-0 text-[14.5px] text-pb-muted">{g.tagline}</p> : null}
            </div>
            {g.layout === "featured" ? (
              <div className="flex flex-col gap-3">
                {g.items.map((s, i) => (
                  <FeaturedCard key={s.id} index={i} service={s} selected={selected === s.id} onReserve={() => onReserve(s.id)} onOpenReviews={onOpenReviews} />
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(min(300px,100%),1fr))] items-start gap-2.5">
                {g.items.map((s, i) => (
                  <ServiceCard key={s.id} index={i} service={s} {...cardProps} />
                ))}
              </div>
            )}
          </section>
        ))}
      </div>
      <PromotionsBlock promotions={promotions} services={all} />
      {page.contacts.length > 0 ? (
        <div className="flex flex-col gap-1">
          {page.contacts.map((c) => {
            const href = whatsappLink(whatsapp, `Hola ${siteName}, quiero información sobre ${c.name}.`);
            return href ? (
              <a key={c.id} href={href} rel="noopener noreferrer" className={`${LINK_BTN} -ml-2 gap-2 self-start`}>
                <IconWhatsApp size={16} />
                {c.tagline}
                <span className="sr-only"> Abre WhatsApp</span>
              </a>
            ) : null;
          })}
        </div>
      ) : null}
    </div>
  );
}

/**
 * "Promociones": published promotions on offer now (window A, applied by the server).
 * Information only for now — booking WITH a promotion opens once its benefit is bookable
 * (the server refuses any promotion booking until then, src/scheduling/promotions.ts).
 */
function PromotionsBlock({ promotions, services }: { promotions: PublicPromotionView[]; services: ServiceOption[] }) {
  if (promotions.length === 0) return null;
  return (
    <section id="pb-sec-promos" aria-labelledby="pb-sec-h-promos" className="flex scroll-mt-4 flex-col gap-2.5">
      <h3 id="pb-sec-h-promos" className={`${SERIF} m-0 text-[23px] leading-tight`}>
        Promociones
      </h3>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(min(320px,100%),1fr))] gap-3">
        {promotions.map((p) => (
          <PromotionCard key={p.id} promo={{ ...p, services: p.service_ids.map((id) => services.find((s) => s.id === id)?.name ?? "").filter(Boolean) }} />
        ))}
      </div>
    </section>
  );
}

/** The groups as chips that jump to each section; the one in view is marked. */
function SectionNav({ sections }: { sections: Array<{ key: string; name: string }> }) {
  const [current, setCurrent] = useState(sections[0]?.key ?? "");
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const els = sections.map((g) => document.getElementById(`pb-sec-${g.key}`)).filter((x): x is HTMLElement => !!x);
    const io = new IntersectionObserver(
      (entries) => {
        const seen = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (seen) setCurrent(seen.target.id.replace("pb-sec-", ""));
      },
      { rootMargin: "-20% 0px -60% 0px" },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [sections]);
  return (
    <nav aria-label="Categorías" className="pb-nosb -mx-4 flex gap-2 overflow-x-auto px-4 lg:mx-0 lg:flex-wrap lg:overflow-visible lg:px-0">
      {sections.map((g) => {
        const on = current === g.key;
        return (
          <button
            key={g.key}
            type="button"
            aria-current={on ? "true" : undefined}
            onClick={() => {
              setCurrent(g.key);
              document.getElementById(`pb-sec-${g.key}`)?.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
            }}
            className={`pb-sel pb-press flex min-h-[44px] flex-none items-center whitespace-nowrap rounded-[12px] border px-[18px] text-[15px] ${
              on ? "border-pb-ink bg-pb-ink text-white" : "border-pb-line2 bg-white text-pb-ink"
            }`}
          >
            {g.name}
          </button>
        );
      })}
    </nav>
  );
}

function LegacyCatalogue({ services, ...cardProps }: { services: Array<ServiceOption & PageService> } & Omit<CardProps, "service" | "index">) {
  const [cat, setCat] = useState<string>("all");
  const groups = serviceGroups(services);
  const shown = cat === "all" ? groups : groups.filter((g) => g.key === cat);
  return (
    <div className="flex flex-col gap-[18px]">
      {groups.length > 1 ? (
        <div role="group" aria-label="Categorías" className="pb-nosb -mx-4 flex gap-2 overflow-x-auto px-4 lg:mx-0 lg:flex-wrap lg:overflow-visible lg:px-0">
          {[{ key: "all", label: "Todos" }, ...groups].map((c) => {
            const on = cat === c.key;
            return (
              <button
                key={c.key}
                type="button"
                aria-pressed={on}
                onClick={() => setCat(c.key)}
                className={`pb-sel pb-press flex min-h-[44px] flex-none items-center whitespace-nowrap rounded-[12px] border px-[18px] text-[15px] ${
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
            <div className="grid grid-cols-[repeat(auto-fill,minmax(min(300px,100%),1fr))] items-start gap-2.5">
              {g.items.map((s, i) => (
                <ServiceCard key={s.id} index={i} service={s} {...cardProps} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

interface CardProps {
  service: ServiceOption & PageService;
  index: number;
  all: Array<ServiceOption & PageService>;
  selected: string | null;
  onSelect: (id: string) => void;
  onOpenReviews: (service: ServiceOption, trigger: HTMLElement) => void;
  willRecheck: boolean;
}

function ServiceCard({ service: s, index, all, selected, onSelect, onOpenReviews, willRecheck }: CardProps) {
  const descId = useId();
  const [expanded, setExpanded] = useState(false);
  const isSel = selected === s.id;
  const price = priceLabelCOP(s.price) ?? "Precio a consultar";
  const more = needsMore(s.description);
  // Its better alternative (real price difference) — compared at a glance, offered on select.
  const alt = upgradeOffer(s, all);
  const offer = isSel ? alt : null;
  // Top row: what it is (the select button) + the round ✓/+ mirror. Below, at full width:
  // the description (2 lines + "Ver más", which only expands) and the alternative offer.
  // "Recomendado" sits ABOVE the name so it never squeezes it.
  return (
    <div style={{ ["--i" as string]: index }} className={`pb-rise flex flex-col gap-2 rounded-[16px] p-3.5 ${ring(isSel)}`}>
      <div className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <button
            type="button"
            aria-pressed={isSel}
            aria-describedby={s.description ? descId : undefined}
            onClick={() => onSelect(s.id)}
            className="flex min-h-11 min-w-0 flex-col justify-center gap-1 rounded-[8px] bg-transparent p-0 text-left"
          >
            <span className="text-[16.5px] font-[590] leading-[1.3] [overflow-wrap:anywhere] [text-wrap:balance]">{s.name}</span>
            {/* Read after the name (DOM order), shown above it (order-first). */}
            {s.recommended ? <span className="order-first self-start rounded-full bg-pb-peach px-2 py-0.5 text-[12px] font-[590] leading-[1.35] text-pb-peach-fg">Recomendado</span> : null}
            <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[13.5px] text-pb-muted [font-variant-numeric:tabular-nums]">
              <span className="flex items-center gap-[5px]">
                <IconClock />
                {s.duration_min} min
              </span>
              <span className="text-[15px] font-semibold text-pb-ink">{price}</span>
            </span>
            {isSel ? <span className="sr-only">Seleccionado</span> : null}
          </button>
          {s.rating ? (
            <span className="self-start">
              <RatingButton rating={s.rating} label={s.name} onOpen={(t) => onOpenReviews(s, t)} />
            </span>
          ) : null}
        </div>
        <button
          type="button"
          tabIndex={-1}
          aria-hidden
          onClick={() => onSelect(s.id)}
          className={`pb-sel pb-press flex size-11 flex-none items-center justify-center rounded-full border p-0 ${isSel ? "border-pb-ink bg-pb-ink" : "border-pb-line2 bg-white"}`}
        >
          {isSel ? (
            <span key="on" className="pb-pop flex">
              <IconCheck />
            </span>
          ) : (
            <IconPlus />
          )}
        </button>
      </div>
      {alt && !isSel ? (
        <span className="text-[13px] leading-[1.4] text-pb-muted [font-variant-numeric:tabular-nums]">
          {alt.target.name}: +{priceLabelCOP(String(alt.delta))}
          {alt.target.duration_min !== s.duration_min ? ` · ${alt.target.duration_min > s.duration_min ? "+" : "−"}${Math.abs(alt.target.duration_min - s.duration_min)} min` : ""}
        </span>
      ) : null}
      {s.description ? (
        <div className="flex flex-col">
          <p id={descId} className={`m-0 whitespace-pre-line text-[14px] leading-[1.45] text-pb-tx2 [overflow-wrap:anywhere] ${expanded ? "" : "line-clamp-2"}`}>
            {s.description}
          </p>
          {more ? (
            <button type="button" aria-expanded={expanded} aria-controls={descId} onClick={() => setExpanded((x) => !x)} className={`${LINK_BTN} -mb-2.5 -ml-2 -mt-1.5 self-start`}>
              {expanded ? "Ver menos" : "Ver más"}
              <span className="sr-only"> sobre {s.name}</span>
            </button>
          ) : null}
        </div>
      ) : null}
      {offer ? <UpgradeOffer from={s} target={offer.target} delta={offer.delta} onSwitch={() => onSelect(offer.target.id)} willRecheck={willRecheck} /> : null}
    </div>
  );
}

/** "Pásate a … por $X más" — the difference is computed from both real prices. */
function UpgradeOffer({ from, target, delta, onSwitch, willRecheck }: { from: PageService; target: PageService; delta: number; onSwitch: () => void; willRecheck: boolean }) {
  const amount = priceLabelCOP(String(delta)) ?? "";
  return (
    <div role="group" aria-label={`Alternativa a ${from.name}`} className="pb-rise flex flex-col gap-2 rounded-[12px] bg-pb-sf2 p-3">
      <p className="m-0 flex items-start gap-2 text-[14px] leading-[1.45] text-pb-body">
        <span className="mt-0.5 text-pb-tx2">
          <IconUp />
        </span>
        <span>
          Pásate a <span className="font-[590]">{target.name}</span> por <span className="font-[590] [font-variant-numeric:tabular-nums]">{amount} más</span>
          <span className="text-pb-muted">
            {" "}
            · {target.duration_min} min{target.duration_min !== from.duration_min ? ` (${target.duration_min > from.duration_min ? "+" : "−"}${Math.abs(target.duration_min - from.duration_min)} min)` : ""}
          </span>
          .
          {willRecheck ? <span className="block text-[13px] text-pb-muted">Si cambias, revisaremos de nuevo el artista y la hora.</span> : null}
        </span>
      </p>
      {/* Not BTN_PRIMARY_SM: a long service name must wrap at 360 px, never overflow. */}
      <button
        type="button"
        onClick={onSwitch}
        className="pb-sel pb-press inline-flex min-h-[44px] max-w-full items-center self-start rounded-[12px] border border-pb-ink bg-pb-ink px-4 py-2 text-left text-[15px] font-[590] leading-snug text-white"
      >
        Cambiar a {target.name}
      </button>
    </div>
  );
}

/**
 * A `featured` group's large card (Entre Nubes): image, title, duration and price first,
 * a SHORT introduction with "Leer más" for the rest, the booking button right after it,
 * and "Qué incluye" — collapsible on the phone, always open from `sm`. Nothing is removed:
 * every line of the description and of "Qué incluye" stays one tap away.
 */
function FeaturedCard({
  service: s,
  index,
  selected,
  onReserve,
  onOpenReviews,
}: {
  service: ServiceOption & PageService;
  index: number;
  selected: boolean;
  onReserve: () => void;
  onOpenReviews: (service: ServiceOption, trigger: HTMLElement) => void;
}) {
  const descId = useId();
  const incId = useId();
  const [more, setMore] = useState(false);
  const [incOpen, setIncOpen] = useState(false);
  const price = priceLabelCOP(s.price) ?? "";
  const longText = needsMore(s.description);
  return (
    <article style={{ ["--i" as string]: index }} aria-label={s.name} className={`pb-rise overflow-hidden rounded-[20px] ${ring(selected)}`}>
      {s.image_url ? (
        // eslint-disable-next-line @next/next/no-img-element -- the business's own uploaded image (R2), sized by CSS
        <img src={s.image_url} alt="" className="block aspect-[16/10] w-full object-cover lg:aspect-[21/9]" loading="eager" decoding="async" />
      ) : null}
      <div className="flex flex-col gap-3 p-4 lg:p-5">
        <div className="flex flex-col gap-1.5">
          <h4 className={`${SERIF} m-0 text-[26px] leading-[1.1] [overflow-wrap:anywhere] [text-wrap:balance]`}>{s.name}</h4>
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1 [font-variant-numeric:tabular-nums]">
            <span className="text-[19px] font-semibold text-pb-ink">{price}</span>
            <span className="flex items-center gap-[5px] text-[14px] text-pb-muted">
              <IconClock />
              {s.duration_min} min
            </span>
            {s.rating ? <RatingButton rating={s.rating} label={s.name} onOpen={(t) => onOpenReviews(s, t)} /> : null}
          </span>
        </div>
        {s.description ? (
          <div className="flex flex-col">
            <p id={descId} className={`m-0 whitespace-pre-line text-[15px] leading-[1.55] text-pb-body [overflow-wrap:anywhere] ${more ? "" : "line-clamp-3"}`}>
              {s.description}
            </p>
            {longText ? (
              <button type="button" aria-expanded={more} aria-controls={descId} onClick={() => setMore((x) => !x)} className={`${LINK_BTN} -mb-1 -ml-2 self-start`}>
                {more ? "Ver menos" : "Leer más"}
                <span className="sr-only"> sobre {s.name}</span>
              </button>
            ) : null}
          </div>
        ) : null}
        <button type="button" aria-pressed={selected} onClick={onReserve} className={`${CTA_BASE} ${ctaTone("on")} w-full sm:w-auto sm:self-start`}>
          {selected ? (
            <span key="on" className="pb-pop flex">
              <IconCheck />
            </span>
          ) : null}
          Reservar mi experiencia
          <IconArrow />
        </button>
        {s.includes.length > 0 ? (
          <div className="flex flex-col gap-1.5 border-t border-pb-hair pt-3">
            <button
              type="button"
              aria-expanded={incOpen}
              aria-controls={incId}
              onClick={() => setIncOpen((x) => !x)}
              className="flex min-h-11 items-center justify-between gap-2 text-left text-[14.5px] font-[590] text-pb-ink sm:hidden"
            >
              Qué incluye ({s.includes.length})
              <span aria-hidden className={`transition-transform duration-200 motion-reduce:transition-none ${incOpen ? "rotate-180" : ""}`}>
                <IconChevronDown />
              </span>
            </button>
            <h5 className="m-0 hidden text-[13.5px] font-[590] text-pb-tx2 sm:block">Qué incluye</h5>
            <ul id={incId} className={`m-0 list-none flex-col gap-1 p-0 sm:flex ${incOpen ? "pb-fade flex" : "hidden"}`}>
              {s.includes.map((x) => (
                <li key={x} className="flex items-start gap-2 text-[14.5px] leading-[1.45] text-pb-body">
                  <span className="mt-[3px] flex-none">
                    <IconCheck size={14} stroke="#2f5a38" />
                  </span>
                  {x}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </article>
  );
}

function IconChevronDown() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
      <path d="M3.5 6 8 10.5 12.5 6" />
    </svg>
  );
}

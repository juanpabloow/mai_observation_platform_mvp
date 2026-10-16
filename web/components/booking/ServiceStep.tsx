"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { ApptCategory } from "@/lib/agendaCategory";
import { pageSections, upgradeOffer, whatsappLink, type PageService } from "@/lib/bookingPage";
import { priceLabelCOP } from "@/lib/money";
import { needsMore } from "@/lib/publicBookingFlow";
import { ratingText, reviewCountText } from "@/lib/publicReviews";
import { PromotionCard } from "./PromotionCard";
import {
  BTN_SECONDARY_LG,
  chooseBtn,
  CTA_BASE,
  ctaTone,
  IconArrow,
  IconCheck,
  IconClock,
  IconClose,
  IconStar,
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
  // "Ver más" on a laptop opens the full detail here, so no card ever changes height.
  const [detail, setDetail] = useState<{ id: string; trigger: HTMLElement } | null>(null);

  if (services.length === 0 && !(page && page.contacts.length)) {
    return (
      <div className="flex flex-col gap-1 rounded-[16px] border border-pb-line bg-white p-4">
        <span className="text-[16px] font-[590]">Aún no hay servicios para reservar en línea</span>
        <span className="text-[14px] leading-[1.45] text-pb-muted">Esta sede todavía no publicó servicios. Comunícate directamente con ella.</span>
      </div>
    );
  }

  const cardProps = { all, selected, onSelect, onOpenReviews, willRecheck, onOpenDetail: (id: string, trigger: HTMLElement) => setDetail({ id, trigger }) };
  const detailDialog = (
    <ServiceDetailDialog
      service={detail ? all.find((x) => x.id === detail.id) ?? null : null}
      all={all}
      selected={selected}
      onSelect={onSelect}
      onClose={() => setDetail(null)}
      returnFocusTo={detail?.trigger ?? null}
    />
  );

  if (!page) {
    return (
      <div className="flex flex-col gap-[22px]">
        <LegacyCatalogue services={all} {...cardProps} />
        <PromotionsBlock promotions={promotions} services={all} />
        {detailDialog}
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
              <div className="grid grid-cols-[repeat(auto-fill,minmax(min(300px,100%),1fr))] items-start gap-2.5 lg:grid-cols-1">
                {g.items.map((s, i) => (
                  <ServiceCard key={s.id} index={i} service={s} {...cardProps} />
                ))}
              </div>
            )}
          </section>
        ))}
      </div>
      <PromotionsBlock promotions={promotions} services={all} />
      {detailDialog}
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
            <div className="grid grid-cols-[repeat(auto-fill,minmax(min(300px,100%),1fr))] items-start gap-2.5 lg:grid-cols-1">
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
  onOpenDetail: (id: string, trigger: HTMLElement) => void;
}

/**
 * A service card. Phone/tablet: one natural-height card (name, duration · price, rating,
 * alternative, a 2-line description with "Ver más" in place). From `lg` (1024 px) the
 * SAME elements sit in a fixed-height horizontal row — what it is on the left, price ·
 * duration · selection aligned on the right — with every slot (label, rating line,
 * description line) reserved, so no card is taller than another and nothing jumps.
 * There "Ver más" opens the detail dialog instead of growing the card, and the
 * Signature alternative of a selected card is shown BELOW it, outside the fixed height.
 */
function ServiceCard({ service: s, index, all, selected, onSelect, onOpenReviews, willRecheck, onOpenDetail }: CardProps) {
  const descId = useId();
  const [expanded, setExpanded] = useState(false);
  const isSel = selected === s.id;
  const price = priceLabelCOP(s.price) ?? "Precio a consultar";
  const more = needsMore(s.description);
  // Its better alternative (real price difference) — compared at a glance, offered on select.
  const alt = upgradeOffer(s, all);
  const offer = isSel ? alt : null;
  const altHint = alt && !isSel;
  const offerBox = offer ? <UpgradeOffer from={s} target={offer.target} delta={offer.delta} onSwitch={() => onSelect(offer.target.id)} willRecheck={willRecheck} /> : null;
  return (
    <div className="flex flex-col gap-2">
      <div
        style={{ ["--i" as string]: index }}
        className={`pb-rise flex flex-col gap-2 rounded-[16px] p-3.5 lg:grid lg:h-[152px] lg:grid-cols-[minmax(0,1fr)_auto] lg:content-center lg:gap-x-6 lg:gap-y-1 lg:overflow-hidden lg:px-5 lg:py-3 lg:[grid-template-areas:'info_side'_'meta_side'_'desc_side'] ${ring(isSel)}`}
      >
        <div className="flex items-start gap-3 lg:contents">
          <div className="flex min-w-0 flex-1 flex-col gap-1 lg:[grid-area:info]">
            <button
              type="button"
              aria-pressed={isSel}
              aria-describedby={s.description ? descId : undefined}
              onClick={() => onSelect(s.id)}
              className="flex min-h-11 min-w-0 flex-col justify-center gap-1 rounded-[8px] bg-transparent p-0 text-left"
            >
              <span className="text-[16.5px] font-[590] leading-[1.3] [overflow-wrap:anywhere] [text-wrap:balance] lg:line-clamp-2">{s.name}</span>
              {/* Read after the name (DOM order), shown above it (order-first). On a laptop the
                  slot is reserved even when empty, so every name starts at the same height. */}
              {s.recommended ? (
                <span className="order-first self-start rounded-full bg-pb-peach px-2 py-0.5 text-[12px] font-[590] leading-[1.35] text-pb-peach-fg">Recomendado</span>
              ) : (
                <span aria-hidden className="order-first hidden h-[22px] lg:block" />
              )}
              {/* Phone: duration · price under the name. Laptop: read here, SHOWN on the right. */}
              <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[13.5px] text-pb-muted [font-variant-numeric:tabular-nums] lg:sr-only">
                <span className="flex items-center gap-[5px]">
                  <IconClock />
                  {s.duration_min} min
                </span>
                <span className="text-[15px] font-semibold text-pb-ink">{price}</span>
              </span>
              {isSel ? <span className="sr-only">Seleccionado</span> : null}
            </button>
          </div>
          <div className="flex flex-none items-center gap-5 lg:[grid-area:side]">
            <span aria-hidden className="hidden min-w-[104px] flex-col items-end gap-0.5 text-right [font-variant-numeric:tabular-nums] lg:flex">
              <span className="text-[17px] font-semibold leading-tight text-pb-ink">{price}</span>
              <span className="flex items-center gap-[5px] text-[13.5px] text-pb-muted">
                <IconClock />
                {s.duration_min} min
              </span>
            </span>
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
        </div>
        {/* Rating + alternative: stacked on the phone, one reserved line on a laptop. */}
        <div className={`${s.rating || altHint ? "flex" : "hidden lg:flex"} flex-col items-start gap-2 lg:min-h-6 lg:flex-row lg:items-center lg:gap-3 lg:[grid-area:meta]`}>
          {s.rating ? <RatingButton rating={s.rating} label={s.name} onOpen={(t) => onOpenReviews(s, t)} /> : null}
          {altHint ? (
            <span className="text-[13px] leading-[1.4] text-pb-muted [font-variant-numeric:tabular-nums] lg:truncate">
              {alt.target.name}: +{priceLabelCOP(String(alt.delta))}
              {alt.target.duration_min !== s.duration_min ? ` · ${alt.target.duration_min > s.duration_min ? "+" : "−"}${Math.abs(alt.target.duration_min - s.duration_min)} min` : ""}
            </span>
          ) : null}
        </div>
        {s.description ? (
          <div className="flex flex-col lg:flex-row lg:items-center lg:gap-2 lg:[grid-area:desc]">
            <p id={descId} className={`m-0 whitespace-pre-line text-[14px] leading-[1.45] text-pb-tx2 [overflow-wrap:anywhere] lg:min-w-0 lg:flex-1 ${expanded ? "" : "line-clamp-2"} lg:line-clamp-1`}>
              {s.description}
            </p>
            {more ? (
              <button type="button" aria-expanded={expanded} aria-controls={descId} onClick={() => setExpanded((x) => !x)} className={`${LINK_BTN} -mb-2.5 -ml-2 -mt-1.5 self-start lg:hidden`}>
                {expanded ? "Ver menos" : "Ver más"}
                <span className="sr-only"> sobre {s.name}</span>
              </button>
            ) : null}
            <button
              type="button"
              aria-haspopup="dialog"
              onClick={(e) => onOpenDetail(s.id, e.currentTarget)}
              // Not LINK_BTN: its `inline-flex` would override `hidden` below lg.
              className="-my-3 hidden min-h-[44px] flex-none items-center rounded-[12px] px-2 text-[14px] text-pb-ink underline underline-offset-[3px] lg:inline-flex"
            >
              Ver más
              <span className="sr-only"> sobre {s.name}</span>
            </button>
          </div>
        ) : (
          <span aria-hidden className="hidden h-5 lg:block lg:[grid-area:desc]" />
        )}
        {/* Phone/tablet: the alternative stays inside the card (natural height). */}
        {offerBox ? <div className="lg:hidden">{offerBox}</div> : null}
      </div>
      {/* Laptop: outside the fixed-height card, so choosing never deforms it. */}
      {offerBox ? <div className="hidden lg:block">{offerBox}</div> : null}
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

/**
 * The full detail of a service (laptop "Ver más"): everything the card shortens, in a
 * native modal <dialog> — focus is trapped, Escape / the backdrop / "Cerrar" close it, and
 * focus returns to the "Ver más" that opened it. Opening it never selects; "Elegir este
 * servicio" is a separate, explicit action. Prices, durations and names are the card's.
 */
function ServiceDetailDialog({
  service: s,
  all,
  selected,
  onSelect,
  onClose,
  returnFocusTo,
}: {
  service: (ServiceOption & PageService) | null;
  all: Array<ServiceOption & PageService>;
  selected: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
  returnFocusTo: HTMLElement | null;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const open = Boolean(s);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      trigger.current = returnFocusTo;
      d.showModal();
      closeBtn.current?.focus();
    } else if (!open && d.open) {
      d.close();
      const t = trigger.current;
      trigger.current = null;
      t?.focus();
    }
  }, [open, returnFocusTo]);
  const alt = s ? upgradeOffer(s, all) : null;
  const isSel = Boolean(s && selected === s.id);
  return (
    <dialog
      ref={ref}
      className="pb-dialog pb-sheet"
      aria-labelledby="pb-svc-detail-name"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {s ? (
        <>
          <div className="flex flex-none items-start justify-between gap-3 px-5 pb-2 pt-5">
            <div className="flex min-w-0 flex-col gap-1.5">
              {s.recommended ? <span className="self-start rounded-full bg-pb-peach px-2 py-0.5 text-[12px] font-[590] text-pb-peach-fg">Recomendado</span> : null}
              <h2 id="pb-svc-detail-name" className={`${SERIF} m-0 text-[28px] leading-[1.1] [overflow-wrap:anywhere] [text-wrap:balance]`}>
                {s.name}
              </h2>
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1 [font-variant-numeric:tabular-nums]">
                <span className="text-[17px] font-semibold text-pb-ink">{priceLabelCOP(s.price) ?? "Precio a consultar"}</span>
                <span className="flex items-center gap-[5px] text-[14px] text-pb-muted">
                  <IconClock />
                  {s.duration_min} min
                </span>
                {s.rating ? (
                  <span className="flex items-center gap-1 text-[14px] text-pb-tx2" aria-label={`${ratingText(s.rating.average)} de 5, ${reviewCountText(s.rating.count)}`}>
                    <IconStar size={14} />
                    <span aria-hidden>
                      <span className="font-semibold text-pb-ink">{ratingText(s.rating.average)}</span> <span className="text-pb-muted">({s.rating.count})</span>
                    </span>
                  </span>
                ) : null}
              </span>
            </div>
            <button
              ref={closeBtn}
              type="button"
              aria-label="Cerrar"
              onClick={onClose}
              className="flex size-11 flex-none items-center justify-center rounded-full border border-pb-line2 bg-white p-0 text-pb-ink"
            >
              <IconClose />
            </button>
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 pb-4 pt-2">
            {s.description ? <p className="m-0 max-w-[60ch] whitespace-pre-line text-[15.5px] leading-[1.6] text-pb-body [overflow-wrap:anywhere]">{s.description}</p> : null}
            {s.includes.length > 0 ? (
              <div className="flex flex-col gap-1.5">
                <h3 className="m-0 text-[14px] font-[590]">Qué incluye</h3>
                <ul className="m-0 flex list-none flex-col gap-1 p-0">
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
            {alt ? (
              <p className="m-0 flex items-start gap-2 rounded-[12px] bg-pb-sf2 p-3 text-[14px] leading-[1.45] text-pb-body [font-variant-numeric:tabular-nums]">
                <span className="mt-0.5 text-pb-tx2">
                  <IconUp />
                </span>
                <span>
                  También existe <span className="font-[590]">{alt.target.name}</span>: {priceLabelCOP(String(alt.delta))} más · {alt.target.duration_min} min.
                </span>
              </p>
            ) : null}
          </div>
          <div className="flex flex-none flex-wrap justify-end gap-2.5 border-t border-pb-line bg-white px-5 pb-[calc(14px+env(safe-area-inset-bottom))] pt-3">
            <button type="button" onClick={onClose} className={BTN_SECONDARY_LG}>
              Cerrar
            </button>
            <button
              type="button"
              aria-pressed={isSel}
              onClick={() => {
                onSelect(s.id);
                onClose();
              }}
              className={chooseBtn(isSel)}
            >
              {isSel ? (
                <>
                  <IconCheck size={16} stroke="#111316" width={2.2} />
                  Elegido
                </>
              ) : (
                "Elegir este servicio"
              )}
            </button>
          </div>
        </>
      ) : null}
    </dialog>
  );
}

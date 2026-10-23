"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { HoursScreen } from "./schedule/HoursScreen";
import { DAYS, DAY_LABELS, gridFromWeekly, HoursGrid, weeklyFromGrid, type HourGrid } from "./HoursGrid";
import { BookingLinkCard } from "./BookingLinkCard";
import { ServiceMenu } from "./services/ServiceMenu";
import { BookingPageScreen } from "./settings/BookingPageScreen";
import { SitesScreen } from "./settings/SitesScreen";
import { RulesScreen } from "./settings/RulesScreen";
import { PromotionsSection, type PromotionAdminRow } from "./promotions/PromotionsSection";
import { ConfigMobile } from "./mobile/config/ConfigMobile";
import {
  activateServiceAction,
  activateSiteAction,
  activateStaffAction,
  countUpcomingAppointmentsAction,
  createExceptionAction,
  deactivateServiceAction,
  deactivateSiteAction,
  deactivateStaffAction,
  deleteExceptionAction,
  updateSiteAction,
} from "@/lib/schedulingAdminActions";
import { PageShell } from "@/components/ui/PageShell";
import { checksProgress, servicesSummaryHelper, servicesSummaryTitle } from "@/lib/schedulingOverview";
import { OVERLAY_SCRIM, useTrappedPanel } from "@/components/ui/Overlay";
import { effectivePublicReason, PublicReasonField } from "./timeoff/PublicReasonField";
import { PUBLIC_REASON_LABEL, type PublicAbsenceReason } from "@/lib/publicAbsenceReason";
import { ABSENCES_ANCHOR, schedulingHref, type SchedulingPage } from "@/lib/schedulingNav";
import { diagnoseDay, fmtSpans, nextDateOf, type BreakInput, type DayKey, type WeeklyRanges } from "@/lib/availabilityDiagnosis";
import { listScheduleSeriesAction } from "@/lib/scheduleSeriesActions";
import { todayAtSite } from "@/lib/siteCalendar";

type WeeklyHours = Record<string, Array<{ start: string; end: string }>>;

interface SchedulingConfig {
  slot_interval_min: number;
  min_notice_min: number;
  booking_horizon_days: number;
  default_buffer_before_min: number;
  default_buffer_after_min: number;
}
export interface Site {
  id: string; client_id: string; slug: string; name: string; address: string | null; timezone: string; active: boolean;
  /** Booking page contact (migration 1804): E.164 WhatsApp and a Google Maps link. */
  public_whatsapp?: string | null;
  public_maps_url?: string | null;
  /** The site's configured weekly opening hours (C-6 — shown + editable). */
  opening_hours: WeeklyHours;
  /** min notice / booking horizon / slot granularity (+ default buffers). Config-only until
   *  now — shown + editable so an operator can see why availability starts N min from now. */
  scheduling_config: SchedulingConfig;
}
export interface Service {
  id: string; name: string; description: string | null; duration_min: number;
  price: string | null; buffer_before_min: number; buffer_after_min: number; active: boolean;
  /** Operator-chosen "offer this first" flag — the assistant leads with featured services. */
  featured: boolean;
  /** The colour family the agenda paints this service with; null = unclassified, and
   *  the agenda falls back to guessing from the name. */
  category: string | null;
  /** Booking-page presentation (migration 1804) — never affects the agenda or the bot. */
  public_category_id?: string | null;
  public_visible?: boolean;
  public_sort?: number;
  public_recommended?: boolean;
  public_image_url?: string | null;
  public_includes?: string[] | null;
  public_upgrade_service_id?: string | null;
}
/** One of the business's own groups on the booking page (migration 1804). */
export interface BookingCategory {
  id: string;
  name: string;
  tagline: string | null;
  layout: "list" | "featured" | "contact";
  sort_order: number;
  visible: boolean;
  service_count: number;
}
export interface Staff {
  id: string; site_id: string; name: string; active: boolean; serviceIds: string[];
  /** Holds a chair: only these are offered on the booking page and by the engine. */
  takes_bookings?: boolean;
  /** Per-staff weekly working hours; {} means "inherit the site's opening hours" (C-6). */
  working_hours: WeeklyHours;
}

export interface Exception {
  id: string;
  site_id: string;
  staff_id: string | null;
  starts_at: string;
  ends_at: string;
  /** INTERNAL note (team only). */
  reason: string | null;
  /** What a customer may be told (migration 1803); null = nothing. */
  public_reason?: PublicAbsenceReason | null;
}

/**
 * Control heights are RESPONSIVE by design-system rule: 44px wherever the input is a
 * finger (phone and portrait tablet, i.e. below `lg`), the compact 34–36px desktop size
 * from `lg` up. Writing it into these three constants is what keeps every form in this
 * file consistent — settings is almost entirely inputs and buttons.
 *
 * The heights are in PX, not Tailwind's rem steps, on purpose. This app sets a 14.4px
 * root font size, so the rem scale is 0.9×: `h-11` measures 39.6px and `h-9` measures
 * 32.4px — both miss the spec, silently, in a way no one would spot by reading the
 * class name. Absolute px is the only way these numbers mean what they say.
 */
const INPUT = "h-[44px] lg:h-[36px] rounded-lg border border-line-strong bg-surface px-3 text-sm text-foreground outline-none transition focus:border-foreground disabled:bg-subtle disabled:text-faint";
const BTN = "inline-flex h-[44px] lg:h-[36px] items-center justify-center rounded-lg bg-foreground px-3.5 text-sm font-medium text-background transition hover:opacity-90 disabled:opacity-50";
const GHOST = "inline-flex h-[44px] lg:h-[34px] items-center justify-center rounded-lg border border-line px-3 lg:px-2.5 text-xs text-muted transition hover:bg-subtle hover:text-foreground";
/** What each page is for, in the business's words (the H1 + its one-line purpose). */
const PAGE_META: Record<SchedulingPage, { title: string; description: string }> = {
  sites: { title: "Sedes", description: "Dónde atiendes: nombre, dirección, URL pública y zona horaria de cada sede." },
  rules: { title: "Reglas de reserva", description: "Con cuánta anticipación y hasta cuándo se puede reservar, y cada cuánto se ofrecen horarios." },
  hours: { title: "Horarios y ausencias", description: "Cuándo atiende cada sede y cada profesional, y los cierres o ausencias puntuales." },
  services: { title: "Servicios", description: "Lo que se reserva: duración, precio, profesionales y sedes de cada servicio." },
  promotions: { title: "Promociones", description: "Condiciones y beneficios de tus ofertas sobre los servicios." },
  "booking-page": { title: "Página de reservas", description: "Lo que ve tu cliente: enlace público, datos de contacto, categorías y orden del catálogo." },
};

/** The phone screen (old `?m=`) that opens each page, when the phone has one. */
function mobileEntryFor(page: SchedulingPage): string | null {
  if (page === "sites") return "sedes";
  if (page === "services") return "servicios";
  if (page === "rules") return "reglas";
  if (page === "hours") return "horarios";
  return null;
}

export interface SchedulingSettingsProps {
  page: SchedulingPage;
  clientId: string;
  clientName: string;
  sites: Site[];
  services: Service[];
  staff: Staff[];
  exceptions: Exception[];
  /** Ended in the last 90 days — only the phone's "Pasados" tab reads it. */
  pastExceptions?: Exception[];
  /** REAL per-site enablement (site_services): siteId → enabled serviceIds. */
  siteServiceMap: Record<string, string[]>;
  /** Whether this client can host public booking right now (non-default + module on) —
   *  drives the "Enlace de reservas" status. */
  schedulingEnabled?: boolean;
  /** The business's booking-page categories (migration 1804). */
  bookingCategories?: BookingCategory[];
  /** The business's promotions (migration 1805), as the editor opens them. */
  promotions?: PromotionAdminRow[];
  /** «Horarios y ausencias»: may open a professional's ficha (team.manage). */
  canTeam?: boolean;
}

/**
 * Per-CLIENT scheduling settings, ONE page per job. This used to be «Configuración de
 * agenda» — seven tabs in React state, so nothing could link into them. Each job now has
 * its own route (lib/schedulingNav.ts) and renders the SAME editors as before: nothing
 * here is a second copy of a form. Every mutation carries the route's `clientId`, which
 * the server actions re-validate (tenant + client + non-default + scheduling enabled +
 * resource ownership); every page is gated by the same server check as the old screen.
 */
export function SchedulingSettings(props: SchedulingSettingsProps) {
  const {
    page,
    clientId,
    clientName,
    sites,
    services,
    staff,
    exceptions,
    pastExceptions = [],
    siteServiceMap,
    schedulingEnabled = true,
    bookingCategories = [],
    promotions = [],
  } = props;
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const run: Run = (fn, onOk) => {
    setError(null);
    startTransition(async () => {
      const r = await fn();
      if (!r.ok) setError(r.error ?? "No se pudo guardar el cambio.");
      else {
        onOk?.();
        router.refresh();
      }
    });
  };

  const meta = PAGE_META[page];
  const entry = mobileEntryFor(page);

  return (
    <>
      {/* PHONE (< 768px): pages that have a phone screen open it directly; its back goes
          to the agenda (there is no «Inicio» of settings any more). Pages without one
          render the same responsive desktop editors below. */}
      {entry ? (
        <ConfigMobile
          clientId={clientId}
          clientName={clientName}
          sites={sites}
          services={services}
          staff={staff}
          exceptions={exceptions}
          pastExceptions={pastExceptions}
          siteServiceMap={siteServiceMap}
          schedulingEnabled={schedulingEnabled}
          entry={entry}
          exitHref={`/clients/${clientId}/scheduling/agenda`}
        />
      ) : null}
      {/* Redesigned module pages draw their OWN continuous surface (components/ui/module):
          header, toolbar, side menu and content in one card, no header card above it. */}
      {page === "sites" || page === "rules" ? (
        <div className={`${entry ? "hidden md:flex" : "flex"} min-h-0 w-full flex-1 flex-col`}>
          {page === "sites" ? (
            <SitesScreen clientId={clientId} sites={sites} services={services} staff={staff} exceptions={exceptions} siteServiceMap={siteServiceMap} />
          ) : (
            <RulesScreen clientId={clientId} sites={sites} />
          )}
        </div>
      ) : page === "booking-page" ? (
        <div className="flex min-h-0 w-full flex-1 flex-col">
          <BookingPageScreen
            clientId={clientId}
            sites={sites}
            services={services}
            staff={staff}
            siteServiceMap={siteServiceMap}
            schedulingEnabled={schedulingEnabled}
            bookingCategories={bookingCategories}
            promotions={promotions}
          />
        </div>
      ) : page === "promotions" ? (
        <div className="flex min-h-0 w-full flex-1 flex-col">
          <PromotionsSection
            clientId={clientId}
            promotions={promotions}
            services={services.filter((x) => x.active).map((x) => ({ id: x.id, name: x.name }))}
            staff={staff.filter((x) => x.active).map((x) => ({ id: x.id, name: x.name, site_id: x.site_id }))}
            sites={sites.filter((x) => x.active).map((x) => ({ id: x.id, name: x.name }))}
          />
        </div>
      ) : page === "hours" ? (
        <div className={`${entry ? "hidden md:flex" : "flex"} min-h-0 w-full flex-1 flex-col`}>
          <HoursScreen
            clientId={clientId}
            sites={sites as never}
            staff={staff as never}
            exceptions={exceptions as never}
            pastExceptions={(pastExceptions ?? []) as never}
            canTeam={props.canTeam ?? false}
            footer={<WhyNothingAvailable clientId={clientId} sites={sites} staff={staff} />}
          />
        </div>
      ) : page === "services" ? (
        <div className={`${entry ? "hidden md:flex" : "flex"} min-h-0 w-full flex-1 flex-col`}>
          <ServiceMenu
            clientId={clientId}
            sites={sites}
            services={services}
            staff={staff}
            siteServiceMap={siteServiceMap}
            bookingCategories={bookingCategories}
            showBookingCategories={false}
            onOpenBookingLink={() => router.push(schedulingHref(clientId, "booking-page"))}
            agendaHref={`/clients/${clientId}/scheduling/agenda`}
          />
        </div>
      ) : (
      <main className={`${entry ? "hidden md:flex" : "flex"} min-h-0 w-full flex-1 flex-col gap-[var(--content-pad)]`}>
        {/* The production header card of «Configuración de agenda», titled by this page's
            job — without its tab row: the sidebar is the only menu now. */}
        <PageShell grow={false} clip={false}>
          <div className="px-4 py-3 sm:px-5">
            <div className="flex min-h-11 flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-baseline gap-2.5">
                  <h1 className="truncate text-xl font-semibold tracking-[-0.025em] text-foreground">{meta.title}</h1>
                  <span className="truncate text-xs text-muted">{clientName}</span>
                </div>
                <p className="mt-0.5 hidden text-xs text-muted sm:block">{meta.description}</p>
              </div>
              <Link href={`/clients/${clientId}/scheduling/agenda`} className="inline-flex h-[44px] items-center rounded-lg border border-line-strong px-3.5 text-sm font-medium text-foreground hover:bg-subtle lg:h-[36px]">
                Ver agenda
              </Link>
            </div>
          </div>
        </PageShell>
        {error ? <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p> : null}
        <PageShell className="overflow-y-auto" ariaLabel={meta.title}>
          <div className="flex min-h-full w-full flex-col gap-2.5 p-3 sm:p-4">
            {page === "hours" ? (
              <>
                <Section
                  title="Horario de la sede"
                  description="Los días y horas en que cada sede atiende. Un profesional sin horario propio trabaja en este mismo horario."
                >
                  <SiteWorkbench clientId={clientId} sites={sites} run={run} pending={pending} part="hours" schedulingEnabled={schedulingEnabled} siteServiceMap={siteServiceMap} />
                </Section>
                <StaffAvailability clientId={clientId} sites={sites} staff={staff} exceptions={exceptions} />
                {/* «Ausencias» — the production «Bloqueos» list, unchanged; the old
                    Excepciones/Bloqueos links land here (lib/schedulingNav.ts). */}
                <div id={ABSENCES_ANCHOR} className="scroll-mt-4">
                  <ExceptionsSection clientId={clientId} sites={sites} staff={staff} exceptions={exceptions} run={run} pending={pending} />
                </div>
                <WhyNothingAvailable clientId={clientId} sites={sites} staff={staff} />
              </>
            ) : null}
          </div>
        </PageShell>
      </main>
      )}
    </>
  );
}

export function SettingsOverview({
  clientId,
  sites,
  services,
  staff,
  exceptions,
  siteServiceMap,
  onNewSite,
}: {
  clientId: string;
  sites: Site[];
  services: Service[];
  staff: Staff[];
  exceptions: Exception[];
  siteServiceMap: Record<string, string[]>;
  /** «+ Nueva sede» opens the create dialog of the Sedes list on this same page. */
  onNewSite: () => void;
}) {
  const hrefSites = schedulingHref(clientId, "sites");
  const hrefServices = schedulingHref(clientId, "services");
  const hrefHours = schedulingHref(clientId, "hours");
  const hrefBlocks = schedulingHref(clientId, "hours", undefined, ABSENCES_ANCHOR);
  const activeSites = sites.filter((site) => site.active);
  const activeServices = services.filter((service) => service.active);
  const activeStaff = staff.filter((member) => member.active);
  const ready = activeSites.length > 0 && activeServices.length > 0 && activeStaff.length > 0;
  const doneSteps = [activeSites.length > 0, activeServices.length > 0, activeStaff.length > 0].filter(Boolean).length;

  /** The soonest upcoming block, so the card says WHEN and not just how many. */
  const nextBlock = [...exceptions].sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at))[0];
  const nextBlockSite = nextBlock ? sites.find((site) => site.id === nextBlock.site_id) : undefined;

  const summaries: Array<{ label: string; value: number; helper: string; title?: string; href: string }> = [
    {
      label: "Sedes activas",
      value: activeSites.length,
      helper: activeSites.length === 0
        ? "Ninguna recibe reservas"
        : [activeSites.slice(0, 2).map((site) => site.name).join(" · "), sites.length - activeSites.length > 0 ? `${sites.length - activeSites.length} inactiva${sites.length - activeSites.length === 1 ? "" : "s"}` : null]
            .filter(Boolean)
            .join(" · "),
      href: hrefSites,
    },
    {
      label: "Servicios activos",
      value: activeServices.length,
      // STORED categories, as the Servicios tab groups them; the tooltip spells out the
      // agenda's inferred colours and that ★ is the flag. See schedulingOverview.ts.
      helper: servicesSummaryHelper(activeServices),
      title: servicesSummaryTitle(activeServices),
      href: hrefServices,
    },
    {
      label: "Profesionales",
      value: activeStaff.length,
      helper: `${staff.length} en el equipo`,
      href: `/clients/${clientId}/scheduling/staff`,
    },
    {
      label: "Bloqueos próximos",
      value: exceptions.length,
      helper: nextBlock
        ? `El más cercano el ${fmtBlockDay(nextBlock.starts_at, nextBlockSite?.timezone ?? "UTC")}`
        : "Sin vacaciones ni cierres",
      href: hrefBlocks,
    },
  ];

  /**
   * PROBLEMS, not just ticks. The reference's checklist names what is actually wrong and
   * offers the fix beside it; a list of green checks tells an operator nothing about why
   * a day shows no availability. Every entry below is computed from data already loaded
   * — nothing here is a placeholder for a check we cannot run.
   */
  const staffWithoutServices = activeStaff.filter((member) => member.serviceIds.length === 0);
  const servicesWithoutSite = activeServices.filter(
    (service) => !activeSites.some((site) => (siteServiceMap[site.id] ?? []).includes(service.id)),
  );
  const sitesWithoutHours = activeSites.filter(
    (site) => !DAYS.some((day) => (site.opening_hours?.[day]?.length ?? 0) > 0),
  );

  type Row = {
    label: string;
    helper: string;
    state: "ok" | "todo" | "warn";
    action?: { label: string; href: string };
  };
  const rows: Row[] = [
    {
      label: "Sedes y horario de atención",
      helper: activeSites.length === 0
        ? "Crea o activa una sede para recibir reservas"
        : `${activeSites.length} sede${activeSites.length === 1 ? "" : "s"} activa${activeSites.length === 1 ? "" : "s"}`,
      state: activeSites.length === 0 ? "todo" : "ok",
      action: { label: "Revisar", href: hrefHours },
    },
    {
      label: "Catálogo de servicios",
      helper: activeServices.length === 0
        ? "Define al menos un servicio reservable"
        : `${activeServices.length} servicio${activeServices.length === 1 ? "" : "s"} con duración y precio`,
      state: activeServices.length === 0 ? "todo" : "ok",
      action: { label: "Revisar", href: hrefServices },
    },
    {
      label: "Equipo que recibe reservas",
      helper: activeStaff.length === 0
        ? "Activa al menos un profesional"
        : `${activeStaff.length} profesional${activeStaff.length === 1 ? "" : "es"} activo${activeStaff.length === 1 ? "" : "s"}`,
      state: activeStaff.length === 0 ? "todo" : "ok",
      action: { label: "Revisar", href: `/clients/${clientId}/scheduling/staff` },
    },
  ];
  if (sitesWithoutHours.length > 0) {
    rows.push({
      label: "Horario semanal",
      helper: `${sitesWithoutHours.map((site) => site.name).join(", ")} sin días abiertos`,
      state: "warn",
      action: { label: "Definir", href: hrefHours },
    });
  }
  if (staffWithoutServices.length > 0) {
    rows.push({
      label: "Servicios por profesional",
      helper: `${staffWithoutServices.map((member) => member.name).join(", ")} sin servicios habilitados`,
      state: "warn",
      action: { label: "Asignar", href: `/clients/${clientId}/scheduling/staff` },
    });
  }
  if (servicesWithoutSite.length > 0) {
    rows.push({
      label: "Servicios sin sede",
      helper: `${servicesWithoutSite.length} servicio${servicesWithoutSite.length === 1 ? "" : "s"} activo${servicesWithoutSite.length === 1 ? "" : "s"} no se ofrece en ninguna sede`,
      state: "warn",
      action: { label: "Habilitar", href: hrefServices },
    });
  }
  rows.push({
    label: "Reservas en línea",
    helper: ready ? "La agenda ya puede generar horarios reservables" : "Se habilita al completar los pasos anteriores",
    state: ready ? "ok" : "todo",
  });

  const openProblems = rows.filter((row) => row.state !== "ok").length;
  // The badge counts the checks LISTED below, so it never reads "3 / 3" over four ticks.
  const progress = checksProgress(rows);

  return (
    <>
      <div className="grid shrink-0 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        {summaries.map((item) => {
          const body = (
            <>
              <span className="text-[0.6875rem] text-muted">{item.label}</span>
              <strong className="mt-1 block text-[1.375rem] font-semibold leading-tight tracking-[-0.01em] text-foreground">{item.value}</strong>
              <span title={item.title} className="mt-1 block truncate text-[0.6875rem] text-faint">{item.helper}</span>
            </>
          );
          return (
            <Link key={item.label} href={item.href} className="min-w-0 rounded-xl border border-line bg-surface px-3.5 py-3 transition hover:border-line-strong hover:bg-subtle/40">{body}</Link>
          );
        })}
      </div>

      <div className="grid min-h-0 flex-1 gap-2.5 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-line bg-surface">
          <div className="flex shrink-0 items-center gap-2.5 border-b border-line px-4 py-3">
            <h2 className="text-sm font-semibold text-foreground">Estado de la configuración</h2>
            <span className="u-mono rounded-md border border-line bg-chip px-1.5 py-0.5 text-[0.6875rem] text-muted">{progress.done} / {progress.total}</span>
            <span className="flex-1" />
            <span className="truncate text-[0.6875rem] text-muted">
              {ready
                ? openProblems === 0 ? "Todo listo para recibir reservas" : `${openProblems} punto${openProblems === 1 ? "" : "s"} por revisar`
                : `Faltan ${3 - doneSteps} paso${3 - doneSteps === 1 ? "" : "s"} para reservar en línea`}
            </span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-1">
            {rows.map((row, index) => (
              <div key={row.label} className={`flex items-center gap-2.5 py-2.5 ${index > 0 ? "border-t border-line-soft" : ""}`}>
                {row.state === "ok" ? (
                  <span aria-hidden className="flex size-5 shrink-0 items-center justify-center rounded-full bg-success/10 text-[0.625rem] text-success">✓</span>
                ) : (
                  <span aria-hidden className={`flex size-5 shrink-0 items-center justify-center rounded-full text-[0.625rem] font-semibold ${row.state === "warn" ? "bg-warn-soft text-warn" : "bg-chip text-faint"}`}>!</span>
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[0.8125rem] font-medium text-foreground">{row.label}</p>
                  <p className={`truncate text-[0.6875rem] ${row.state === "warn" ? "text-warn" : "text-muted"}`}>{row.helper}</p>
                </div>
                {row.action ? (
                  <Link href={row.action.href} className={GHOST}>{row.action.label}</Link>
                ) : (
                  <span className="shrink-0 text-[0.6875rem] text-faint">{ready ? "Activo" : "Bloqueado"}</span>
                )}
              </div>
            ))}
          </div>
        </section>

        <div className="flex min-h-0 flex-col gap-2.5">
          <section className="shrink-0 rounded-xl border border-line bg-surface px-4 py-3">
            <h2 className="u-th">Acciones rápidas</h2>
            {/* Compact chips, not a stack of full-width rows: shortcuts into the pages
                that own each job, and at row width they read as the primary content. */}
            <div className="mt-2.5 flex flex-wrap gap-2">
              <button type="button" onClick={onNewSite} className="inline-flex h-[44px] items-center rounded-lg bg-foreground px-3 text-xs font-medium text-background transition hover:opacity-90 lg:h-[32px]">+ Nueva sede</button>
              <Link href={hrefServices} className="inline-flex h-[44px] items-center rounded-lg border border-line-strong bg-surface px-3 text-xs transition hover:bg-subtle lg:h-[32px]">Servicios</Link>
              <Link href={hrefBlocks} className="inline-flex h-[44px] items-center rounded-lg border border-line-strong bg-surface px-3 text-xs transition hover:bg-subtle lg:h-[32px]">+ Nuevo bloqueo</Link>
              <Link href={`/clients/${clientId}/scheduling/staff`} className="inline-flex h-[44px] items-center rounded-lg border border-line-strong bg-surface px-3 text-xs transition hover:bg-subtle lg:h-[32px]">Gestionar equipo</Link>
            </div>
          </section>
        </div>
      </div>
    </>
  );
}

/** A block's day, in the timezone of the SITE it closes. */
function fmtBlockDay(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("es-CO", { day: "numeric", month: "short", timeZone }).format(new Date(iso)).replace(".", "");
}

/**
 * "Why is nothing available?" — a read-only summary of the EFFECTIVE recurring config for
 * a chosen site + weekday: is the site open, and which staff work that day (a staff member
 * with no working hours inherits the site's). Derived entirely from data already loaded.
 * One-off blocks are in the Exceptions section below. Turns "the bot says nothing is free"
 * into a five-second check.
 */
export function WhyNothingAvailable({ clientId, sites, staff }: { clientId: string; sites: Site[]; staff: Staff[] }) {
  const active = sites.filter((s) => s.active);
  const [siteId, setSiteId] = useState(active[0]?.id ?? "");
  const [dow, setDow] = useState<string>("mon");
  // The site's usual breaks (break series), tagged with the site they belong to.
  const [breakState, setBreaks] = useState<{ siteId: string; list: BreakInput[] }>({ siteId: "", list: [] });
  useEffect(() => {
    if (!siteId) return;
    let alive = true;
    listScheduleSeriesAction(clientId, siteId)
      .then((r) => alive && setBreaks({ siteId, list: r.ok ? r.series.filter((x) => x.kind === "break") : [] }))
      .catch(() => alive && setBreaks({ siteId, list: [] }));
    return () => {
      alive = false;
    };
  }, [clientId, siteId]);
  const site = sites.find((s) => s.id === siteId);
  if (!site) return null;

  // Every range of the day and every break — the same inputs the engine reads (finding E).
  const day = diagnoseDay({
    dow: dow as DayKey,
    date: nextDateOf(dow as DayKey, todayAtSite(site.timezone)),
    siteHours: (site.opening_hours ?? {}) as WeeklyRanges,
    staff: staff.filter((st) => st.site_id === siteId).map((st) => ({ id: st.id, name: st.name, active: st.active, working_hours: (st.working_hours ?? null) as WeeklyRanges | null })),
    breaks: breakState.siteId === siteId ? breakState.list : [],
  });
  const siteOpen = day.siteSpans.length > 0;
  const working = day.working;
  const allStaffInactive = day.allStaffInactive;

  const notice = site.scheduling_config.min_notice_min;
  const noticeHours = Math.floor(notice / 60);
  const noticeMins = notice % 60;
  const noticeText = notice === 0
    ? "Se permiten reservas inmediatas"
    : noticeHours > 0
      ? `${noticeHours} h${noticeMins ? ` ${noticeMins} min` : ""} de anticipación mínima`
      : `${noticeMins} min de anticipación mínima`;

  /**
   * The reference's "Diagnóstico de disponibilidad": one row per reason a day can come
   * back empty, each with a status dot that says whether it is a problem. Green means
   * "this is not why"; amber means "this is why". Every row is derived from the site and
   * staff config already loaded — there is no inference and no sampling.
   */
  const findings: Array<{ ok: boolean; title: string; detail: string }> = [
    siteOpen
      ? { ok: true, title: `Abierta ${fmtSpans(day.siteSpans)}`, detail: `${site.name} · ${DAY_LABELS[dow]}` }
      : { ok: false, title: "La sede no abre este día", detail: `${site.name} · ${DAY_LABELS[dow]} sin horario` },
    ...(siteOpen && day.siteBreaks.length > 0
      ? [{ ok: true, title: `Pausa de la sede ${fmtSpans(day.siteBreaks)}`, detail: "Nadie recibe citas en ese tramo" }]
      : []),
    working.length > 0
      ? {
          ok: true,
          title: `${working.length} profesional${working.length === 1 ? "" : "es"} trabaja${working.length === 1 ? "" : "n"} este día`,
          detail: working.map((st) => `${st.name} ${fmtSpans(st.spans)}${st.breaks.length ? ` (pausa ${fmtSpans(st.breaks)})` : ""}`).join(" · "),
        }
      : allStaffInactive
        ? { ok: false, title: "Todo el equipo de esta sede está inactivo", detail: "Reactiva a alguien para volver a recibir reservas" }
        : { ok: false, title: "Nadie trabaja este día", detail: "Ningún profesional tiene horario para esta jornada" },
    {
      ok: true,
      title: noticeText,
      detail: `${site.scheduling_config.booking_horizon_days} días de horizonte · cupos cada ${site.scheduling_config.slot_interval_min} min`,
    },
  ];

  return (
    <section className="flex shrink-0 flex-col overflow-hidden rounded-xl border border-line bg-surface">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-4 py-3">
        <h2 className="text-sm font-semibold text-foreground">Diagnóstico de disponibilidad</h2>
        <span className="flex-1" />
        <select value={siteId} onChange={(e) => setSiteId(e.target.value)} aria-label="Sede a diagnosticar" className={`${INPUT} min-w-0 max-w-[10rem] text-xs`}>
          {active.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select value={dow} onChange={(e) => setDow(e.target.value)} aria-label="Día a diagnosticar" className={`${INPUT} min-w-0 max-w-[7rem] text-xs`}>
          {DAYS.map((d) => <option key={d} value={d}>{DAY_LABELS[d]}</option>)}
        </select>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-1">
        {findings.map((finding, index) => (
          <div key={finding.title} className={`flex items-start gap-2.5 py-2.5 ${index > 0 ? "border-t border-line-soft" : ""}`}>
            <span aria-hidden className={`mt-1.5 size-[7px] shrink-0 rounded-full ${finding.ok ? "bg-success" : "bg-warn-rule"}`} />
            <div className="min-w-0 flex-1">
              <p className="text-[0.8125rem] text-foreground">{finding.title}</p>
              <p className="text-[0.6875rem] text-muted">{finding.detail}</p>
            </div>
          </div>
        ))}
        <p className="border-t border-line-soft py-2.5 text-[0.6875rem] text-faint">
          Las vacaciones, cierres y ausencias puntuales están en{" "}
          <Link href={schedulingHref(clientId, "hours", undefined, ABSENCES_ANCHOR)} className="underline underline-offset-2 hover:text-foreground">Ausencias</Link>.
        </p>
      </div>
    </section>
  );
}

/** Runs a server action with the page's shared error banner + refresh. `onOk` runs after
 *  a successful save (e.g. to clear a form's "unsaved" state). */
export type Run = (fn: () => Promise<{ ok: boolean; error?: string }>, onOk?: () => void) => void;
type ToggleKind = "site" | "service" | "staff";

const DEACTIVATE: Record<ToggleKind, (clientId: string, id: string) => Promise<{ ok: boolean; error?: string }>> = {
  site: deactivateSiteAction,
  service: deactivateServiceAction,
  staff: deactivateStaffAction,
};
const ACTIVATE: Record<ToggleKind, (clientId: string, id: string) => Promise<{ ok: boolean; error?: string }>> = {
  site: activateSiteAction,
  service: activateServiceAction,
  staff: activateStaffAction,
};

/**
 * The state-reflecting Active/Deactivate control (3a + 3d). Deactivation is a
 * forward-looking switch, so:
 *  - INACTIVE → a single "Activate" button (the inverse that was missing — no more
 *    one-way door).
 *  - ACTIVE → "Deactivate"; on click it first counts FUTURE appointments and, when any
 *    exist, shows an inline confirmation stating the count. It never cancels or cascades
 *    — the operator may legitimately be deactivating someone who left; existing
 *    appointments stay and remain visible.
 */
function ActiveToggle({
  clientId, kind, id, name, active, run, pending,
}: {
  clientId: string; kind: ToggleKind; id: string; name: string; active: boolean; run: Run; pending: boolean;
}) {
  const [confirmMsg, setConfirmMsg] = useState<string | null>(null);
  const [checking, startCheck] = useTransition();

  if (!active) {
    return (
      <button className={GHOST} disabled={pending} onClick={() => run(() => ACTIVATE[kind](clientId, id))}>
        Activar
      </button>
    );
  }
  if (confirmMsg) {
    return (
      <ConfirmInline
        label={confirmMsg}
        busy={pending}
        onConfirm={() => { setConfirmMsg(null); run(() => DEACTIVATE[kind](clientId, id)); }}
        onCancel={() => setConfirmMsg(null)}
      />
    );
  }
  const onDeactivate = () => {
    startCheck(async () => {
      const c = await countUpcomingAppointmentsAction(clientId, kind, id);
      const count = c.ok ? c.count : 0;
      if (count > 0) {
        setConfirmMsg(
          `${name} tiene ${count} cita${count === 1 ? "" : "s"} próxima${count === 1 ? "" : "s"}. Al desactivar se detienen nuevas reservas; las citas existentes se conservan.`,
        );
      } else {
        run(() => DEACTIVATE[kind](clientId, id));
      }
    });
  };
  return (
    <button className={GHOST} disabled={pending || checking} onClick={onDeactivate}>
      {checking ? "Comprobando…" : "Desactivar"}
    </button>
  );
}

/** Inline confirmation (mirrors the inbox ConfirmInline) — a warning + Confirm/Cancel,
 *  never a blocking browser dialog. */
function ConfirmInline({ label, busy, onConfirm, onCancel }: { label: string; busy: boolean; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-amber-700 dark:text-amber-400">{label}</span>
      <button type="button" disabled={busy} onClick={onConfirm} className="rounded border border-amber-500/40 px-2 py-0.5 text-[11px] text-amber-700 transition-colors hover:bg-amber-500/10 disabled:opacity-50 dark:text-amber-400">
        {busy ? "Guardando…" : "Desactivar de todos modos"}
      </button>
      <button type="button" onClick={onCancel} className="rounded border border-line px-2 py-0.5 text-[11px] transition-colors hover:bg-subtle">
        Cancelar
      </button>
    </div>
  );
}

function Section({ title, description, action, children }: { title: string; description?: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line pb-3">
        <div>
          <h2 className="text-base font-semibold text-foreground">{title}</h2>
          {description ? <p className="mt-1 text-sm text-muted">{description}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function ConfigModal({
  title,
  description,
  onClose,
  children,
  footer,
  size = "lg",
}: {
  title: string;
  description?: string;
  onClose: () => void;
  children: React.ReactNode;
  footer: React.ReactNode;
  size?: "md" | "lg";
}) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const close = useCallback(() => closeRef.current(), []);
  const panelRef = useTrappedPanel({ active: true, onClose: close });
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-5">
      <button type="button" aria-label={`Cerrar ${title}`} className={OVERLAY_SCRIM} onClick={close} />
      <section
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={`relative z-50 flex max-h-[min(760px,calc(100dvh-2rem))] w-full flex-col overflow-hidden rounded-t-2xl border border-line bg-surface sm:rounded-2xl ${
          size === "md" ? "sm:max-w-2xl" : "sm:max-w-4xl"
        }`}
      >
        <header className="flex shrink-0 items-start gap-4 border-b border-line px-4 py-3.5 sm:px-5">
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-foreground">{title}</h2>
            {description ? <p className="mt-0.5 text-xs text-muted">{description}</p> : null}
          </div>
          <button type="button" onClick={close} aria-label="Cerrar" className="flex size-9 shrink-0 items-center justify-center rounded-lg text-lg text-muted transition hover:bg-subtle hover:text-foreground">×</button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">{children}</div>
        <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-line bg-card/50 px-4 py-3 sm:px-5">
          <button type="button" onClick={close} className="inline-flex h-[44px] items-center justify-center rounded-lg border border-line-strong px-3.5 text-sm font-medium text-foreground transition hover:bg-subtle lg:h-[36px]">Cancelar</button>
          {footer}
        </footer>
      </section>
    </div>
  );
}

/** Copyable id chip — the site id (UUID) that the machine scheduling/CRM API needs as
 * `site_id`. The value is `select-all` (triple-click) AND click-to-copy. */
function CopyId({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard blocked — the select-all text is still the fallback */
    }
  };
  return (
    <button
      type="button"
      onClick={copy}
      title={`Copiar ${label}`}
      className="inline-flex w-fit items-center gap-1.5 rounded border border-line px-1.5 py-0.5 text-[11px] text-muted transition-colors hover:bg-subtle"
    >
      <span className="text-faint">{label}</span>
      <span className="select-all font-mono text-foreground">{value}</span>
      <span className="text-faint">{copied ? "copiado ✓" : "copiar"}</span>
    </button>
  );
}

/** Which slice of a site a page edits. One site row, four owners — each page saves ONLY
 *  its own keys (updateSiteAction takes a partial patch), so editing the hours on
 *  Disponibilidad can never overwrite an address being edited on Sedes. */
export type SitePart = "identity" | "public" | "rules" | "hours";

const PART_HINT: Record<SitePart, string> = {
  identity: "Nombre, URL pública, zona horaria y dirección.",
  public: "Contacto que ve el cliente en la página de reservas y en la confirmación.",
  rules: "Cuándo y con qué frecuencia se ofrecen horarios.",
  hours: "Los días y horas en que esta sede recibe reservas.",
};

/** One site's slice in an editable form, seeded from the stored values. Save persists via
 *  updateSiteAction with ONLY this slice's keys and immediately changes what the booking
 *  page and the engine read. */
function SiteForm({
  clientId,
  site,
  part,
  run,
  pending,
  schedulingEnabled = true,
  serviceCount = 0,
  onDirtyChange,
}: {
  clientId: string;
  site: Site;
  part: SitePart;

  run: Run;
  pending: boolean;
  schedulingEnabled?: boolean;
  serviceCount?: number;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [name, setName] = useState(site.name);
  const [slug, setSlug] = useState(site.slug);
  const [tz, setTz] = useState(site.timezone);
  const [address, setAddress] = useState(site.address ?? "");
  const [whatsapp, setWhatsapp] = useState(site.public_whatsapp ?? "");
  const [mapsUrl, setMapsUrl] = useState(site.public_maps_url ?? "");
  const [grid, setGrid] = useState<HourGrid>(gridFromWeekly(site.opening_hours));
  // min_notice is why "availability starts N minutes from now"; horizon caps how far
  // ahead; slot is the grid of start times.
  const [minNotice, setMinNotice] = useState(String(site.scheduling_config.min_notice_min));
  const [horizon, setHorizon] = useState(String(site.scheduling_config.booking_horizon_days));
  const [slotMin, setSlotMin] = useState(String(site.scheduling_config.slot_interval_min));
  const [saved, setSaved] = useState(false);
  const nums = [minNotice, horizon, slotMin].map((v) => Number(v));
  const numsOk =
    nums.every((n) => Number.isFinite(n) && Number.isInteger(n)) &&
    nums[0] >= 0 && nums[1] >= 1 && nums[2] >= 1;
  const openDays = DAYS.filter((day) => (site.opening_hours?.[day]?.length ?? 0) > 0).length;

  const dirty =
    part === "identity"
      ? name !== site.name || slug !== site.slug || tz !== site.timezone || address !== (site.address ?? "")
      : part === "public"
        ? whatsapp !== (site.public_whatsapp ?? "") || mapsUrl !== (site.public_maps_url ?? "")
        : part === "rules"
          ? minNotice !== String(site.scheduling_config.min_notice_min) ||
            horizon !== String(site.scheduling_config.booking_horizon_days) ||
            slotMin !== String(site.scheduling_config.slot_interval_min)
          : JSON.stringify(weeklyFromGrid(grid)) !== JSON.stringify(weeklyFromGrid(gridFromWeekly(site.opening_hours)));

  // Report "unsaved" to the list (it asks before switching sites) and warn on reload/close.
  const dirtyRef = useRef(onDirtyChange);
  useEffect(() => {
    dirtyRef.current = onDirtyChange;
  });
  useEffect(() => {
    dirtyRef.current?.(dirty);
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const patch = () =>
    part === "identity"
      ? { name: name.trim(), slug: slug.trim(), timezone: tz, address }
      : part === "public"
        ? { publicWhatsapp: whatsapp, publicMapsUrl: mapsUrl }
        : part === "rules"
          ? {
              // Merge over the existing config so the buffers (not shown here) are preserved.
              schedulingConfig: {
                ...site.scheduling_config,
                min_notice_min: Number(minNotice),
                booking_horizon_days: Number(horizon),
                slot_interval_min: Number(slotMin),
              },
            }
          : { openingHours: weeklyFromGrid(grid) };
  const canSave = dirty && !pending && (part !== "identity" || (name.trim() && slug.trim())) && (part !== "rules" || numsOk);
  const save = () => {
    setSaved(false);
    run(() => updateSiteAction(clientId, site.id, patch()), () => setSaved(true));
  };

  return (
    <article className={`overflow-hidden rounded-xl border border-line ${site.active ? "bg-surface" : "bg-subtle/40"}`}>
      <div className="flex flex-wrap items-center gap-3 px-4 py-3.5">
        <span aria-hidden className={`size-2.5 rounded-full ${site.active ? "bg-success" : "bg-faintest"}`} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-foreground">{site.name}</h3>
            <span className="rounded-full bg-chip px-2 py-0.5 text-[0.625rem] font-medium text-muted">{site.active ? "Activa" : "Inactiva"}</span>
          </div>
          <p className="mt-1 truncate text-xs text-muted">
            {openDays} días abiertos · reservas cada {site.scheduling_config.slot_interval_min} min · hasta {site.scheduling_config.booking_horizon_days} días
          </p>
        </div>
        {part === "identity" ? (
          <ActiveToggle clientId={clientId} kind="site" id={site.id} name={site.name} active={site.active} run={run} pending={pending} />
        ) : null}
      </div>

      {part === "public" ? <BookingLinkCard slug={site.slug} siteActive={site.active} schedulingEnabled={schedulingEnabled} serviceCount={serviceCount} /> : null}

      <div className="border-t border-line bg-card/40 p-4">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted">{PART_HINT[part]}</p>
          {part === "identity" ? <CopyId label="ID de sede" value={site.id} /> : null}
        </div>

        {part === "identity" ? (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <Field label="Nombre"><input value={name} onChange={(e) => setName(e.target.value)} className={`${INPUT} w-full`} /></Field>
            <Field label="URL pública" hint="Forma parte del enlace de reservas."><input value={slug} onChange={(e) => setSlug(e.target.value)} className={`${INPUT} w-full`} /></Field>
            <Field label="Zona horaria"><input value={tz} onChange={(e) => setTz(e.target.value)} className={`${INPUT} w-full`} /></Field>
            <Field label="Dirección" hint="Tal como la escribiría el cliente en Maps.">
              <input value={address} maxLength={200} onChange={(e) => setAddress(e.target.value)} className={`${INPUT} w-full`} />
            </Field>
          </div>
        ) : null}

        {part === "public" ? (
          <>
            <dl className="mb-4 grid gap-3 rounded-lg border border-line bg-surface p-3 text-xs sm:grid-cols-3">
              <div className="min-w-0"><dt className="text-muted">Nombre de la sede</dt><dd className="mt-0.5 truncate font-medium text-foreground">{site.name}</dd></div>
              <div className="min-w-0"><dt className="text-muted">Dirección</dt><dd className="mt-0.5 truncate font-medium text-foreground">{site.address || "Sin dirección"}</dd></div>
              <div className="min-w-0"><dt className="text-muted">Horario</dt><dd className="mt-0.5 font-medium text-foreground">{openDays} días abiertos</dd></div>
            </dl>
            <p className="-mt-2 mb-4 text-[0.6875rem] text-faint">
              El nombre y la dirección se editan en{" "}
              <Link href={schedulingHref(clientId, "sites")} className="underline underline-offset-2 hover:text-foreground">Sedes</Link>; el horario, en{" "}
              <Link href={schedulingHref(clientId, "hours")} className="underline underline-offset-2 hover:text-foreground">Horarios y ausencias</Link>.
            </p>
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="WhatsApp del negocio" hint="Con indicativo. Vacío = no se muestra.">
                <input value={whatsapp} inputMode="tel" placeholder="+57 300 123 4567" onChange={(e) => setWhatsapp(e.target.value)} className={`${INPUT} w-full`} />
              </Field>
              <Field label="Enlace de Google Maps" hint="Opcional. Si está vacío, se busca la dirección.">
                <input value={mapsUrl} inputMode="url" placeholder="https://maps.app.goo.gl/…" onChange={(e) => setMapsUrl(e.target.value)} className={`${INPUT} w-full`} />
              </Field>
            </div>
          </>
        ) : null}

        {part === "rules" ? (
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Anticipación mínima (min)" hint="Tiempo mínimo antes de una cita.">
              <input type="number" min={0} value={minNotice} onChange={(e) => setMinNotice(e.target.value)} className={`${INPUT} w-full`} />
            </Field>
            <Field label="Días disponibles hacia adelante" hint="Hasta cuándo puede reservar un cliente.">
              <input type="number" min={1} value={horizon} onChange={(e) => setHorizon(e.target.value)} className={`${INPUT} w-full`} />
            </Field>
            <Field label="Intervalo entre horarios (min)" hint="Separación entre horas de inicio.">
              <input type="number" min={1} value={slotMin} onChange={(e) => setSlotMin(e.target.value)} className={`${INPUT} w-full`} />
            </Field>
          </div>
        ) : null}

        {part === "hours" ? <HoursGrid grid={grid} setGrid={setGrid} /> : null}

        <div className="mt-4 flex flex-wrap items-center justify-end gap-3">
          <span aria-live="polite" className="text-xs text-muted">
            {dirty ? "Cambios sin guardar" : saved ? "Cambios guardados" : ""}
          </span>
          <button className={BTN} disabled={!canSave} onClick={save}>{pending ? "Guardando…" : "Guardar cambios"}</button>
        </div>
      </div>
    </article>
  );
}

/**
 * The list of sites with one site's slice beside it — the layout every site-owned page
 * shares (Sedes, Reglas de reserva, Horario de la sede, Página de reservas). Switching
 * sites with unsaved edits asks first; it used to drop them silently.
 */
function SiteWorkbench({
  clientId,
  sites,
  run,
  pending,
  part,
  schedulingEnabled,
  siteServiceMap,
}: {
  clientId: string;
  sites: Site[];
  run: Run;
  pending: boolean;
  part: SitePart;
  schedulingEnabled: boolean;
  siteServiceMap: Record<string, string[]>;
}) {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(sites[0]?.id ?? "");
  const [dirty, setDirty] = useState(false);
  const [asking, setAsking] = useState<string | null>(null);
  const filteredSites = sites.filter((site) => site.name.toLocaleLowerCase("es").includes(query.trim().toLocaleLowerCase("es")));
  const selectedSite = sites.find((site) => site.id === selectedId) ?? sites[0];
  const pick = (id: string) => {
    if (id === selectedSite?.id) return;
    if (dirty) setAsking(id);
    else setSelectedId(id);
  };

  return (
    <div className="grid min-h-[22rem] overflow-hidden rounded-xl border border-line bg-surface lg:grid-cols-[17rem_minmax(0,1fr)]">
      <aside className="border-b border-line bg-card/40 lg:border-b-0 lg:border-r">
        <div className="border-b border-line p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-foreground">Sedes</h3>
            <span className="u-mono text-xs text-faint">{sites.length}</span>
          </div>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Buscar sede…"
            aria-label="Buscar sede"
            className={`${INPUT} w-full bg-subtle/60`}
          />
        </div>
        <div className="flex max-h-64 flex-col gap-1 overflow-y-auto p-1.5 lg:max-h-[34rem]">
          {filteredSites.map((site) => {
            const openDays = DAYS.filter((day) => (site.opening_hours?.[day]?.length ?? 0) > 0).length;
            const selected = site.id === selectedSite?.id;
            return (
              <button
                key={site.id}
                type="button"
                aria-current={selected ? "true" : undefined}
                onClick={() => pick(site.id)}
                className={`rounded-lg px-3 py-2.5 text-left transition ${selected ? "bg-subtle" : "hover:bg-subtle/60"}`}
              >
                <span className="flex items-center gap-2">
                  <strong className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">{site.name}</strong>
                  <span className={`size-2 rounded-full ${site.active ? "bg-success" : "bg-faintest"}`} />
                </span>
                <span className="mt-1 block text-xs text-muted">{openDays} días abiertos · cada {site.scheduling_config.slot_interval_min} min</span>
              </button>
            );
          })}
          {filteredSites.length === 0 ? <p className="px-3 py-8 text-center text-xs text-muted">No encontramos sedes.</p> : null}
        </div>
      </aside>
      <div className="min-w-0 p-3 sm:p-4">
        {asking ? (
          <div role="alert" className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-warn-rule/40 bg-warn-soft px-3 py-2 text-xs text-warn">
            <span className="min-w-0 flex-1">Tienes cambios sin guardar en {selectedSite?.name}.</span>
            <button type="button" className={GHOST} onClick={() => setAsking(null)}>Seguir editando</button>
            <button
              type="button"
              className={GHOST}
              onClick={() => {
                setDirty(false);
                setSelectedId(asking);
                setAsking(null);
              }}
            >
              Descartar y cambiar
            </button>
          </div>
        ) : null}
        {selectedSite ? (
          <SiteForm
            key={`${part}-${selectedSite.id}`}
            clientId={clientId}
            site={selectedSite}
            part={part}
            run={run}
            pending={pending}
            schedulingEnabled={schedulingEnabled}
            serviceCount={siteServiceMap[selectedSite.id]?.length ?? 0}
            onDirtyChange={setDirty}
          />
        ) : (
          <div className="flex min-h-72 flex-col items-center justify-center text-center">
            <p className="text-sm font-semibold text-foreground">Aún no hay sedes</p>
            <p className="mt-1 max-w-sm text-xs text-muted">
              Crea la primera sede en <Link href={schedulingHref(clientId, "sites")} className="underline underline-offset-2">Sedes</Link> para definir horarios y recibir reservas.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="text-xs font-medium text-foreground">{label}</span>
      {children}
      {hint ? <span className="text-[0.6875rem] text-faint">{hint}</span> : null}
    </label>
  );
}


function ExceptionsSection({ clientId, sites, staff, exceptions, run, pending }: { clientId: string; sites: Site[]; staff: Staff[]; exceptions: Exception[]; run: Run; pending: boolean }) {
  const [creating, setCreating] = useState(false);
  const [siteId, setSiteId] = useState(sites[0]?.id ?? "");
  const [staffId, setStaffId] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [reason, setReason] = useState("");
  const [publicReason, setPublicReason] = useState<PublicAbsenceReason | null>(null);
  const scope = staffId ? "staff" : "site";

  const submit = () =>
    run(async () => {
      // Send the RAW local wall-clock (from datetime-local); the server anchors it
      // to the SITE's timezone, not the browser's.
      const r = await createExceptionAction({
        clientId,
        siteId,
        staffId: staffId || null,
        startsAt: start,
        endsAt: end,
        reason: reason || undefined,
        publicReason: effectivePublicReason(publicReason, scope),
      });
      if (r.ok) { setStart(""); setEnd(""); setReason(""); setPublicReason(null); setCreating(false); }
      return r;
    });

  /**
   * A block is read in the timezone of the SITE it closes, never the browser's — a
   * manager in Bogotá looking at a Madrid site must see Madrid's wall clock, which is
   * the clock the block was created against.
   */
  const fmt = (iso: string, timeZone: string) =>
    new Intl.DateTimeFormat("es-CO", { dateStyle: "short", timeStyle: "short", timeZone }).format(new Date(iso));

  /**
   * SOONEST FIRST. The page fetches per site and flattens, so the rows arrive grouped
   * by site (each group ascending) rather than globally ordered — with two sites the
   * next block to happen was not the first one listed.
   */
  const upcoming = [...exceptions].sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));

  return (
    <Section
      title="Excepciones"
      description="Cierres puntuales de una sede y ausencias de un profesional: esos horarios dejan de ofrecerse. El horario habitual está en Horarios."
      action={<button type="button" className={BTN} onClick={() => setCreating(true)}>+ Nuevo bloqueo</button>}
    >
      <div>
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-foreground">Próximos bloqueos</h3>
          <span className="u-mono text-xs text-faint">{exceptions.length}</span>
        </div>
        <ul className="flex flex-col gap-2 text-sm">
        {exceptions.length === 0 ? (
          <li className="rounded-xl border border-dashed border-line px-4 py-10 text-center">
            <p className="font-semibold text-foreground">Sin bloqueos próximos</p>
            <p className="mt-1 text-xs text-muted">Los cierres, vacaciones y ausencias aparecerán aquí.</p>
            <button type="button" className={`${BTN} mt-4`} onClick={() => setCreating(true)}>Nuevo bloqueo</button>
          </li>
        ) : null}
        {upcoming.map((e) => {
          const site = sites.find((x) => x.id === e.site_id);
          const st = staff.find((x) => x.id === e.staff_id);
          const zone = site?.timezone ?? "UTC";
          return (
            <li key={e.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line px-4 py-3">
              <span>
                <span className={`mb-1 inline-flex rounded-full px-2 py-0.5 text-[0.625rem] font-medium ${st ? "bg-chip text-muted" : "bg-warn-soft text-warn"}`}>
                  {st ? "Ausencia de profesional" : "Cierre de la sede"}
                </span>
                <strong className="block font-medium text-foreground">{e.reason ?? "Bloqueo de agenda"}</strong>
                <span className="mt-1 block text-xs text-muted">{fmt(e.starts_at, zone)} → {fmt(e.ends_at, zone)} · {site?.name ?? "—"} · {st ? st.name : "Toda la sede"}</span>
                <span className="mt-0.5 block text-xs text-faint">Cliente: {e.public_reason ? PUBLIC_REASON_LABEL[e.public_reason] : "sin motivo (solo «no hay disponibilidad»)"}</span>
              </span>
              <button className={GHOST} disabled={pending} onClick={() => run(() => deleteExceptionAction(clientId, e.id))}>Eliminar</button>
            </li>
          );
        })}
        </ul>
      </div>
      {creating ? (
        <ConfigModal
          title="Nuevo bloqueo"
          description="El horario dejará de ofrecerse en la sede o al profesional seleccionado."
          onClose={() => setCreating(false)}
          size="md"
          footer={<button className={BTN} disabled={pending || !siteId || !start || !end} onClick={submit}>Crear bloqueo</button>}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Sede">
              <select value={siteId} onChange={(e) => { setSiteId(e.target.value); setStaffId(""); }} className={`${INPUT} w-full`}>
                {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </Field>
            <Field label="Alcance">
              <select value={staffId} onChange={(e) => setStaffId(e.target.value)} className={`${INPUT} w-full`}>
                <option value="">Toda la sede</option>
                {staff.filter((s) => s.site_id === siteId).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </Field>
            <Field label="Desde"><input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} className={`${INPUT} w-full`} /></Field>
            <Field label="Hasta"><input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} className={`${INPUT} w-full`} /></Field>
            <div className="sm:col-span-2">
              <Field label="Motivo" hint="Visible solo para el equipo."><input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ej. Vacaciones" className={`${INPUT} w-full`} /></Field>
            </div>
            <div className="sm:col-span-2">
              <PublicReasonField scope={scope} value={publicReason} onChange={setPublicReason} who={staff.find((s) => s.id === staffId)?.name ?? null} />
            </div>
          </div>
        </ConfigModal>
      ) : null}
    </Section>
  );
}

/**
 * «Horario de cada profesional» — a read view of every professional's EFFECTIVE weekly
 * hours (own hours, or the site's when they have none) and their upcoming absences. The
 * editor stays where it already is (the professional's drawer in Equipo, which has the
 * split-shift editor and the conflict-aware time-off form); this page links straight into
 * it instead of growing a second copy.
 */
function StaffAvailability({ clientId, sites, staff, exceptions }: { clientId: string; sites: Site[]; staff: Staff[]; exceptions: Exception[] }) {
  const staffHref = (member: Staff, dtab: string) =>
    `/clients/${clientId}/scheduling/staff?${new URLSearchParams({ site: member.site_id, s: member.id, dtab }).toString()}`;
  const groups = sites
    .map((site) => ({ site, members: staff.filter((m) => m.site_id === site.id).sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name, "es")) }))
    .filter((g) => g.members.length > 0);
  return (
    <Section
      title="Horario de cada profesional"
      description="Quién trabaja cuándo. Un profesional sin horario propio atiende en el horario de su sede. Se edita en la ficha del profesional, en Equipo."
    >
      {groups.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line-strong px-5 py-10 text-center">
          <p className="text-sm font-semibold text-foreground">Aún no hay profesionales</p>
          <p className="mt-1 text-xs text-muted">
            Agrégalos en <Link href={`/clients/${clientId}/scheduling/staff`} className="underline underline-offset-2">Equipo</Link>.
          </p>
        </div>
      ) : (
        groups.map(({ site, members }) => (
          <section key={site.id} aria-label={site.name} className="overflow-hidden rounded-xl border border-line bg-surface">
            <header className="flex items-center gap-2 border-b border-line px-4 py-2.5">
              <h3 className="text-sm font-semibold text-foreground">{site.name}</h3>
              <span className="u-mono text-xs text-faint">{members.length}</span>
            </header>
            <ul>
              {members.map((member, i) => {
                const own = member.working_hours && Object.keys(member.working_hours).length > 0 ? member.working_hours : null;
                const hours = own ?? site.opening_hours ?? {};
                const absences = exceptions.filter((e) => e.staff_id === member.id).length;
                return (
                  <li key={member.id} className={`flex flex-wrap items-center gap-3 px-4 py-3 ${i > 0 ? "border-t border-line-soft" : ""} ${member.active ? "" : "opacity-70"}`}>
                    <div className="min-w-[10rem] flex-1">
                      <p className="truncate text-sm font-medium text-foreground">
                        {member.name}
                        {!member.active ? <span className="ml-2 rounded-full bg-chip px-2 py-0.5 text-[0.625rem] text-muted">Inactivo</span> : null}
                      </p>
                      <p className="mt-0.5 text-xs text-muted">
                        {own ? "Horario propio" : "Usa el horario de la sede"}
                        {absences > 0 ? ` · ${absences} ausencia${absences === 1 ? "" : "s"} próxima${absences === 1 ? "" : "s"}` : ""}
                      </p>
                    </div>
                    <ol aria-label={`Días que trabaja ${member.name}`} className="flex gap-1">
                      {DAYS.map((d) => {
                        const ranges = hours[d] ?? [];
                        const on = ranges.length > 0;
                        const label = `${DAY_LABELS[d]}: ${on ? ranges.map((r) => `${r.start}–${r.end}`).join(", ") : "no trabaja"}`;
                        return (
                          <li
                            key={d}
                            title={label}
                            aria-label={label}
                            className={`flex size-7 items-center justify-center rounded-md text-[0.625rem] font-semibold ${on ? "bg-foreground text-background" : "bg-chip text-faint"}`}
                          >
                            {DAY_LABELS[d].slice(0, 1)}
                          </li>
                        );
                      })}
                    </ol>
                    <div className="flex gap-2">
                      <Link href={staffHref(member, "hours")} className={GHOST}>Editar horario</Link>
                      <Link href={staffHref(member, "time off")} className={GHOST}>Ausencias</Link>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}
    </Section>
  );
}


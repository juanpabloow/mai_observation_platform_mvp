"use client";

import { useCallback, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { DAYS, DAY_LABELS, gridFromWeekly, HoursGrid, weeklyFromGrid, type HourGrid } from "./HoursGrid";
import {
  activateServiceAction,
  activateSiteAction,
  activateStaffAction,
  countUpcomingAppointmentsAction,
  createExceptionAction,
  createServiceAction,
  createSiteAction,
  deactivateServiceAction,
  deactivateSiteAction,
  deactivateStaffAction,
  deleteExceptionAction,
  setSiteServiceAction,
  updateServiceAction,
  updateSiteAction,
} from "@/lib/schedulingAdminActions";
import { PageShell } from "@/components/ui/PageShell";
import { OVERLAY_SCRIM, useTrappedPanel } from "@/components/ui/Overlay";

type WeeklyHours = Record<string, Array<{ start: string; end: string }>>;

interface SchedulingConfig {
  slot_interval_min: number;
  min_notice_min: number;
  booking_horizon_days: number;
  default_buffer_before_min: number;
  default_buffer_after_min: number;
}
interface Site {
  id: string; client_id: string; slug: string; name: string; address: string | null; timezone: string; active: boolean;
  /** The site's configured weekly opening hours (C-6 — shown + editable). */
  opening_hours: WeeklyHours;
  /** min notice / booking horizon / slot granularity (+ default buffers). Config-only until
   *  now — shown + editable so an operator can see why availability starts N min from now. */
  scheduling_config: SchedulingConfig;
}
interface Service {
  id: string; name: string; description: string | null; duration_min: number;
  price: string | null; buffer_before_min: number; buffer_after_min: number; active: boolean;
  /** Operator-chosen "offer this first" flag — the assistant leads with featured services. */
  featured: boolean;
  /** The colour family the agenda paints this service with; null = unclassified, and
   *  the agenda falls back to guessing from the name. */
  category: string | null;
}
interface Staff {
  id: string; site_id: string; name: string; active: boolean; serviceIds: string[];
  /** Per-staff weekly working hours; {} means "inherit the site's opening hours" (C-6). */
  working_hours: WeeklyHours;
}

interface Exception { id: string; site_id: string; staff_id: string | null; starts_at: string; ends_at: string; reason: string | null }

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
type SettingsTab = "overview" | "sites" | "services" | "blocks" | "rules";

const SETTINGS_TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: "overview", label: "Resumen" },
  { id: "sites", label: "Sedes y horarios" },
  { id: "services", label: "Servicios" },
  { id: "blocks", label: "Bloqueos" },
  { id: "rules", label: "Reglas" },
];

/**
 * Per-CLIENT scheduling settings (owner/admin). Every mutation carries the route's
 * `clientId`, which the server actions re-validate (tenant + client + non-default +
 * scheduling enabled + resource ownership) — there is no client selector, so this
 * panel can only ever administer the one client it was opened for. `clientName` is
 * shown for context only.
 */
export function AdminPanel({
  clientId,
  clientName,
  sites,
  services,
  staff,
  exceptions,
  siteServiceMap,
}: {
  clientId: string;
  clientName: string;
  sites: Site[];
  services: Service[];
  staff: Staff[];
  exceptions: Exception[];
  /** REAL per-site enablement (site_services): siteId → enabled serviceIds. */
  siteServiceMap: Record<string, string[]>;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [tab, setTab] = useState<SettingsTab>("overview");

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setError(null);
    startTransition(async () => {
      const r = await fn();
      if (!r.ok) setError(r.error ?? "No se pudo guardar el cambio.");
      else router.refresh();
    });
  };

  return (
    <main className="flex min-h-0 w-full flex-1 flex-col gap-[var(--content-pad)]">
      <PageShell grow={false} clip={false}>
        <div className="px-4 pt-3 sm:px-5">
          <div className="flex min-h-11 flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-baseline gap-2.5">
                <h1 className="truncate text-xl font-semibold tracking-[-0.025em] text-foreground">Configuración de agenda</h1>
                <span className="truncate text-xs text-muted">{clientName}</span>
              </div>
              <p className="mt-0.5 hidden text-xs text-muted sm:block">Sedes, servicios, equipo y reglas de reserva</p>
            </div>
            <Link href={`/clients/${clientId}/scheduling/agenda`} className="inline-flex h-[44px] items-center rounded-lg border border-line-strong px-3.5 text-sm font-medium text-foreground hover:bg-subtle lg:h-[36px]">
              Ver agenda
            </Link>
          </div>
          <nav aria-label="Secciones de configuración" className="mt-2 flex min-w-0 items-center gap-1 overflow-x-auto border-t border-line">
            {SETTINGS_TABS.slice(0, 3).map((item) => {
              const count = item.id === "sites" ? sites.length : item.id === "services" ? services.length : item.id === "blocks" ? exceptions.length : null;
              return (
                <button
                  key={item.id}
                  type="button"
                  aria-current={tab === item.id ? "page" : undefined}
                  onClick={() => setTab(item.id)}
                  className={`relative flex h-[44px] shrink-0 items-center gap-1.5 border-b-2 px-3 text-xs font-medium transition lg:h-[40px] lg:px-2.5 ${
                    tab === item.id ? "border-foreground text-foreground" : "border-transparent text-muted hover:text-foreground"
                  }`}
                >
                  {item.label}
                  {count !== null ? <span className="u-mono rounded bg-chip px-1.5 py-0.5 text-[0.625rem] text-faint">{count}</span> : null}
                </button>
              );
            })}
            <Link href={`/clients/${clientId}/scheduling/staff`} className="relative flex h-[44px] shrink-0 items-center gap-1.5 border-b-2 border-transparent px-3 text-xs font-medium text-muted transition hover:text-foreground lg:h-[40px] lg:px-2.5">
              Equipo <span className="u-mono rounded bg-chip px-1.5 py-0.5 text-[0.625rem] text-faint">{staff.length}</span>
            </Link>
            {SETTINGS_TABS.slice(3).map((item) => {
              const count = item.id === "blocks" ? exceptions.length : null;
              return (
                <button
                  key={item.id}
                  type="button"
                  aria-current={tab === item.id ? "page" : undefined}
                  onClick={() => setTab(item.id)}
                  className={`relative flex h-[44px] shrink-0 items-center gap-1.5 border-b-2 px-3 text-xs font-medium transition lg:h-[40px] lg:px-2.5 ${
                    tab === item.id ? "border-foreground text-foreground" : "border-transparent text-muted hover:text-foreground"
                  }`}
                >
                  {item.label}
                  {count !== null ? <span className="u-mono rounded bg-chip px-1.5 py-0.5 text-[0.625rem] text-faint">{count}</span> : null}
                </button>
              );
            })}
          </nav>
        </div>
      </PageShell>
      {error ? <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p> : null}
      <PageShell className="overflow-y-auto" ariaLabel="Configuración de agenda">
        {/* min-h-full (not h-full) is what lets the Resumen FILL the viewport without
            capping a long tab: its grid takes flex-1 of at-least-the-viewport, so the
            overview has no empty band under it while Servicios can still grow and
            scroll. Full width, like the reference — a centred max-width left the
            four metric cards floating in the middle of a wide screen. */}
        <div className="flex min-h-full w-full flex-col gap-2.5 p-3 sm:p-4">
          {tab === "overview" ? (
            <SettingsOverview
              clientId={clientId}
              sites={sites}
              services={services}
              staff={staff}
              exceptions={exceptions}
              siteServiceMap={siteServiceMap}
              onNavigate={setTab}
            />
          ) : null}
          {tab === "sites" ? <SitesSection clientId={clientId} sites={sites} run={run} pending={pending} /> : null}
          {tab === "services" ? (
            <ServicesSection clientId={clientId} sites={sites} services={services} siteServiceMap={siteServiceMap} run={run} pending={pending} />
          ) : null}
          {tab === "blocks" ? (
            <ExceptionsSection clientId={clientId} sites={sites} staff={staff} exceptions={exceptions} run={run} pending={pending} />
          ) : null}
          {tab === "rules" ? <RulesSection sites={sites} onEdit={() => setTab("sites")} /> : null}
        </div>
      </PageShell>
    </main>
  );
}

function SettingsOverview({
  clientId,
  sites,
  services,
  staff,
  exceptions,
  siteServiceMap,
  onNavigate,
}: {
  clientId: string;
  sites: Site[];
  services: Service[];
  staff: Staff[];
  exceptions: Exception[];
  siteServiceMap: Record<string, string[]>;
  onNavigate: (tab: SettingsTab) => void;
}) {
  const activeSites = sites.filter((site) => site.active);
  const activeServices = services.filter((service) => service.active);
  const activeStaff = staff.filter((member) => member.active);
  const ready = activeSites.length > 0 && activeServices.length > 0 && activeStaff.length > 0;
  const doneSteps = [activeSites.length > 0, activeServices.length > 0, activeStaff.length > 0].filter(Boolean).length;

  /** Distinct categories in use — the reference's "N categorías" on the services card. */
  const categoryCount = new Set(activeServices.map((service) => service.category ?? "none")).size;
  /** The soonest upcoming block, so the card says WHEN and not just how many. */
  const nextBlock = [...exceptions].sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at))[0];
  const nextBlockSite = nextBlock ? sites.find((site) => site.id === nextBlock.site_id) : undefined;

  const summaries: Array<{ label: string; value: number; helper: string; tab?: SettingsTab; href?: string }> = [
    {
      label: "Sedes activas",
      value: activeSites.length,
      helper: activeSites.length === 0
        ? "Ninguna recibe reservas"
        : [activeSites.slice(0, 2).map((site) => site.name).join(" · "), sites.length - activeSites.length > 0 ? `${sites.length - activeSites.length} inactiva${sites.length - activeSites.length === 1 ? "" : "s"}` : null]
            .filter(Boolean)
            .join(" · "),
      tab: "sites",
    },
    {
      label: "Servicios activos",
      value: activeServices.length,
      helper: `${categoryCount} categoría${categoryCount === 1 ? "" : "s"} · ${activeServices.filter((service) => service.featured).length} destacados`,
      tab: "services",
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
      tab: "blocks",
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
    action?: { label: string; tab?: SettingsTab; href?: string };
  };
  const rows: Row[] = [
    {
      label: "Sedes y horario de atención",
      helper: activeSites.length === 0
        ? "Crea o activa una sede para recibir reservas"
        : `${activeSites.length} sede${activeSites.length === 1 ? "" : "s"} activa${activeSites.length === 1 ? "" : "s"}`,
      state: activeSites.length === 0 ? "todo" : "ok",
      action: { label: "Revisar", tab: "sites" },
    },
    {
      label: "Catálogo de servicios",
      helper: activeServices.length === 0
        ? "Define al menos un servicio reservable"
        : `${activeServices.length} servicio${activeServices.length === 1 ? "" : "s"} con duración y precio`,
      state: activeServices.length === 0 ? "todo" : "ok",
      action: { label: "Revisar", tab: "services" },
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
      action: { label: "Definir", tab: "sites" },
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
      action: { label: "Habilitar", tab: "services" },
    });
  }
  rows.push({
    label: "Reservas en línea",
    helper: ready ? "La agenda ya puede generar horarios reservables" : "Se habilita al completar los pasos anteriores",
    state: ready ? "ok" : "todo",
  });

  const openProblems = rows.filter((row) => row.state !== "ok").length;

  return (
    <>
      <div className="grid shrink-0 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        {summaries.map((item) => {
          const body = (
            <>
              <span className="text-[0.6875rem] text-muted">{item.label}</span>
              <strong className="mt-1 block text-[1.375rem] font-semibold leading-tight tracking-[-0.01em] text-foreground">{item.value}</strong>
              <span className="mt-1 block truncate text-[0.6875rem] text-faint">{item.helper}</span>
            </>
          );
          return item.href ? (
            <Link key={item.label} href={item.href} className="min-w-0 rounded-xl border border-line bg-surface px-3.5 py-3 transition hover:border-line-strong hover:bg-subtle/40">{body}</Link>
          ) : (
            <button key={item.label} type="button" onClick={() => item.tab && onNavigate(item.tab)} className="min-w-0 rounded-xl border border-line bg-surface px-3.5 py-3 text-left transition hover:border-line-strong hover:bg-subtle/40">{body}</button>
          );
        })}
      </div>

      <div className="grid min-h-0 flex-1 gap-2.5 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-line bg-surface">
          <div className="flex shrink-0 items-center gap-2.5 border-b border-line px-4 py-3">
            <h2 className="text-sm font-semibold text-foreground">Estado de la configuración</h2>
            <span className="u-mono rounded-md border border-line bg-chip px-1.5 py-0.5 text-[0.6875rem] text-muted">{doneSteps} / 3</span>
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
                  row.action.href ? (
                    <Link href={row.action.href} className={GHOST}>{row.action.label}</Link>
                  ) : (
                    <button type="button" onClick={() => row.action?.tab && onNavigate(row.action.tab)} className={GHOST}>{row.action.label}</button>
                  )
                ) : (
                  <span className="shrink-0 text-[0.6875rem] text-faint">{ready ? "Activo" : "Bloqueado"}</span>
                )}
              </div>
            ))}
          </div>
        </section>

        <div className="flex min-h-0 flex-col gap-2.5">
          <WhyNothingAvailable sites={sites} staff={staff} />
          <section className="shrink-0 rounded-xl border border-line bg-surface px-4 py-3">
            <h2 className="u-th">Acciones rápidas</h2>
            {/* Compact chips, not a stack of full-width rows: these are shortcuts into
                the tabs above, and at row width they read as the primary content. */}
            <div className="mt-2.5 flex flex-wrap gap-2">
              <button type="button" onClick={() => onNavigate("sites")} className="inline-flex h-[44px] items-center rounded-lg bg-foreground px-3 text-xs font-medium text-background transition hover:opacity-90 lg:h-[32px]">+ Nueva sede</button>
              <button type="button" onClick={() => onNavigate("services")} className="inline-flex h-[44px] items-center rounded-lg border border-line-strong bg-surface px-3 text-xs transition hover:bg-subtle lg:h-[32px]">+ Nuevo servicio</button>
              <button type="button" onClick={() => onNavigate("blocks")} className="inline-flex h-[44px] items-center rounded-lg border border-line-strong bg-surface px-3 text-xs transition hover:bg-subtle lg:h-[32px]">+ Nuevo bloqueo</button>
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
function WhyNothingAvailable({ sites, staff }: { sites: Site[]; staff: Staff[] }) {
  const active = sites.filter((s) => s.active);
  const [siteId, setSiteId] = useState(active[0]?.id ?? "");
  const [dow, setDow] = useState<string>("mon");
  const site = sites.find((s) => s.id === siteId);
  if (!site) return null;

  const siteSlot = site.opening_hours?.[dow]?.[0];
  const siteOpen = Boolean(siteSlot);
  // Effective staff hours for the day: own working_hours if set, else the site's.
  const worksThisDay = (st: Staff): boolean => {
    if (!st.active || st.site_id !== siteId) return false;
    const own = st.working_hours && Object.keys(st.working_hours).length > 0 ? st.working_hours : null;
    return own ? Boolean(own[dow]?.[0]) : siteOpen; // inheriting staff work iff the site is open
  };
  const working = staff.filter(worksThisDay);
  // 3e — distinguish "everyone is deactivated" from "no one works this weekday". If the
  // site has staff but every one is inactive, say so exactly (that was a blind guess before).
  const staffAtSite = staff.filter((st) => st.site_id === siteId);
  const allStaffInactive = staffAtSite.length > 0 && staffAtSite.every((st) => !st.active);

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
      ? { ok: true, title: `Abierta de ${siteSlot!.start} a ${siteSlot!.end}`, detail: `${site.name} · ${DAY_LABELS[dow]}` }
      : { ok: false, title: "La sede no abre este día", detail: `${site.name} · ${DAY_LABELS[dow]} sin horario` },
    working.length > 0
      ? { ok: true, title: `${working.length} profesional${working.length === 1 ? "" : "es"} trabaja${working.length === 1 ? "" : "n"} este día`, detail: working.map((st) => st.name).join(", ") }
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
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-surface">
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
              <p className="truncate text-[0.6875rem] text-muted">{finding.detail}</p>
            </div>
          </div>
        ))}
        <p className="border-t border-line-soft py-2.5 text-[0.6875rem] text-faint">
          Las vacaciones, cierres y ausencias puntuales se administran en la pestaña Bloqueos.
        </p>
      </div>
    </section>
  );
}

function RulesSection({ sites, onEdit }: { sites: Site[]; onEdit: () => void }) {
  const activeSites = sites.filter((site) => site.active);
  return (
    <Section
      title="Reglas de reserva"
      description="Revisa cómo se generan los cupos en cada sede. La edición se mantiene junto al horario para evitar configuraciones contradictorias."
      action={<button type="button" className={BTN} onClick={onEdit}>Editar en sedes y horarios</button>}
    >
      {activeSites.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line-strong px-5 py-10 text-center">
          <p className="text-sm font-semibold text-foreground">No hay sedes activas</p>
          <p className="mt-1 text-xs text-muted">Activa o crea una sede para configurar reglas de reserva.</p>
        </div>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {activeSites.map((site) => {
            const config = site.scheduling_config;
            const notice = config.min_notice_min === 0
              ? "Reservas inmediatas"
              : config.min_notice_min >= 60
                ? `${Math.floor(config.min_notice_min / 60)} h de anticipación mínima`
                : `${config.min_notice_min} min de anticipación mínima`;
            return (
              <article key={site.id} className="rounded-xl border border-line bg-surface p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold text-foreground">{site.name}</h3>
                    <p className="mt-0.5 text-xs text-muted">{site.timezone}</p>
                  </div>
                  <span className="rounded-full bg-success/10 px-2.5 py-1 text-[0.6875rem] font-medium text-success">Activa</span>
                </div>
                <dl className="mt-4 grid grid-cols-3 overflow-hidden rounded-xl border border-line bg-card">
                  <div className="p-3">
                    <dt className="text-[0.6875rem] text-muted">Anticipación</dt>
                    <dd className="mt-1 text-xs font-semibold text-foreground">{notice}</dd>
                  </div>
                  <div className="border-l border-line p-3">
                    <dt className="text-[0.6875rem] text-muted">Horizonte</dt>
                    <dd className="mt-1 text-xs font-semibold text-foreground">{config.booking_horizon_days} días</dd>
                  </div>
                  <div className="border-l border-line p-3">
                    <dt className="text-[0.6875rem] text-muted">Intervalos</dt>
                    <dd className="mt-1 text-xs font-semibold text-foreground">Cada {config.slot_interval_min} min</dd>
                  </div>
                </dl>
              </article>
            );
          })}
        </div>
      )}
    </Section>
  );
}

type Run = (fn: () => Promise<{ ok: boolean; error?: string }>) => void;
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

/** An EXISTING site's real settings — name, slug, timezone + its configured weekly hours,
 *  seeded from the stored values — in an editable form. This is the fix for the reported
 *  bug: the site's real hours are now shown (not a blank create form pretending to be
 *  them). Save persists via updateSiteAction and immediately changes availability. */
function EditableSite({ clientId, site, run, pending, initiallyEditing = false }: { clientId: string; site: Site; run: Run; pending: boolean; initiallyEditing?: boolean }) {
  const [editing, setEditing] = useState(initiallyEditing);
  const [name, setName] = useState(site.name);
  const [slug, setSlug] = useState(site.slug);
  const [tz, setTz] = useState(site.timezone);
  const [grid, setGrid] = useState<HourGrid>(gridFromWeekly(site.opening_hours));
  // Booking rules that used to be config-only — now visible + editable. min_notice is why
  // "availability starts N minutes from now"; horizon caps how far ahead; slot is the grid.
  const [minNotice, setMinNotice] = useState(String(site.scheduling_config.min_notice_min));
  const [horizon, setHorizon] = useState(String(site.scheduling_config.booking_horizon_days));
  const [slotMin, setSlotMin] = useState(String(site.scheduling_config.slot_interval_min));
  const nums = [minNotice, horizon, slotMin].map((v) => Number(v));
  const numsOk =
    nums.every((n) => Number.isFinite(n) && Number.isInteger(n)) &&
    nums[0] >= 0 && nums[1] >= 1 && nums[2] >= 1;
  const openDays = DAYS.filter((day) => (site.opening_hours?.[day]?.length ?? 0) > 0).length;
  const save = () =>
    run(() =>
      updateSiteAction(clientId, site.id, {
        name: name.trim(),
        slug: slug.trim(),
        timezone: tz,
        openingHours: weeklyFromGrid(grid),
        // Merge over the existing config so the buffers (not shown here) are preserved.
        schedulingConfig: {
          ...site.scheduling_config,
          min_notice_min: Number(minNotice),
          booking_horizon_days: Number(horizon),
          slot_interval_min: Number(slotMin),
        },
      }),
    );
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
        <button type="button" className={GHOST} onClick={() => setEditing((open) => !open)} aria-expanded={editing}>
          {editing ? "Cerrar" : "Editar"}
        </button>
        <ActiveToggle clientId={clientId} kind="site" id={site.id} name={site.name} active={site.active} run={run} pending={pending} />
      </div>

      {editing ? (
        <div className="border-t border-line bg-card/40 p-4">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted">Información pública, reglas de reserva y horario semanal.</p>
            <CopyId label="ID de sede" value={site.id} />
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <Field label="Nombre"><input value={name} onChange={(e) => setName(e.target.value)} className={`${INPUT} w-full`} /></Field>
            <Field label="URL pública"><input value={slug} onChange={(e) => setSlug(e.target.value)} className={`${INPUT} w-full`} /></Field>
            <Field label="Zona horaria"><input value={tz} onChange={(e) => setTz(e.target.value)} className={`${INPUT} w-full`} /></Field>
          </div>

          <div className="mt-5 border-t border-line pt-4">
            <h4 className="text-sm font-semibold text-foreground">Reglas de reserva</h4>
            <p className="mt-1 text-xs text-muted">Controlan cuándo y con qué frecuencia se ofrecen horarios.</p>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
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
          </div>

          <div className="mt-5 border-t border-line pt-4">
            <h4 className="text-sm font-semibold text-foreground">Horario semanal</h4>
            <p className="mb-3 mt-1 text-xs text-muted">Activa los días en que esta sede recibe reservas.</p>
            <HoursGrid grid={grid} setGrid={setGrid} />
          </div>
          <div className="mt-4 flex justify-end">
            <button className={BTN} disabled={pending || !name || !slug || !numsOk} onClick={save}>Guardar cambios</button>
          </div>
        </div>
      ) : null}
    </article>
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

function SitesSection({ clientId, sites, run, pending }: { clientId: string; sites: Site[]; run: Run; pending: boolean }) {
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(sites[0]?.id ?? "");
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [tz, setTz] = useState("America/Bogota");
  const [grid, setGrid] = useState<HourGrid>(
    Object.fromEntries(DAYS.map((d) => [d, { on: d !== "sun", start: "09:00", end: "18:00" }])),
  );

  const submit = () =>
    run(async () => {
      const r = await createSiteAction({ clientId, slug: slug.trim(), name: name.trim(), timezone: tz, openingHours: weeklyFromGrid(grid) });
      if (r.ok) { setSlug(""); setName(""); setCreating(false); }
      return r;
    });

  const filteredSites = sites.filter((site) => site.name.toLocaleLowerCase("es").includes(query.trim().toLocaleLowerCase("es")));
  const selectedSite = sites.find((site) => site.id === selectedId) ?? sites[0];

  return (
    <Section
      title="Sedes y horarios"
      description="Define dónde atiendes, cuándo abre cada sede y con cuánta anticipación pueden reservar."
      action={<button type="button" className={BTN} onClick={() => setCreating(true)}>+ Nueva sede</button>}
    >
      <div className="grid min-h-[28rem] overflow-hidden rounded-xl border border-line bg-surface lg:grid-cols-[17rem_minmax(0,1fr)]">
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
                  onClick={() => setSelectedId(site.id)}
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
          {selectedSite ? (
            <EditableSite key={selectedSite.id} clientId={clientId} site={selectedSite} run={run} pending={pending} initiallyEditing />
          ) : (
            <div className="flex min-h-72 flex-col items-center justify-center text-center">
              <p className="text-sm font-semibold text-foreground">Aún no hay sedes</p>
              <p className="mt-1 max-w-sm text-xs text-muted">Crea la primera sede para definir horarios y recibir reservas.</p>
            </div>
          )}
        </div>
      </div>
      {creating ? (
        <ConfigModal
          title="Nueva sede"
          description="Crea la sede y su horario base. Las reglas avanzadas se pueden ajustar después."
          onClose={() => setCreating(false)}
          footer={<button className={BTN} disabled={pending || !slug || !name} onClick={submit}>Crear sede</button>}
        >
          <div className="grid gap-3 md:grid-cols-3">
            <Field label="Nombre"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ej. Sede Chapinero" className={`${INPUT} w-full`} /></Field>
            <Field label="URL pública" hint="Se usará en el enlace de reservas."><input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="sede-chapinero" className={`${INPUT} w-full`} /></Field>
            <Field label="Zona horaria"><input value={tz} onChange={(e) => setTz(e.target.value)} placeholder="America/Bogota" className={`${INPUT} w-full`} /></Field>
          </div>
          <div className="mt-5 border-t border-line pt-4">
            <p className="mb-3 text-sm font-semibold text-foreground">Horario semanal</p>
            <HoursGrid grid={grid} setGrid={setGrid} />
          </div>
        </ConfigModal>
      ) : null}
    </Section>
  );
}

/**
 * The colour families a service can be filed under — the ones with a palette on the
 * agenda (globals.css `.u-appt-*`), which is the same closed set the
 * services_category_valid CHECK enforces. "Unclassified" is a real, storable choice:
 * it returns the service to being coloured by keywords in its name.
 */
const CATEGORY_OPTIONS = [
  { value: "", label: "Sin categoría" },
  { value: "color", label: "Color" },
  { value: "grooming", label: "Barba y cuidado" },
  { value: "cut", label: "Corte" },
  { value: "feature", label: "Tratamiento destacado" },
] as const;

/** An EXISTING service's editable settings (name/duration/price/buffers/category) + its
 *  per-site enablement toggles + a copyable id. Save persists via updateServiceAction. */
function EditableService({ clientId, service, activeSites, siteServiceMap, run, pending }: {
  clientId: string; service: Service; activeSites: Site[]; siteServiceMap: Record<string, string[]>; run: Run; pending: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(service.name);
  const [duration, setDuration] = useState(String(service.duration_min));
  const [price, setPrice] = useState(service.price ?? "");
  const [bBefore, setBBefore] = useState(String(service.buffer_before_min));
  const [bAfter, setBAfter] = useState(String(service.buffer_after_min));
  const [featured, setFeatured] = useState(service.featured);
  const [category, setCategory] = useState(service.category ?? "");
  const save = () =>
    run(async () => {
      const r = await updateServiceAction(clientId, service.id, {
        name: name.trim(),
        durationMin: Number(duration),
        price: price === "" ? null : Number(price),
        bufferBeforeMin: Number(bBefore),
        bufferAfterMin: Number(bAfter),
        featured,
        // "" clears it back to NULL; the action narrows anything unexpected with
        // parseServiceCategory, so a stale value degrades instead of failing a save.
        category: category === "" ? null : category,
      });
      // Only a SAVED change dismisses the editor — a rejected one keeps the form (and
      // the values the user typed) open beside the error.
      if (r.ok) setEditing(false);
      return r;
    });
  const enabledSiteCount = activeSites.filter((site) => (siteServiceMap[site.id] ?? []).includes(service.id)).length;
  return (
    <article className={`overflow-hidden rounded-xl border border-line ${service.active ? "bg-surface" : "bg-subtle/40"}`}>
      <div className="flex flex-wrap items-center gap-3 px-4 py-3.5">
        <span aria-hidden className={`size-2.5 rounded-full ${service.active ? "bg-success" : "bg-faintest"}`} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-foreground">{service.name}</h3>
            {service.featured ? <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[0.625rem] font-medium text-accent">Destacado</span> : null}
            {!service.active ? <span className="rounded-full bg-chip px-2 py-0.5 text-[0.625rem] font-medium text-muted">Inactivo</span> : null}
          </div>
          <p className="mt-1 truncate text-xs text-muted">
            {service.duration_min} min{service.price ? ` · $${Number(service.price).toLocaleString("es-CO")}` : ""} · {enabledSiteCount} sede{enabledSiteCount === 1 ? "" : "s"}
          </p>
        </div>
        {/* haspopup, not aria-expanded: the editor is a dialog over the list now, not
            a region unfolding inside this row. */}
        <button type="button" className={GHOST} onClick={() => setEditing(true)} aria-haspopup="dialog">
          Editar
        </button>
        <ActiveToggle clientId={clientId} kind="service" id={service.id} name={service.name} active={service.active} run={run} pending={pending} />
      </div>

      {editing ? (
        /* The editor is a CENTRED MODAL, not an expanded row. In a catalogue of a
           hundred services, unfolding a form in place pushed every following row down
           the page and left the list unreadable while editing — so the row list stays a
           scannable table and the form opens over it. */
        <ConfigModal
          title={service.name}
          description="Duración, precio, categoría y sedes donde se puede reservar."
          onClose={() => setEditing(false)}
          footer={
            <button className={BTN} disabled={pending || !name || !(Number(duration) > 0)} onClick={save}>Guardar cambios</button>
          }
        >
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <label className="flex items-center gap-2 text-xs text-muted">
              <input type="checkbox" checked={featured} onChange={(e) => setFeatured(e.target.checked)} />
              Mostrar primero cuando el cliente no especifica un servicio
            </label>
            <CopyId label="ID de servicio" value={service.id} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Nombre"><input value={name} onChange={(e) => setName(e.target.value)} className={`${INPUT} w-full`} /></Field>
            <Field label="Duración (min)"><input type="number" min={1} value={duration} onChange={(e) => setDuration(e.target.value)} className={`${INPUT} w-full`} /></Field>
            <Field label="Precio"><input type="number" min={0} value={price} onChange={(e) => setPrice(e.target.value)} className={`${INPUT} w-full`} /></Field>
            <Field label="Preparación antes (min)"><input type="number" min={0} value={bBefore} onChange={(e) => setBBefore(e.target.value)} className={`${INPUT} w-full`} /></Field>
            <Field label="Tiempo después (min)"><input type="number" min={0} value={bAfter} onChange={(e) => setBAfter(e.target.value)} className={`${INPUT} w-full`} /></Field>
            <Field label="Categoría" hint="Define el color de la tarjeta en la agenda.">
              <select value={category} onChange={(e) => setCategory(e.target.value)} className={`${INPUT} w-full`}>
                {CATEGORY_OPTIONS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </Field>
          </div>
          {service.active ? (
            <div className="mt-5 border-t border-line pt-4">
              <p className="mb-2 text-xs font-medium text-foreground">Disponible en</p>
              <div className="flex flex-wrap gap-1.5">
                {activeSites.map((site) => {
                  const on = (siteServiceMap[site.id] ?? []).includes(service.id);
                  return (
                    <button
                      key={site.id}
                      disabled={pending}
                      onClick={() => run(() => setSiteServiceAction(clientId, site.id, service.id, !on))}
                      className={`rounded-full border px-2.5 py-1 text-xs transition ${on ? "border-foreground bg-foreground text-background" : "border-line text-muted hover:bg-subtle"}`}
                    >
                      {site.name}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}
        </ConfigModal>
      ) : null}
    </article>
  );
}

function ServicesSection({
  clientId,
  sites,
  services,
  siteServiceMap,
  run,
  pending,
}: {
  clientId: string;
  sites: Site[];
  services: Service[];
  siteServiceMap: Record<string, string[]>;
  run: Run;
  pending: boolean;
}) {
  const activeSites = sites.filter((s) => s.active);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [name, setName] = useState("");
  const [duration, setDuration] = useState("60");
  const [price, setPrice] = useState("");
  const [bBefore, setBBefore] = useState("0");
  const [bAfter, setBAfter] = useState("0");
  const [category, setCategory] = useState("");
  // Sites the new service will be enabled at — default ALL active sites, so a
  // freshly created service is bookable everywhere unless narrowed.
  const [siteIds, setSiteIds] = useState<string[]>(activeSites.map((s) => s.id));

  const toggleSite = (id: string) =>
    setSiteIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const submit = () =>
    run(async () => {
      const r = await createServiceAction({
        clientId,
        name: name.trim(),
        durationMin: Number(duration),
        price: price ? Number(price) : null,
        bufferBeforeMin: Number(bBefore),
        bufferAfterMin: Number(bAfter),
        siteIds,
        category: category === "" ? null : category,
      });
      if (r.ok) { setName(""); setCategory(""); setSiteIds(activeSites.map((s) => s.id)); setCreating(false); }
      return r;
    });

  const filteredServices = services.filter((service) => {
    const matchesQuery = service.name.toLocaleLowerCase("es").includes(query.trim().toLocaleLowerCase("es"));
    const matchesCategory = categoryFilter === "all" || (categoryFilter === "none" ? !service.category : service.category === categoryFilter);
    return matchesQuery && matchesCategory;
  });

  return (
    <Section
      title="Servicios"
      description="Define qué se puede reservar, cuánto dura y en qué sedes está disponible."
      action={<button type="button" className={BTN} onClick={() => setCreating(true)}>+ Nuevo servicio</button>}
    >
      <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-3 sm:p-4">
        <div className="flex flex-wrap items-center gap-2 border-b border-line pb-3">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Buscar servicio…"
            aria-label="Buscar servicio"
            className={`${INPUT} min-w-0 flex-1 bg-subtle/60 sm:max-w-sm`}
          />
          <select value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)} aria-label="Filtrar por categoría" className={INPUT}>
            <option value="all">Todas las categorías</option>
            <option value="cut">Corte</option>
            <option value="grooming">Barba y cuidado</option>
            <option value="color">Color</option>
            <option value="feature">Tratamiento destacado</option>
            <option value="none">Sin categoría</option>
          </select>
          <span className="u-mono ml-auto text-xs text-faint">{filteredServices.length} servicio{filteredServices.length === 1 ? "" : "s"}</span>
        </div>
        {filteredServices.map((s) => (
          <EditableService key={s.id} clientId={clientId} service={s} activeSites={activeSites} siteServiceMap={siteServiceMap} run={run} pending={pending} />
        ))}
        {filteredServices.length === 0 ? (
          <div className="rounded-xl border border-dashed border-line px-4 py-10 text-center">
            <p className="text-sm font-semibold text-foreground">No encontramos servicios</p>
            <p className="mt-1 text-xs text-muted">Cambia la búsqueda o el filtro de categoría.</p>
          </div>
        ) : null}
      </div>
      {creating ? (
        <ConfigModal
          title="Nuevo servicio"
          description="Define duración, precio y las sedes donde se podrá reservar."
          onClose={() => setCreating(false)}
          footer={
            <button
              className={BTN}
              disabled={pending || !name || !(Number(duration) > 0) || siteIds.length === 0}
              onClick={submit}
            >
              Crear servicio
            </button>
          }
        >
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Nombre"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ej. Corte clásico" className={`${INPUT} w-full`} /></Field>
            <Field label="Duración (min)"><input type="number" min={1} value={duration} onChange={(e) => setDuration(e.target.value)} className={`${INPUT} w-full`} /></Field>
            <Field label="Precio"><input type="number" min={0} value={price} onChange={(e) => setPrice(e.target.value)} placeholder="Opcional" className={`${INPUT} w-full`} /></Field>
            <Field label="Preparación antes (min)"><input type="number" min={0} value={bBefore} onChange={(e) => setBBefore(e.target.value)} className={`${INPUT} w-full`} /></Field>
            <Field label="Tiempo después (min)"><input type="number" min={0} value={bAfter} onChange={(e) => setBAfter(e.target.value)} className={`${INPUT} w-full`} /></Field>
            <Field label="Categoría" hint="Define el color de la tarjeta en la agenda.">
              <select value={category} onChange={(e) => setCategory(e.target.value)} className={`${INPUT} w-full`} aria-label="Categoría">
                {CATEGORY_OPTIONS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </Field>
          </div>
          <div>
            <p className="mb-2 mt-5 border-t border-line pt-4 text-xs font-medium text-foreground">Disponible en</p>
            <div className="flex flex-wrap gap-1.5">
              {activeSites.map((site) => (
                <button
                  key={site.id}
                  type="button"
                  onClick={() => toggleSite(site.id)}
                  className={`rounded-full border px-2.5 py-1 text-xs transition ${siteIds.includes(site.id) ? "border-foreground bg-foreground text-background" : "border-line text-muted hover:bg-subtle"}`}
                >
                  {site.name}
                </button>
              ))}
            </div>
          </div>
        </ConfigModal>
      ) : null}
    </Section>
  );
}

function ExceptionsSection({ clientId, sites, staff, exceptions, run, pending }: { clientId: string; sites: Site[]; staff: Staff[]; exceptions: Exception[]; run: Run; pending: boolean }) {
  const [creating, setCreating] = useState(false);
  const [siteId, setSiteId] = useState(sites[0]?.id ?? "");
  const [staffId, setStaffId] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [reason, setReason] = useState("");

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
      });
      if (r.ok) { setStart(""); setEnd(""); setReason(""); setCreating(false); }
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
      title="Bloqueos de agenda"
      description="Registra vacaciones, cierres o ausencias para que esos horarios no se ofrezcan."
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
                <strong className="font-medium text-foreground">{e.reason ?? "Bloqueo de agenda"}</strong>
                <span className="mt-1 block text-xs text-muted">{fmt(e.starts_at, zone)} → {fmt(e.ends_at, zone)} · {site?.name ?? "—"} · {st ? st.name : "Toda la sede"}</span>
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
          </div>
        </ConfigModal>
      ) : null}
    </Section>
  );
}

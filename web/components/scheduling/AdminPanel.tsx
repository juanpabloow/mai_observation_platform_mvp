"use client";

import { useState, useTransition } from "react";
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
import { ModuleHeader } from "@/components/ui/ModuleHeader";
import { PageShell } from "@/components/ui/PageShell";

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

const INPUT = "h-9 rounded-lg border border-line-strong bg-surface px-3 text-sm text-foreground outline-none transition focus:border-foreground disabled:bg-subtle disabled:text-faint";
const BTN = "inline-flex h-9 items-center justify-center rounded-lg bg-foreground px-3.5 text-sm font-medium text-background transition hover:opacity-90 disabled:opacity-50";
const GHOST = "inline-flex h-8 items-center justify-center rounded-lg border border-line px-2.5 text-xs text-muted transition hover:bg-subtle hover:text-foreground";
type SettingsTab = "overview" | "sites" | "services" | "blocks";

const SETTINGS_TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: "overview", label: "Resumen" },
  { id: "sites", label: "Sedes y horarios" },
  { id: "services", label: "Servicios" },
  { id: "blocks", label: "Bloqueos" },
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
      <ModuleHeader
        title="Configuración de agenda"
        status={clientName}
        center={
          <nav aria-label="Secciones de configuración" className="flex min-w-0 items-center gap-1 overflow-x-auto rounded-lg bg-chip p-1">
            {SETTINGS_TABS.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-current={tab === item.id ? "page" : undefined}
                onClick={() => setTab(item.id)}
                className={`h-8 shrink-0 rounded-md px-3 text-xs font-medium transition ${
                  tab === item.id ? "bg-foreground text-background shadow-sm" : "text-muted hover:bg-surface hover:text-foreground"
                }`}
              >
                {item.label}
              </button>
            ))}
          </nav>
        }
        actions={
          <Link href={`/clients/${clientId}/scheduling/agenda`} className="inline-flex items-center rounded-lg border border-line-strong px-3 text-xs font-medium text-foreground hover:bg-subtle">
            Ver agenda
          </Link>
        }
      />
      {error ? <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p> : null}
      <PageShell className="overflow-y-auto" ariaLabel="Configuración de agenda">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-4 sm:p-5 lg:p-6">
          {tab === "overview" ? (
            <SettingsOverview
              clientId={clientId}
              sites={sites}
              services={services}
              staff={staff}
              exceptions={exceptions}
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
  onNavigate,
}: {
  clientId: string;
  sites: Site[];
  services: Service[];
  staff: Staff[];
  exceptions: Exception[];
  onNavigate: (tab: SettingsTab) => void;
}) {
  const ready =
    sites.some((site) => site.active) &&
    services.some((service) => service.active) &&
    staff.some((member) => member.active);
  const summaries: Array<{ label: string; value: number; helper: string; tab?: SettingsTab; href?: string }> = [
    { label: "Sedes activas", value: sites.filter((site) => site.active).length, helper: `${sites.length} configuradas`, tab: "sites" },
    { label: "Servicios activos", value: services.filter((service) => service.active).length, helper: `${services.filter((service) => service.featured).length} destacados`, tab: "services" },
    { label: "Profesionales", value: staff.filter((member) => member.active).length, helper: `${staff.length} en el equipo`, href: `/clients/${clientId}/scheduling/staff` },
    { label: "Bloqueos próximos", value: exceptions.length, helper: "Vacaciones y cierres", tab: "blocks" },
  ];

  return (
    <>
      <section>
        <div className="mb-3">
          <h2 className="text-base font-semibold text-foreground">
            {ready ? "Todo listo para recibir reservas" : "Completa la configuración de tu agenda"}
          </h2>
          <p className="mt-1 text-sm text-muted">
            {ready
              ? "Revisa la disponibilidad y entra directamente a lo que necesitas cambiar."
              : "Necesitas al menos una sede, un servicio y un profesional activos para recibir reservas."}
          </p>
        </div>
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {summaries.map((item) => {
            const body = (
              <>
                <span className="text-xs text-muted">{item.label}</span>
                <strong className="mt-2 block text-2xl font-semibold tracking-tight text-foreground">{item.value}</strong>
                <span className="mt-1 block text-xs text-faint">{item.helper}</span>
              </>
            );
            return item.href ? (
              <Link key={item.label} href={item.href} className="rounded-xl border border-line bg-card p-4 transition hover:border-line-strong hover:bg-subtle/40">{body}</Link>
            ) : (
              <button key={item.label} type="button" onClick={() => item.tab && onNavigate(item.tab)} className="rounded-xl border border-line bg-card p-4 text-left transition hover:border-line-strong hover:bg-subtle/40">{body}</button>
            );
          })}
        </div>
      </section>
      <WhyNothingAvailable sites={sites} staff={staff} />
    </>
  );
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

  return (
    <Section
      title="Comprobar disponibilidad"
      description="Entiende en segundos por qué una fecha podría aparecer sin horarios disponibles."
    >
      <div className="flex flex-col gap-3 rounded-xl border border-line bg-card p-4 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <select value={siteId} onChange={(e) => setSiteId(e.target.value)} className={INPUT}>
            {active.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <select value={dow} onChange={(e) => setDow(e.target.value)} className={INPUT}>
            {DAYS.map((d) => <option key={d} value={d}>{DAY_LABELS[d]}</option>)}
          </select>
        </div>
        <p>
          <span className="text-faint">Sede:</span>{" "}
          {siteOpen ? <span className="text-success">abierta de {siteSlot!.start} a {siteSlot!.end}</span> : <span className="text-danger">cerrada este día</span>}
        </p>
        <p>
          <span className="text-faint">Equipo disponible:</span>{" "}
          {working.length > 0 ? (
            working.map((s) => s.name).join(", ")
          ) : allStaffInactive ? (
            <span className="text-danger">nadie — todo el equipo de esta sede está inactivo.</span>
          ) : (
            <span className="text-danger">nadie — no se pueden recibir reservas.</span>
          )}
        </p>
        {(() => {
          const notice = site.scheduling_config.min_notice_min;
          const h = Math.floor(notice / 60);
          const m = notice % 60;
          const noticeText = notice === 0 ? "sin anticipación" : h > 0 ? `${h} h${m ? ` ${m} min` : ""}` : `${m} min`;
          return (
            <p>
              <span className="text-faint">Anticipación mínima:</span>{" "}
              {notice > 0 ? (
                <span className="text-accent">{noticeText}; los horarios anteriores a ese límite no se ofrecen.</span>
              ) : (
                <span>se permiten reservas inmediatas.</span>
              )}
              <span className="text-faint">{" · "}{site.scheduling_config.booking_horizon_days} días disponibles · intervalos de {site.scheduling_config.slot_interval_min} min</span>
            </p>
          );
        })()}
        <p className="text-[11px] text-faint">Las vacaciones, cierres y ausencias puntuales se administran en la pestaña Bloqueos.</p>
      </div>
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
function EditableSite({ clientId, site, run, pending }: { clientId: string; site: Site; run: Run; pending: boolean }) {
  const [editing, setEditing] = useState(false);
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

  return (
    <Section
      title="Sedes y horarios"
      description="Define dónde atiendes, cuándo abre cada sede y con cuánta anticipación pueden reservar."
      action={<button type="button" className={BTN} onClick={() => setCreating((open) => !open)}>{creating ? "Cancelar" : "+ Nueva sede"}</button>}
    >
      <div className="flex flex-col gap-3">
        {sites.map((s) => <EditableSite key={s.id} clientId={clientId} site={s} run={run} pending={pending} />)}
      </div>
      {creating ? (
        <div className="flex flex-col gap-4 rounded-xl border border-dashed border-line-strong bg-card/40 p-4">
          <div>
            <p className="text-sm font-semibold text-foreground">Nueva sede</p>
            <p className="mt-1 text-xs text-muted">La URL pública se usará para el enlace de reservas.</p>
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <Field label="Nombre"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ej. Sede Chapinero" className={`${INPUT} w-full`} /></Field>
            <Field label="URL pública"><input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="sede-chapinero" className={`${INPUT} w-full`} /></Field>
            <Field label="Zona horaria"><input value={tz} onChange={(e) => setTz(e.target.value)} placeholder="America/Bogota" className={`${INPUT} w-full`} /></Field>
          </div>
          <div>
            <p className="mb-3 text-xs font-medium text-foreground">Horario semanal</p>
            <HoursGrid grid={grid} setGrid={setGrid} />
          </div>
          <div className="flex justify-end">
            <button className={BTN} disabled={pending || !slug || !name} onClick={submit}>Crear sede</button>
          </div>
        </div>
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
    run(() =>
      updateServiceAction(clientId, service.id, {
        name: name.trim(),
        durationMin: Number(duration),
        price: price === "" ? null : Number(price),
        bufferBeforeMin: Number(bBefore),
        bufferAfterMin: Number(bAfter),
        featured,
        // "" clears it back to NULL; the action narrows anything unexpected with
        // parseServiceCategory, so a stale value degrades instead of failing a save.
        category: category === "" ? null : category,
      }),
    );
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
        <button type="button" className={GHOST} onClick={() => setEditing((open) => !open)} aria-expanded={editing}>
          {editing ? "Cerrar" : "Editar"}
        </button>
        <ActiveToggle clientId={clientId} kind="service" id={service.id} name={service.name} active={service.active} run={run} pending={pending} />
      </div>

      {editing ? (
        <div className="border-t border-line bg-card/40 p-4">
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
            <Field label="Categoría">
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
          <div className="mt-4 flex justify-end">
            <button className={BTN} disabled={pending || !name || !(Number(duration) > 0)} onClick={save}>Guardar cambios</button>
          </div>
        </div>
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

  return (
    <Section
      title="Servicios"
      description="Define qué se puede reservar, cuánto dura y en qué sedes está disponible."
      action={<button type="button" className={BTN} onClick={() => setCreating((open) => !open)}>{creating ? "Cancelar" : "+ Nuevo servicio"}</button>}
    >
      <div className="flex flex-col gap-3">
        {services.map((s) => (
          <EditableService key={s.id} clientId={clientId} service={s} activeSites={activeSites} siteServiceMap={siteServiceMap} run={run} pending={pending} />
        ))}
      </div>
      {creating ? (
        <div className="flex flex-col gap-4 rounded-xl border border-dashed border-line-strong bg-card/40 p-4">
          <div>
            <p className="text-sm font-semibold text-foreground">Nuevo servicio</p>
            <p className="mt-1 text-xs text-muted">Quedará disponible en las sedes que selecciones.</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Nombre"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ej. Corte clásico" className={`${INPUT} w-full`} /></Field>
            <Field label="Duración (min)"><input type="number" min={1} value={duration} onChange={(e) => setDuration(e.target.value)} className={`${INPUT} w-full`} /></Field>
            <Field label="Precio"><input type="number" min={0} value={price} onChange={(e) => setPrice(e.target.value)} placeholder="Opcional" className={`${INPUT} w-full`} /></Field>
            <Field label="Preparación antes (min)"><input type="number" min={0} value={bBefore} onChange={(e) => setBBefore(e.target.value)} className={`${INPUT} w-full`} /></Field>
            <Field label="Tiempo después (min)"><input type="number" min={0} value={bAfter} onChange={(e) => setBAfter(e.target.value)} className={`${INPUT} w-full`} /></Field>
            <Field label="Categoría">
              <select value={category} onChange={(e) => setCategory(e.target.value)} className={`${INPUT} w-full`} aria-label="Categoría">
                {CATEGORY_OPTIONS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </Field>
          </div>
          <div>
            <p className="mb-2 text-xs font-medium text-foreground">Disponible en</p>
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
          <div className="flex justify-end">
            <button
              className={BTN}
              disabled={pending || !name || !(Number(duration) > 0) || siteIds.length === 0}
              onClick={submit}
            >
              Crear servicio
            </button>
          </div>
        </div>
      ) : null}
    </Section>
  );
}

function ExceptionsSection({ clientId, sites, staff, exceptions, run, pending }: { clientId: string; sites: Site[]; staff: Staff[]; exceptions: Exception[]; run: Run; pending: boolean }) {
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
      if (r.ok) { setStart(""); setEnd(""); setReason(""); }
      return r;
    });

  const fmt = (iso: string) => new Intl.DateTimeFormat("es-CO", { dateStyle: "short", timeStyle: "short" }).format(new Date(iso));

  return (
    <Section title="Bloqueos de agenda" description="Registra vacaciones, cierres o ausencias para que esos horarios no se ofrezcan.">
      <div className="rounded-xl border border-line bg-card/40 p-4">
        <p className="mb-3 text-sm font-semibold text-foreground">Nuevo bloqueo</p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
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
          <Field label="Motivo"><input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ej. Vacaciones" className={`${INPUT} w-full`} /></Field>
          <Field label="Desde"><input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} className={`${INPUT} w-full`} /></Field>
          <Field label="Hasta"><input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} className={`${INPUT} w-full`} /></Field>
        </div>
        <div className="mt-4 flex justify-end">
          <button className={BTN} disabled={pending || !siteId || !start || !end} onClick={submit}>Crear bloqueo</button>
        </div>
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold text-foreground">Próximos bloqueos</h3>
        <ul className="flex flex-col gap-2 text-sm">
        {exceptions.length === 0 ? <li className="rounded-xl border border-dashed border-line px-4 py-8 text-center text-muted">No hay bloqueos próximos.</li> : null}
        {exceptions.map((e) => {
          const site = sites.find((x) => x.id === e.site_id);
          const st = staff.find((x) => x.id === e.staff_id);
          return (
            <li key={e.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line px-4 py-3">
              <span>
                <strong className="font-medium text-foreground">{e.reason ?? "Bloqueo de agenda"}</strong>
                <span className="mt-1 block text-xs text-muted">{fmt(e.starts_at)} → {fmt(e.ends_at)} · {site?.name ?? "—"} · {st ? st.name : "Toda la sede"}</span>
              </span>
              <button className={GHOST} disabled={pending} onClick={() => run(() => deleteExceptionAction(clientId, e.id))}>Eliminar</button>
            </li>
          );
        })}
        </ul>
      </div>
    </Section>
  );
}

"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  activateServiceAction,
  activateSiteAction,
  activateStaffAction,
  countUpcomingAppointmentsAction,
  createExceptionAction,
  createServiceAction,
  createSiteAction,
  createStaffAction,
  deactivateServiceAction,
  deactivateSiteAction,
  deactivateStaffAction,
  deleteExceptionAction,
  setSiteServiceAction,
  setStaffServiceAction,
  updateServiceAction,
  updateSiteAction,
  updateStaffAction,
} from "@/lib/schedulingAdminActions";

type WeeklyHours = Record<string, Array<{ start: string; end: string }>>;

interface Site {
  id: string; client_id: string; slug: string; name: string; address: string | null; timezone: string; active: boolean;
  /** The site's configured weekly opening hours (C-6 — shown + editable). */
  opening_hours: WeeklyHours;
}
interface Service {
  id: string; name: string; description: string | null; duration_min: number;
  price: string | null; buffer_before_min: number; buffer_after_min: number; active: boolean;
}
interface Staff {
  id: string; site_id: string; name: string; active: boolean; serviceIds: string[];
  /** Per-staff weekly working hours; {} means "inherit the site's opening hours" (C-6). */
  working_hours: WeeklyHours;
}

// ── Weekly-hours grid: the shared 7-day editor + WeeklyHours ↔ grid converters ──────
type HourRow = { on: boolean; start: string; end: string };
type HourGrid = Record<string, HourRow>;

function gridFromWeekly(weekly: WeeklyHours): HourGrid {
  return Object.fromEntries(
    DAYS.map((d) => {
      const slot = weekly?.[d]?.[0];
      return [d, slot ? { on: true, start: slot.start, end: slot.end } : { on: false, start: "09:00", end: "18:00" }];
    }),
  );
}
function weeklyFromGrid(grid: HourGrid): WeeklyHours {
  const out: WeeklyHours = {};
  for (const d of DAYS) if (grid[d].on) out[d] = [{ start: grid[d].start, end: grid[d].end }];
  return out;
}
function HoursGrid({ grid, setGrid }: { grid: HourGrid; setGrid: (g: HourGrid) => void }) {
  return (
    <div className="flex flex-col gap-1">
      {DAYS.map((d) => (
        <div key={d} className="flex items-center gap-2 text-xs">
          <label className="flex w-16 items-center gap-1">
            <input type="checkbox" checked={grid[d].on} onChange={(e) => setGrid({ ...grid, [d]: { ...grid[d], on: e.target.checked } })} />
            {d}
          </label>
          <input type="time" value={grid[d].start} disabled={!grid[d].on} onChange={(e) => setGrid({ ...grid, [d]: { ...grid[d], start: e.target.value } })} className={INPUT} />
          <input type="time" value={grid[d].end} disabled={!grid[d].on} onChange={(e) => setGrid({ ...grid, [d]: { ...grid[d], end: e.target.value } })} className={INPUT} />
        </div>
      ))}
    </div>
  );
}
interface Exception { id: string; site_id: string; staff_id: string | null; starts_at: string; ends_at: string; reason: string | null }

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const INPUT = "rounded-lg border border-line-strong bg-transparent px-2 py-1.5 text-sm";
const BTN = "rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50";
const GHOST = "rounded-lg border border-line px-2 py-1 text-xs hover:bg-subtle";

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

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setError(null);
    startTransition(async () => {
      const r = await fn();
      if (!r.ok) setError(r.error ?? "Action failed.");
      else router.refresh();
    });
  };

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 px-6 py-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">Scheduling settings</h1>
        <p className="text-sm text-muted">Sites, services, staff, and blocked time for {clientName}.</p>
      </header>
      {error ? <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p> : null}

      <WhyNothingAvailable sites={sites} staff={staff} />
      <SitesSection clientId={clientId} sites={sites} run={run} pending={pending} />
      <ServicesSection clientId={clientId} sites={sites} services={services} siteServiceMap={siteServiceMap} run={run} pending={pending} />
      <StaffSection clientId={clientId} sites={sites} services={services} staff={staff} siteServiceMap={siteServiceMap} run={run} pending={pending} />
      <ExceptionsSection clientId={clientId} sites={sites} staff={staff} exceptions={exceptions} run={run} pending={pending} />
    </main>
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
    <Section title="Why is nothing available?">
      <div className="flex flex-col gap-2 rounded-lg border border-line bg-card p-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <select value={siteId} onChange={(e) => setSiteId(e.target.value)} className={INPUT}>
            {active.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <select value={dow} onChange={(e) => setDow(e.target.value)} className={INPUT}>
            {DAYS.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        </div>
        <p>
          <span className="text-faint">Site:</span>{" "}
          {siteOpen ? <span className="text-success">open {siteSlot!.start}–{siteSlot!.end}</span> : <span className="text-danger">closed this day</span>}
        </p>
        <p>
          <span className="text-faint">Staff working:</span>{" "}
          {working.length > 0 ? (
            working.map((s) => s.name).join(", ")
          ) : allStaffInactive ? (
            <span className="text-danger">none — every staff member at this site is inactive. Reactivate one under Staff below.</span>
          ) : (
            <span className="text-danger">none — nothing can be booked</span>
          )}
        </p>
        <p className="text-[11px] text-faint">One-off blocks (vacations/holidays) are listed under Exceptions below.</p>
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
        Activate
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
          `${name} has ${count} upcoming appointment${count === 1 ? "" : "s"}. Deactivating stops new bookings; existing appointments stay and remain visible.`,
        );
      } else {
        run(() => DEACTIVATE[kind](clientId, id));
      }
    });
  };
  return (
    <button className={GHOST} disabled={pending || checking} onClick={onDeactivate}>
      {checking ? "Checking…" : "Deactivate"}
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
        {busy ? "Working…" : "Deactivate anyway"}
      </button>
      <button type="button" onClick={onCancel} className="rounded border border-line px-2 py-0.5 text-[11px] transition-colors hover:bg-subtle">
        Cancel
      </button>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="border-b border-line pb-1 text-sm font-semibold uppercase tracking-wider text-faint">{title}</h2>
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
      title={`Copy ${label}`}
      className="inline-flex w-fit items-center gap-1.5 rounded border border-line px-1.5 py-0.5 text-[11px] text-muted transition-colors hover:bg-subtle"
    >
      <span className="text-faint">{label}</span>
      <span className="select-all font-mono text-foreground">{value}</span>
      <span className="text-faint">{copied ? "copied ✓" : "copy"}</span>
    </button>
  );
}

/** An EXISTING site's real settings — name, slug, timezone + its configured weekly hours,
 *  seeded from the stored values — in an editable form. This is the fix for the reported
 *  bug: the site's real hours are now shown (not a blank create form pretending to be
 *  them). Save persists via updateSiteAction and immediately changes availability. */
function EditableSite({ clientId, site, run, pending }: { clientId: string; site: Site; run: Run; pending: boolean }) {
  const [name, setName] = useState(site.name);
  const [slug, setSlug] = useState(site.slug);
  const [tz, setTz] = useState(site.timezone);
  const [grid, setGrid] = useState<HourGrid>(gridFromWeekly(site.opening_hours));
  const save = () =>
    run(() => updateSiteAction(clientId, site.id, { name: name.trim(), slug: slug.trim(), timezone: tz, openingHours: weeklyFromGrid(grid) }));
  return (
    <div className={`flex flex-col gap-2 rounded-lg border border-line px-3 py-2 ${site.active ? "" : "bg-subtle/40"}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{site.name} {site.active ? "" : <em className="text-faint">(inactive)</em>}</span>
        <ActiveToggle clientId={clientId} kind="site" id={site.id} name={site.name} active={site.active} run={run} pending={pending} />
      </div>
      <CopyId label="Site id" value={site.id} />
      <div className="flex flex-wrap gap-2">
        <label className="flex flex-col gap-0.5 text-[10px] uppercase tracking-wider text-faint">Name<input value={name} onChange={(e) => setName(e.target.value)} className={INPUT} /></label>
        <label className="flex flex-col gap-0.5 text-[10px] uppercase tracking-wider text-faint">Slug (public URL)<input value={slug} onChange={(e) => setSlug(e.target.value)} className={INPUT} /></label>
        <label className="flex flex-col gap-0.5 text-[10px] uppercase tracking-wider text-faint">Timezone<input value={tz} onChange={(e) => setTz(e.target.value)} className={INPUT} /></label>
      </div>
      <span className="text-[10px] uppercase tracking-wider text-faint">Weekly opening hours</span>
      <HoursGrid grid={grid} setGrid={setGrid} />
      <button className={`${BTN} self-start`} disabled={pending || !name || !slug} onClick={save}>Save changes</button>
    </div>
  );
}

function SitesSection({ clientId, sites, run, pending }: { clientId: string; sites: Site[]; run: Run; pending: boolean }) {
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [tz, setTz] = useState("America/Bogota");
  const [grid, setGrid] = useState<HourGrid>(
    Object.fromEntries(DAYS.map((d) => [d, { on: d !== "sun", start: "09:00", end: "18:00" }])),
  );

  const submit = () =>
    run(async () => {
      const r = await createSiteAction({ clientId, slug: slug.trim(), name: name.trim(), timezone: tz, openingHours: weeklyFromGrid(grid) });
      if (r.ok) { setSlug(""); setName(""); }
      return r;
    });

  return (
    <Section title="Sites">
      <div className="flex flex-col gap-3">
        {sites.map((s) => <EditableSite key={s.id} clientId={clientId} site={s} run={run} pending={pending} />)}
      </div>
      {/* Visually + textually distinct so it can never read as the existing site's settings. */}
      <div className="flex flex-col gap-2 rounded-lg border-2 border-dashed border-line-strong p-3">
        <p className="text-sm font-semibold">Add a new site</p>
        <div className="flex flex-wrap gap-2">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" className={INPUT} />
          <input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="slug (public URL)" className={INPUT} />
          <input value={tz} onChange={(e) => setTz(e.target.value)} placeholder="IANA timezone" className={INPUT} />
        </div>
        <HoursGrid grid={grid} setGrid={setGrid} />
        <button className={`${BTN} self-start`} disabled={pending || !slug || !name} onClick={submit}>Add site</button>
      </div>
    </Section>
  );
}

/** An EXISTING service's editable settings (name/duration/price/buffers) + its per-site
 *  enablement toggles + a copyable id. Save persists via updateServiceAction. */
function EditableService({ clientId, service, activeSites, siteServiceMap, run, pending }: {
  clientId: string; service: Service; activeSites: Site[]; siteServiceMap: Record<string, string[]>; run: Run; pending: boolean;
}) {
  const [name, setName] = useState(service.name);
  const [duration, setDuration] = useState(String(service.duration_min));
  const [price, setPrice] = useState(service.price ?? "");
  const [bBefore, setBBefore] = useState(String(service.buffer_before_min));
  const [bAfter, setBAfter] = useState(String(service.buffer_after_min));
  const save = () =>
    run(() =>
      updateServiceAction(clientId, service.id, {
        name: name.trim(),
        durationMin: Number(duration),
        price: price === "" ? null : Number(price),
        bufferBeforeMin: Number(bBefore),
        bufferAfterMin: Number(bAfter),
      }),
    );
  const L = "flex flex-col gap-0.5 text-[10px] uppercase tracking-wider text-faint";
  return (
    <div className={`flex flex-col gap-2 rounded-lg border border-line px-3 py-2 ${service.active ? "" : "bg-subtle/40"}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{service.name} {service.active ? "" : <em className="text-faint">(inactive)</em>}</span>
        <ActiveToggle clientId={clientId} kind="service" id={service.id} name={service.name} active={service.active} run={run} pending={pending} />
      </div>
      <CopyId label="Service id" value={service.id} />
      <div className="flex flex-wrap items-end gap-2">
        <label className={L}>Name<input value={name} onChange={(e) => setName(e.target.value)} className={INPUT} /></label>
        <label className={L}>Duration (min)<input value={duration} onChange={(e) => setDuration(e.target.value)} className={`${INPUT} w-24`} /></label>
        <label className={L}>Price<input value={price} onChange={(e) => setPrice(e.target.value)} className={`${INPUT} w-24`} /></label>
        <label className={L}>Buffer before<input value={bBefore} onChange={(e) => setBBefore(e.target.value)} className={`${INPUT} w-24`} /></label>
        <label className={L}>Buffer after<input value={bAfter} onChange={(e) => setBAfter(e.target.value)} className={`${INPUT} w-24`} /></label>
      </div>
      {service.active ? (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-[10px] uppercase tracking-wider text-faint">Enabled at:</span>
          {activeSites.map((site) => {
            const on = (siteServiceMap[site.id] ?? []).includes(service.id);
            return (
              <button
                key={site.id}
                disabled={pending}
                title={on ? `Disable at ${site.name}` : `Enable at ${site.name}`}
                onClick={() => run(() => setSiteServiceAction(clientId, site.id, service.id, !on))}
                className={`rounded border px-1.5 py-0.5 text-[11px] ${on ? "border-accent bg-accent/10 text-accent" : "border-line text-muted hover:bg-subtle"}`}
              >
                {site.name}
              </button>
            );
          })}
        </div>
      ) : null}
      <button className={`${BTN} self-start`} disabled={pending || !name || !(Number(duration) > 0)} onClick={save}>Save changes</button>
    </div>
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
  const [name, setName] = useState("");
  const [duration, setDuration] = useState("60");
  const [price, setPrice] = useState("");
  const [bBefore, setBBefore] = useState("0");
  const [bAfter, setBAfter] = useState("0");
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
      });
      if (r.ok) { setName(""); setSiteIds(activeSites.map((s) => s.id)); }
      return r;
    });

  return (
    <Section title="Services">
      <div className="flex flex-col gap-3">
        {services.map((s) => (
          <EditableService key={s.id} clientId={clientId} service={s} activeSites={activeSites} siteServiceMap={siteServiceMap} run={run} pending={pending} />
        ))}
      </div>
      <div className="flex flex-col gap-2 rounded-lg border-2 border-dashed border-line-strong p-3">
        <p className="text-sm font-semibold">Add a new service</p>
        <div className="flex flex-wrap items-end gap-2">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" className={INPUT} />
          <input value={duration} onChange={(e) => setDuration(e.target.value)} placeholder="min" className={`${INPUT} w-20`} />
          <input value={price} onChange={(e) => setPrice(e.target.value)} placeholder="price" className={`${INPUT} w-24`} />
          <input value={bBefore} onChange={(e) => setBBefore(e.target.value)} placeholder="buf before" className={`${INPUT} w-24`} />
          <input value={bAfter} onChange={(e) => setBAfter(e.target.value)} placeholder="buf after" className={`${INPUT} w-24`} />
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-[10px] uppercase tracking-wider text-faint">Enable at:</span>
          {activeSites.map((site) => (
            <button
              key={site.id}
              onClick={() => toggleSite(site.id)}
              className={`rounded border px-1.5 py-0.5 text-[11px] ${siteIds.includes(site.id) ? "border-accent bg-accent/10 text-accent" : "border-line text-muted hover:bg-subtle"}`}
            >
              {site.name}
            </button>
          ))}
        </div>
        <button
          className={`${BTN} self-start`}
          disabled={pending || !name || !(Number(duration) > 0) || siteIds.length === 0}
          onClick={submit}
        >
          Add service
        </button>
      </div>
    </Section>
  );
}

/** An EXISTING staff member: editable name + weekly WORKING HOURS (seeded from the stored
 *  values; all days off = inherit the site's opening hours) + which services they perform
 *  + a copyable id. Save persists via updateStaffAction and immediately changes
 *  availability. */
function EditableStaff({ clientId, staff, siteName, offered, run, pending }: {
  clientId: string; staff: Staff; siteName: string; offered: Service[]; run: Run; pending: boolean;
}) {
  const [name, setName] = useState(staff.name);
  const [grid, setGrid] = useState<HourGrid>(gridFromWeekly(staff.working_hours));
  const save = () => run(() => updateStaffAction(clientId, staff.id, { name: name.trim(), workingHours: weeklyFromGrid(grid) }));
  return (
    <div className={`flex flex-col gap-2 rounded-lg border border-line px-3 py-2 ${staff.active ? "" : "bg-subtle/40"}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{staff.name} <span className="text-faint">· {siteName}</span> {staff.active ? "" : <em className="text-faint">(inactive)</em>}</span>
        <ActiveToggle clientId={clientId} kind="staff" id={staff.id} name={staff.name} active={staff.active} run={run} pending={pending} />
      </div>
      <CopyId label="Staff id" value={staff.id} />
      <label className="flex flex-col gap-0.5 text-[10px] uppercase tracking-wider text-faint">Name<input value={name} onChange={(e) => setName(e.target.value)} className={INPUT} /></label>
      <span className="text-[10px] uppercase tracking-wider text-faint">Working hours (all days off = inherit the site&rsquo;s opening hours)</span>
      <HoursGrid grid={grid} setGrid={setGrid} />
      <div className="flex flex-wrap items-center gap-1">
        <span className="text-[10px] uppercase tracking-wider text-faint">Services:</span>
        {offered.length === 0 ? (
          <span className="text-[11px] text-faint">No services enabled at this site yet.</span>
        ) : (
          offered.map((sv) => {
            const on = staff.serviceIds.includes(sv.id);
            return (
              <button
                key={sv.id}
                disabled={pending}
                onClick={() => run(() => setStaffServiceAction(clientId, staff.id, sv.id, !on))}
                className={`rounded border px-1.5 py-0.5 text-[11px] ${on ? "border-accent bg-accent/10 text-accent" : "border-line text-muted hover:bg-subtle"}`}
              >
                {sv.name}
              </button>
            );
          })
        )}
      </div>
      <button className={`${BTN} self-start`} disabled={pending || !name} onClick={save}>Save changes</button>
    </div>
  );
}

function StaffSection({
  clientId,
  sites,
  services,
  staff,
  siteServiceMap,
  run,
  pending,
}: {
  clientId: string;
  sites: Site[];
  services: Service[];
  staff: Staff[];
  siteServiceMap: Record<string, string[]>;
  run: Run;
  pending: boolean;
}) {
  const [name, setName] = useState("");
  const [siteId, setSiteId] = useState(sites[0]?.id ?? "");
  const [serviceIds, setServiceIds] = useState<string[]>([]);

  // A barber can only be assigned services their SITE offers (site_services) —
  // otherwise the pairing is unreachable by availability/booking anyway.
  const servicesAtSite = (sid: string): Service[] =>
    services.filter((sv) => sv.active && (siteServiceMap[sid] ?? []).includes(sv.id));

  const submit = () =>
    run(async () => {
      const r = await createStaffAction({ clientId, siteId, name: name.trim(), serviceIds });
      if (r.ok) { setName(""); setServiceIds([]); }
      return r;
    });

  const toggle = (id: string) => setServiceIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  return (
    <Section title="Staff">
      <div className="flex flex-col gap-3">
        {staff.map((s) => (
          <EditableStaff
            key={s.id}
            clientId={clientId}
            staff={s}
            siteName={sites.find((x) => x.id === s.site_id)?.name ?? "—"}
            offered={servicesAtSite(s.site_id)}
            run={run}
            pending={pending}
          />
        ))}
      </div>
      <div className="flex flex-col gap-2 rounded-lg border-2 border-dashed border-line-strong p-3">
        <p className="text-sm font-semibold">Add a new staff member</p>
        <div className="flex flex-wrap gap-2">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" className={INPUT} />
          <select
            value={siteId}
            onChange={(e) => {
              setSiteId(e.target.value);
              // Selections that the new site doesn't offer are dropped.
              setServiceIds((prev) => prev.filter((id) => (siteServiceMap[e.target.value] ?? []).includes(id)));
            }}
            className={INPUT}
          >
            {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div className="flex flex-wrap gap-1">
          {servicesAtSite(siteId).length === 0 ? (
            <span className="text-[11px] text-faint">No services enabled at this site — enable some above first.</span>
          ) : (
            servicesAtSite(siteId).map((s) => (
              <button key={s.id} onClick={() => toggle(s.id)} className={`rounded border px-1.5 py-0.5 text-[11px] ${serviceIds.includes(s.id) ? "border-accent bg-accent/10 text-accent" : "border-line text-muted hover:bg-subtle"}`}>
                {s.name}
              </button>
            ))
          )}
        </div>
        <button className={BTN} disabled={pending || !name || !siteId} onClick={submit}>Add staff</button>
      </div>
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
    <Section title="Exceptions (blocked time)">
      <ul className="flex flex-col gap-1 text-sm">
        {exceptions.length === 0 ? <li className="text-muted">No upcoming exceptions.</li> : null}
        {exceptions.map((e) => {
          const site = sites.find((x) => x.id === e.site_id);
          const st = staff.find((x) => x.id === e.staff_id);
          return (
            <li key={e.id} className="flex items-center justify-between rounded-lg border border-line px-3 py-2">
              <span>{fmt(e.starts_at)} → {fmt(e.ends_at)} <span className="text-faint">· {site?.name ?? "—"} · {st ? st.name : "whole site"}{e.reason ? ` · ${e.reason}` : ""}</span></span>
              <button className={GHOST} disabled={pending} onClick={() => run(() => deleteExceptionAction(clientId, e.id))}>Delete</button>
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap items-end gap-2 rounded-lg border border-line bg-card p-3">
        <select value={siteId} onChange={(e) => { setSiteId(e.target.value); setStaffId(""); }} className={INPUT}>
          {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select value={staffId} onChange={(e) => setStaffId(e.target.value)} className={INPUT}>
          <option value="">Whole site</option>
          {staff.filter((s) => s.site_id === siteId).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} className={INPUT} />
        <input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} className={INPUT} />
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="reason" className={INPUT} />
        <button className={BTN} disabled={pending || !siteId || !start || !end} onClick={submit}>Add exception</button>
      </div>
    </Section>
  );
}

"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { DAYS, gridFromWeekly, HoursGrid, weeklyFromGrid, type HourGrid } from "./HoursGrid";
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
      {/* STAFF moved OUT of this page to its own SCHEDULING route: the roster, its
          statuses, performance, creating a barber and their weekly hours all live
          there now. The 7-day grid those two screens share was extracted to
          ./HoursGrid rather than copied — this page still uses it for a SITE's
          opening hours. */}
      <div className="rounded-lg border border-line bg-surface px-4 py-3 text-sm">
        <p className="text-muted">
          The staff <strong className="font-medium text-foreground">roster</strong> — who is working, who is free,
          performance, hours and services — lives on its own screen.{" "}
          <Link href={`/clients/${clientId}/scheduling/staff`} className="text-accent hover:underline">
            Open Scheduling &rarr; Staff
          </Link>
        </p>
        <p className="mt-1 text-xs text-faint">
          What stays here: sites, the service catalogue and blocked time.
        </p>
      </div>
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
        {(() => {
          const notice = site.scheduling_config.min_notice_min;
          const h = Math.floor(notice / 60);
          const m = notice % 60;
          const noticeText = notice === 0 ? "none" : h > 0 ? `${h} h${m ? ` ${m} min` : ""}` : `${m} min`;
          return (
            <p>
              <span className="text-faint">Minimum notice:</span>{" "}
              {notice > 0 ? (
                <span className="text-accent">{noticeText} — the first {noticeText} from now are never offered today (edit under Sites above).</span>
              ) : (
                <span>none — same-minute bookings allowed</span>
              )}
              <span className="text-faint">{" · "}booking horizon {site.scheduling_config.booking_horizon_days} days · slots every {site.scheduling_config.slot_interval_min} min</span>
            </p>
          );
        })()}
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
  // Booking rules that used to be config-only — now visible + editable. min_notice is why
  // "availability starts N minutes from now"; horizon caps how far ahead; slot is the grid.
  const [minNotice, setMinNotice] = useState(String(site.scheduling_config.min_notice_min));
  const [horizon, setHorizon] = useState(String(site.scheduling_config.booking_horizon_days));
  const [slotMin, setSlotMin] = useState(String(site.scheduling_config.slot_interval_min));
  const nums = [minNotice, horizon, slotMin].map((v) => Number(v));
  const numsOk =
    nums.every((n) => Number.isFinite(n) && Number.isInteger(n)) &&
    nums[0] >= 0 && nums[1] >= 1 && nums[2] >= 1;
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
      <span className="text-[10px] uppercase tracking-wider text-faint">Booking rules</span>
      <div className="flex flex-wrap gap-2">
        <label className="flex flex-col gap-0.5 text-[10px] uppercase tracking-wider text-faint" title="The first N minutes from now are never offered — this is why availability seems to start later today.">
          Minimum notice (min)
          <input type="number" min={0} value={minNotice} onChange={(e) => setMinNotice(e.target.value)} className={INPUT} />
        </label>
        <label className="flex flex-col gap-0.5 text-[10px] uppercase tracking-wider text-faint" title="How many days ahead bookings are offered.">
          Booking horizon (days)
          <input type="number" min={1} value={horizon} onChange={(e) => setHorizon(e.target.value)} className={INPUT} />
        </label>
        <label className="flex flex-col gap-0.5 text-[10px] uppercase tracking-wider text-faint" title="The spacing between offered start times.">
          Slot granularity (min)
          <input type="number" min={1} value={slotMin} onChange={(e) => setSlotMin(e.target.value)} className={INPUT} />
        </label>
      </div>
      <span className="text-[10px] uppercase tracking-wider text-faint">Weekly opening hours</span>
      <HoursGrid grid={grid} setGrid={setGrid} />
      <button className={`${BTN} self-start`} disabled={pending || !name || !slug || !numsOk} onClick={save}>Save changes</button>
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

/**
 * The colour families a service can be filed under — the ones with a palette on the
 * agenda (globals.css `.u-appt-*`), which is the same closed set the
 * services_category_valid CHECK enforces. "Unclassified" is a real, storable choice:
 * it returns the service to being coloured by keywords in its name.
 */
const CATEGORY_OPTIONS = [
  { value: "", label: "Unclassified" },
  { value: "color", label: "Colour" },
  { value: "grooming", label: "Grooming / beard" },
  { value: "cut", label: "Cut" },
  { value: "feature", label: "Featured treatment" },
] as const;

/** An EXISTING service's editable settings (name/duration/price/buffers/category) + its
 *  per-site enablement toggles + a copyable id. Save persists via updateServiceAction. */
function EditableService({ clientId, service, activeSites, siteServiceMap, run, pending }: {
  clientId: string; service: Service; activeSites: Site[]; siteServiceMap: Record<string, string[]>; run: Run; pending: boolean;
}) {
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
  const L = "flex flex-col gap-0.5 text-[10px] uppercase tracking-wider text-faint";
  return (
    <div className={`flex flex-col gap-2 rounded-lg border border-line px-3 py-2 ${service.active ? "" : "bg-subtle/40"}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">
          {service.name} {service.active ? "" : <em className="text-faint">(inactive)</em>}
          {service.featured ? <span className="ml-1 rounded bg-accent/10 px-1.5 py-0.5 text-[10px] font-normal text-accent">featured</span> : null}
        </span>
        <ActiveToggle clientId={clientId} kind="service" id={service.id} name={service.name} active={service.active} run={run} pending={pending} />
      </div>
      <CopyId label="Service id" value={service.id} />
      <label className="flex w-fit items-center gap-1.5 text-xs text-muted">
        <input type="checkbox" checked={featured} onChange={(e) => setFeatured(e.target.checked)} />
        Featured — offered first by the assistant
      </label>
      <div className="flex flex-wrap items-end gap-2">
        <label className={L}>Name<input value={name} onChange={(e) => setName(e.target.value)} className={INPUT} /></label>
        <label className={L}>Duration (min)<input value={duration} onChange={(e) => setDuration(e.target.value)} className={`${INPUT} w-24`} /></label>
        <label className={L}>Price<input value={price} onChange={(e) => setPrice(e.target.value)} className={`${INPUT} w-24`} /></label>
        <label className={L}>Buffer before<input value={bBefore} onChange={(e) => setBBefore(e.target.value)} className={`${INPUT} w-24`} /></label>
        <label className={L}>Buffer after<input value={bAfter} onChange={(e) => setBAfter(e.target.value)} className={`${INPUT} w-24`} /></label>
        <label className={L}>Category
          <select value={category} onChange={(e) => setCategory(e.target.value)} className={`${INPUT} w-44`}>
            {CATEGORY_OPTIONS.map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
        </label>
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
      if (r.ok) { setName(""); setCategory(""); setSiteIds(activeSites.map((s) => s.id)); }
      return r;
    });

  return (
    <Section title="Services">
      <p className="text-[11px] text-faint">
        Featured services are the ones the assistant offers first when a customer hasn’t said
        what they want. If none are marked, it offers all of them. The category decides the
        colour a booking wears on the agenda; leave it unclassified to keep inferring it
        from the name.
      </p>
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
          <select value={category} onChange={(e) => setCategory(e.target.value)} className={`${INPUT} w-44`} aria-label="Category">
            {CATEGORY_OPTIONS.map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
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

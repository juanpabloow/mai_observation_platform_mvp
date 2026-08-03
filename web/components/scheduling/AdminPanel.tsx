"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
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
} from "@/lib/schedulingAdminActions";

type WeeklyHours = Record<string, Array<{ start: string; end: string }>>;

interface Site {
  id: string; client_id: string; slug: string; name: string; address: string | null; timezone: string; active: boolean;
}
interface Service {
  id: string; name: string; description: string | null; duration_min: number;
  price: string | null; buffer_before_min: number; buffer_after_min: number; active: boolean;
}
interface Staff { id: string; site_id: string; name: string; active: boolean; serviceIds: string[] }
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

      <SitesSection clientId={clientId} sites={sites} run={run} pending={pending} />
      <ServicesSection clientId={clientId} sites={sites} services={services} siteServiceMap={siteServiceMap} run={run} pending={pending} />
      <StaffSection clientId={clientId} sites={sites} services={services} staff={staff} siteServiceMap={siteServiceMap} run={run} pending={pending} />
      <ExceptionsSection clientId={clientId} sites={sites} staff={staff} exceptions={exceptions} run={run} pending={pending} />
    </main>
  );
}

type Run = (fn: () => Promise<{ ok: boolean; error?: string }>) => void;

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

function SitesSection({ clientId, sites, run, pending }: { clientId: string; sites: Site[]; run: Run; pending: boolean }) {
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [tz, setTz] = useState("America/Bogota");
  const [hours, setHours] = useState<Record<string, { on: boolean; start: string; end: string }>>(
    Object.fromEntries(DAYS.map((d) => [d, { on: d !== "sun", start: "09:00", end: "18:00" }])),
  );

  const submit = () => {
    const openingHours: WeeklyHours = {};
    for (const d of DAYS) if (hours[d].on) openingHours[d] = [{ start: hours[d].start, end: hours[d].end }];
    run(async () => {
      const r = await createSiteAction({ clientId, slug: slug.trim(), name: name.trim(), timezone: tz, openingHours });
      if (r.ok) { setSlug(""); setName(""); }
      return r;
    });
  };

  return (
    <Section title="Sites">
      <ul className="flex flex-col gap-1 text-sm">
        {sites.map((s) => (
          <li key={s.id} className="flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2">
            <div className="flex min-w-0 flex-col gap-1">
              <span>{s.name} <span className="text-faint">/{s.slug} · {s.timezone}</span> {s.active ? "" : <em className="text-faint">(inactive)</em>}</span>
              <CopyId label="Site id" value={s.id} />
            </div>
            {s.active ? <button className={GHOST} disabled={pending} onClick={() => run(() => deactivateSiteAction(clientId, s.id))}>Deactivate</button> : null}
          </li>
        ))}
      </ul>
      <div className="flex flex-col gap-2 rounded-lg border border-line bg-card p-3">
        <div className="flex flex-wrap gap-2">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" className={INPUT} />
          <input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="slug (public URL)" className={INPUT} />
          <input value={tz} onChange={(e) => setTz(e.target.value)} placeholder="IANA timezone" className={INPUT} />
        </div>
        <div className="flex flex-col gap-1">
          {DAYS.map((d) => (
            <div key={d} className="flex items-center gap-2 text-xs">
              <label className="flex w-16 items-center gap-1">
                <input type="checkbox" checked={hours[d].on} onChange={(e) => setHours({ ...hours, [d]: { ...hours[d], on: e.target.checked } })} />
                {d}
              </label>
              <input type="time" value={hours[d].start} onChange={(e) => setHours({ ...hours, [d]: { ...hours[d], start: e.target.value } })} className={INPUT} />
              <input type="time" value={hours[d].end} onChange={(e) => setHours({ ...hours, [d]: { ...hours[d], end: e.target.value } })} className={INPUT} />
            </div>
          ))}
        </div>
        <button className={BTN} disabled={pending || !slug || !name} onClick={submit}>Add site</button>
      </div>
    </Section>
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
      <ul className="flex flex-col gap-1 text-sm">
        {services.map((s) => (
          <li key={s.id} className="flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2">
            <div>
              <span>{s.name} <span className="text-faint">· {s.duration_min}m · buffers {s.buffer_before_min}/{s.buffer_after_min}{s.price ? ` · ${s.price}` : ""}</span> {s.active ? "" : <em className="text-faint">(inactive)</em>}</span>
              {/* Per-site enablement (site_services): this is what makes the service
                  bookable at a site — /book/{slug} and availability only see enabled
                  pairs. Toggling writes through setSiteServiceAction. */}
              {s.active ? (
                <div className="mt-1 flex flex-wrap items-center gap-1">
                  <span className="text-[10px] uppercase tracking-wider text-faint">Sites:</span>
                  {activeSites.map((site) => {
                    const on = (siteServiceMap[site.id] ?? []).includes(s.id);
                    return (
                      <button
                        key={site.id}
                        disabled={pending}
                        title={on ? `Disable at ${site.name}` : `Enable at ${site.name}`}
                        onClick={() => run(() => setSiteServiceAction(clientId, site.id, s.id, !on))}
                        className={`rounded border px-1.5 py-0.5 text-[11px] ${on ? "border-accent bg-accent/10 text-accent" : "border-line text-muted hover:bg-subtle"}`}
                      >
                        {site.name}
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
            {s.active ? <button className={GHOST} disabled={pending} onClick={() => run(() => deactivateServiceAction(clientId, s.id))}>Deactivate</button> : null}
          </li>
        ))}
      </ul>
      <div className="flex flex-col gap-2 rounded-lg border border-line bg-card p-3">
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
      <ul className="flex flex-col gap-1 text-sm">
        {staff.map((s) => {
          const site = sites.find((x) => x.id === s.site_id);
          const offered = servicesAtSite(s.site_id);
          return (
            <li key={s.id} className="flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2">
              <div>
                <span>{s.name} <span className="text-faint">· {site?.name ?? "—"}</span> {s.active ? "" : <em className="text-faint">(inactive)</em>}</span>
                <div className="mt-1 flex flex-wrap gap-1">
                  {offered.length === 0 ? (
                    <span className="text-[11px] text-faint">No services enabled at this site yet.</span>
                  ) : (
                    offered.map((sv) => {
                      const on = s.serviceIds.includes(sv.id);
                      return (
                        <button
                          key={sv.id}
                          disabled={pending}
                          onClick={() => run(() => setStaffServiceAction(clientId, s.id, sv.id, !on))}
                          className={`rounded border px-1.5 py-0.5 text-[11px] ${on ? "border-accent bg-accent/10 text-accent" : "border-line text-muted hover:bg-subtle"}`}
                        >
                          {sv.name}
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
              {s.active ? <button className={GHOST} disabled={pending} onClick={() => run(() => deactivateStaffAction(clientId, s.id))}>Deactivate</button> : null}
            </li>
          );
        })}
      </ul>
      <div className="flex flex-col gap-2 rounded-lg border border-line bg-card p-3">
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

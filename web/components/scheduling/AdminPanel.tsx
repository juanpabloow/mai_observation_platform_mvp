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
  setStaffServiceAction,
} from "@/lib/schedulingAdminActions";

type WeeklyHours = Record<string, Array<{ start: string; end: string }>>;

interface Site {
  id: string; slug: string; name: string; address: string | null; timezone: string; active: boolean;
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

export function AdminPanel({
  sites,
  services,
  staff,
  exceptions,
}: {
  sites: Site[];
  services: Service[];
  staff: Staff[];
  exceptions: Exception[];
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
      <h1 className="text-xl font-semibold tracking-tight">Scheduling admin</h1>
      {error ? <p className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p> : null}

      <SitesSection sites={sites} run={run} pending={pending} />
      <ServicesSection services={services} run={run} pending={pending} />
      <StaffSection sites={sites} services={services} staff={staff} run={run} pending={pending} />
      <ExceptionsSection sites={sites} staff={staff} exceptions={exceptions} run={run} pending={pending} />
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

function SitesSection({ sites, run, pending }: { sites: Site[]; run: Run; pending: boolean }) {
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
      const r = await createSiteAction({ slug: slug.trim(), name: name.trim(), timezone: tz, openingHours });
      if (r.ok) { setSlug(""); setName(""); }
      return r;
    });
  };

  return (
    <Section title="Sites">
      <ul className="flex flex-col gap-1 text-sm">
        {sites.map((s) => (
          <li key={s.id} className="flex items-center justify-between rounded-lg border border-line px-3 py-2">
            <span>{s.name} <span className="text-faint">/{s.slug} · {s.timezone}</span> {s.active ? "" : <em className="text-faint">(inactive)</em>}</span>
            {s.active ? <button className={GHOST} disabled={pending} onClick={() => run(() => deactivateSiteAction(s.id))}>Deactivate</button> : null}
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

function ServicesSection({ services, run, pending }: { services: Service[]; run: Run; pending: boolean }) {
  const [name, setName] = useState("");
  const [duration, setDuration] = useState("60");
  const [price, setPrice] = useState("");
  const [bBefore, setBBefore] = useState("0");
  const [bAfter, setBAfter] = useState("0");

  const submit = () =>
    run(async () => {
      const r = await createServiceAction({
        name: name.trim(),
        durationMin: Number(duration),
        price: price ? Number(price) : null,
        bufferBeforeMin: Number(bBefore),
        bufferAfterMin: Number(bAfter),
      });
      if (r.ok) { setName(""); }
      return r;
    });

  return (
    <Section title="Services">
      <ul className="flex flex-col gap-1 text-sm">
        {services.map((s) => (
          <li key={s.id} className="flex items-center justify-between rounded-lg border border-line px-3 py-2">
            <span>{s.name} <span className="text-faint">· {s.duration_min}m · buffers {s.buffer_before_min}/{s.buffer_after_min}{s.price ? ` · ${s.price}` : ""}</span> {s.active ? "" : <em className="text-faint">(inactive)</em>}</span>
            {s.active ? <button className={GHOST} disabled={pending} onClick={() => run(() => deactivateServiceAction(s.id))}>Deactivate</button> : null}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-end gap-2 rounded-lg border border-line bg-card p-3">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" className={INPUT} />
        <input value={duration} onChange={(e) => setDuration(e.target.value)} placeholder="min" className={`${INPUT} w-20`} />
        <input value={price} onChange={(e) => setPrice(e.target.value)} placeholder="price" className={`${INPUT} w-24`} />
        <input value={bBefore} onChange={(e) => setBBefore(e.target.value)} placeholder="buf before" className={`${INPUT} w-24`} />
        <input value={bAfter} onChange={(e) => setBAfter(e.target.value)} placeholder="buf after" className={`${INPUT} w-24`} />
        <button className={BTN} disabled={pending || !name || !(Number(duration) > 0)} onClick={submit}>Add service</button>
      </div>
    </Section>
  );
}

function StaffSection({ sites, services, staff, run, pending }: { sites: Site[]; services: Service[]; staff: Staff[]; run: Run; pending: boolean }) {
  const [name, setName] = useState("");
  const [siteId, setSiteId] = useState(sites[0]?.id ?? "");
  const [serviceIds, setServiceIds] = useState<string[]>([]);

  const submit = () =>
    run(async () => {
      const r = await createStaffAction({ siteId, name: name.trim(), serviceIds });
      if (r.ok) { setName(""); setServiceIds([]); }
      return r;
    });

  const toggle = (id: string) => setServiceIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  return (
    <Section title="Staff">
      <ul className="flex flex-col gap-1 text-sm">
        {staff.map((s) => {
          const site = sites.find((x) => x.id === s.site_id);
          return (
            <li key={s.id} className="flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2">
              <div>
                <span>{s.name} <span className="text-faint">· {site?.name ?? "—"}</span> {s.active ? "" : <em className="text-faint">(inactive)</em>}</span>
                <div className="mt-1 flex flex-wrap gap-1">
                  {services.filter((sv) => sv.active).map((sv) => {
                    const on = s.serviceIds.includes(sv.id);
                    return (
                      <button
                        key={sv.id}
                        disabled={pending}
                        onClick={() => run(() => setStaffServiceAction(s.id, sv.id, !on))}
                        className={`rounded border px-1.5 py-0.5 text-[11px] ${on ? "border-accent bg-accent/10 text-accent" : "border-line text-muted hover:bg-subtle"}`}
                      >
                        {sv.name}
                      </button>
                    );
                  })}
                </div>
              </div>
              {s.active ? <button className={GHOST} disabled={pending} onClick={() => run(() => deactivateStaffAction(s.id))}>Deactivate</button> : null}
            </li>
          );
        })}
      </ul>
      <div className="flex flex-col gap-2 rounded-lg border border-line bg-card p-3">
        <div className="flex flex-wrap gap-2">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" className={INPUT} />
          <select value={siteId} onChange={(e) => setSiteId(e.target.value)} className={INPUT}>
            {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div className="flex flex-wrap gap-1">
          {services.filter((s) => s.active).map((s) => (
            <button key={s.id} onClick={() => toggle(s.id)} className={`rounded border px-1.5 py-0.5 text-[11px] ${serviceIds.includes(s.id) ? "border-accent bg-accent/10 text-accent" : "border-line text-muted hover:bg-subtle"}`}>
              {s.name}
            </button>
          ))}
        </div>
        <button className={BTN} disabled={pending || !name || !siteId} onClick={submit}>Add staff</button>
      </div>
    </Section>
  );
}

function ExceptionsSection({ sites, staff, exceptions, run, pending }: { sites: Site[]; staff: Staff[]; exceptions: Exception[]; run: Run; pending: boolean }) {
  const [siteId, setSiteId] = useState(sites[0]?.id ?? "");
  const [staffId, setStaffId] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [reason, setReason] = useState("");

  const submit = () =>
    run(async () => {
      const r = await createExceptionAction({
        siteId,
        staffId: staffId || null,
        startsAt: new Date(start).toISOString(),
        endsAt: new Date(end).toISOString(),
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
              <button className={GHOST} disabled={pending} onClick={() => run(() => deleteExceptionAction(e.id))}>Delete</button>
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

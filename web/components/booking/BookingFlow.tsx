"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Public booking flow: service → barber (or "any") → date → real availability →
 * slot → customer details → create → confirmation. Calls the public
 * /api/booking/{slug}/* endpoints (same engine as internal + n8n). A per-attempt
 * Idempotency-Key makes a double-submit safe.
 */

interface Service { id: string; name: string; description: string | null; duration_min: number; price: string | null }
interface Staff { id: string; name: string }
interface Slot { start_at: string; service_end_at: string; staff_id: string; available_staff_ids: string[] }
interface Confirmation { reference: string; site: string; service: string; staff_name: string | null; start_at: string; service_end_at: string; timezone: string; status: string }

const BTN = "rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50";
const INPUT = "w-full rounded-lg border border-line-strong bg-transparent px-3 py-2 text-sm";

function fmtTime(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("es-CO", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
}
function localDate(iso: string, tz: string): string {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
  return p; // en-CA → YYYY-MM-DD
}

export function BookingFlow({ slug, timezone }: { slug: string; timezone: string }) {
  const [services, setServices] = useState<Service[]>([]);
  const [serviceId, setServiceId] = useState("");
  const [staff, setStaff] = useState<Staff[]>([]);
  const [staffId, setStaffId] = useState<string>(""); // "" = any
  const [date, setDate] = useState("");
  const [slots, setSlots] = useState<Slot[]>([]);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const idemKey = useRef<string>("");

  // Load services on mount.
  useEffect(() => {
    fetch(`/api/booking/${slug}/services`)
      .then((r) => r.json())
      .then((d) => setServices(d.services ?? []))
      .catch(() => setError("Could not load services."));
  }, [slug]);

  // Choose a service: reset the downstream picks and load that service's staff.
  const selectService = (id: string) => {
    setServiceId(id);
    setStaff([]);
    setStaffId("");
    setDate("");
    setSlots([]);
    setSlot(null);
    fetch(`/api/booking/${slug}/staff?service_id=${id}`)
      .then((r) => r.json())
      .then((d) => setStaff(d.staff ?? []))
      .catch(() => undefined);
  };

  // Explicit args (not closure state) so it's safe to call straight from event
  // handlers before the corresponding setState has flushed.
  const loadAvailability = useCallback(
    async (svc: string, stf: string, day: string) => {
      if (!svc || !day) return;
      setError(null);
      setLoading(true);
      setSlots([]);
      setSlot(null);
      try {
        const dayUtc = new Date(`${day}T00:00:00Z`).getTime();
        const from = new Date(dayUtc - 12 * 3600_000).toISOString();
        const to = new Date(dayUtc + 36 * 3600_000).toISOString();
        const params = new URLSearchParams({ service_id: svc, from, to });
        if (stf) params.set("staff_id", stf);
        const res = await fetch(`/api/booking/${slug}/availability?${params.toString()}`);
        if (!res.ok) {
          setError("Could not load availability.");
          return;
        }
        const data = (await res.json()) as { slots: Slot[] };
        setSlots(data.slots.filter((s) => localDate(s.start_at, timezone) === day));
      } finally {
        setLoading(false);
      }
    },
    [slug, timezone],
  );

  const submit = async () => {
    if (!slot || !name.trim() || !phone.trim()) {
      setError("Please complete name, phone and pick a time.");
      return;
    }
    setError(null);
    setLoading(true);
    if (!idemKey.current) idemKey.current = crypto.randomUUID();
    try {
      const res = await fetch(`/api/booking/${slug}`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": idemKey.current },
        body: JSON.stringify({
          service_id: serviceId,
          staff_id: staffId || slot.staff_id, // "any" → the slot's chosen staff
          start_at: slot.start_at,
          customer_name: name.trim(),
          customer_phone: phone.trim(),
          customer_email: email.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error?.message ?? "Could not complete the booking.");
        // On a slot conflict, refresh availability so the customer can re-pick.
        if (res.status === 409) void loadAvailability(serviceId, staffId, date);
        return;
      }
      setConfirmation(data.confirmation as Confirmation);
    } finally {
      setLoading(false);
    }
  };

  if (confirmation) {
    return (
      <div className="flex flex-col gap-3 rounded-xl border border-line bg-card p-5">
        <h2 className="text-lg font-semibold text-success">Booking confirmed ✓</h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted">Reference</dt><dd className="font-mono text-xs">{confirmation.reference}</dd>
          <dt className="text-muted">Location</dt><dd>{confirmation.site}</dd>
          <dt className="text-muted">Service</dt><dd>{confirmation.service}</dd>
          <dt className="text-muted">Barber</dt><dd>{confirmation.staff_name ?? "—"}</dd>
          <dt className="text-muted">Date</dt><dd>{new Intl.DateTimeFormat("es-CO", { timeZone: confirmation.timezone, dateStyle: "full" }).format(new Date(confirmation.start_at))}</dd>
          <dt className="text-muted">Time</dt><dd>{fmtTime(confirmation.start_at, confirmation.timezone)}–{fmtTime(confirmation.service_end_at, confirmation.timezone)}</dd>
        </dl>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {error ? <p className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p> : null}

      <Step n={1} label="Choose a service">
        <div className="flex flex-col gap-2">
          {services.map((s) => (
            <button
              key={s.id}
              onClick={() => selectService(s.id)}
              className={`flex items-center justify-between rounded-lg border px-3 py-2 text-left text-sm ${serviceId === s.id ? "border-accent bg-accent/10" : "border-line hover:bg-subtle"}`}
            >
              <span>{s.name} <span className="text-faint">· {s.duration_min}m</span></span>
              {s.price ? <span className="text-muted">{s.price}</span> : null}
            </button>
          ))}
          {services.length === 0 ? <p className="text-sm text-muted">Loading services…</p> : null}
        </div>
      </Step>

      {serviceId ? (
        <Step n={2} label="Choose a barber">
          <div className="flex flex-wrap gap-2">
            <Chip on={staffId === ""} onClick={() => { setStaffId(""); if (date) void loadAvailability(serviceId, "", date); }}>Any barber</Chip>
            {staff.map((s) => (
              <Chip key={s.id} on={staffId === s.id} onClick={() => { setStaffId(s.id); if (date) void loadAvailability(serviceId, s.id, date); }}>{s.name}</Chip>
            ))}
          </div>
        </Step>
      ) : null}

      {serviceId ? (
        <Step n={3} label="Pick a date">
          <input
            type="date"
            value={date}
            onChange={(e) => {
              setDate(e.target.value);
              if (e.target.value) void loadAvailability(serviceId, staffId, e.target.value);
            }}
            className={INPUT}
          />
        </Step>
      ) : null}

      {serviceId && date ? (
        <Step n={4} label="Pick a time">
          {loading ? (
            <p className="text-sm text-muted">Loading times…</p>
          ) : slots.length === 0 ? (
            <p className="text-sm text-muted">No available times that day.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {slots.map((s) => (
                <Chip key={`${s.start_at}-${s.staff_id}`} on={slot?.start_at === s.start_at} onClick={() => setSlot(s)}>
                  {fmtTime(s.start_at, timezone)}
                </Chip>
              ))}
            </div>
          )}
        </Step>
      ) : null}

      {slot ? (
        <Step n={5} label="Your details">
          <div className="flex flex-col gap-2">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" className={INPUT} />
            <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Phone (e.g. +57300…)" className={INPUT} />
            <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email (optional)" className={INPUT} />
            <button onClick={submit} disabled={loading || !name.trim() || !phone.trim()} className={BTN}>
              {loading ? "Booking…" : "Confirm booking"}
            </button>
          </div>
        </Step>
      ) : null}
    </div>
  );
}

function Step({ n, label, children }: { n: number; label: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-medium">
        <span className="mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-subtle text-xs">{n}</span>
        {label}
      </h2>
      {children}
    </section>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-lg border px-3 py-1.5 text-sm ${on ? "border-accent bg-accent/10 text-accent" : "border-line hover:bg-subtle"}`}
    >
      {children}
    </button>
  );
}

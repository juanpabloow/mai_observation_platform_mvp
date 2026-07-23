"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useState, useTransition } from "react";
import { AutoRefresh } from "@/components/AutoRefresh";
import {
  cancelAppointmentAction,
  completeAppointmentAction,
  confirmAppointmentAction,
  createManualAppointmentAction,
  noShowAppointmentAction,
  rescheduleAppointmentAction,
} from "@/lib/schedulingActions";

/** Serializable shapes passed from the server page. */
interface SiteOpt { id: string; name: string; timezone: string }
interface StaffOpt { id: string; name: string }
interface ServiceOpt { id: string; name: string; duration_min: number }
interface Appt {
  id: string;
  staff_id: string;
  staff_name: string | null;
  service_id: string;
  start_at: string;
  service_end_at: string;
  service_name: string;
  status: string;
  origin: string;
  contact_id: string | null;
  contact_name: string | null;
  source_conversation_id: string | null;
}
interface Slot { start_at: string; service_end_at: string; staff_id: string; available_staff_ids: string[] }

const STATUS_STYLE: Record<string, string> = {
  scheduled: "bg-subtle text-foreground",
  confirmed: "bg-accent/15 text-accent",
  completed: "bg-success/15 text-success",
  cancelled: "text-faint line-through",
  no_show: "text-danger",
};

function fmtTime(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("es-CO", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
}

export function AgendaView(props: {
  /** The validated owning client — every action is sent with this id. */
  clientId: string;
  /** Canonical route base, e.g. /clients/{id}/scheduling/agenda. */
  basePath: string;
  /** Client-scoped contacts base, or null when CRM is disabled for this client. */
  contactsBase: string | null;
  /** Origin workflow to preserve across navigation (?from=). */
  from: string | null;
  /** owner/admin — controls whether admin links (Add staff) render. */
  canManage: boolean;
  timezone: string;
  date: string;
  dayStartIso: string;
  dayEndIso: string;
  sites: SiteOpt[];
  currentSiteId: string;
  staff: StaffOpt[];
  services: ServiceOpt[];
  appointments: Appt[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<null | { mode: "new" | "walkin" } | { mode: "reschedule"; appt: Appt }>(null);

  const navigate = (patch: { site?: string; date?: string }) => {
    const params = new URLSearchParams();
    params.set("site", patch.site ?? props.currentSiteId);
    params.set("date", patch.date ?? props.date);
    if (props.from) params.set("from", props.from); // keep the origin workflow
    router.push(`${props.basePath}?${params.toString()}`);
  };

  const fromQS = props.from ? `?from=${encodeURIComponent(props.from)}` : "";

  const shiftDate = (days: number) => {
    const [y, m, d] = props.date.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d + days));
    navigate({ date: `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}` });
  };

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setError(null);
    startTransition(async () => {
      const r = await fn();
      if (!r.ok) setError(r.error ?? "Action failed.");
      else router.refresh();
    });
  };

  const activeByStaff = (staffId: string) =>
    props.appointments
      .filter((a) => a.staff_id === staffId)
      .sort((a, b) => a.start_at.localeCompare(b.start_at));

  return (
    <main className="flex min-h-0 flex-1 flex-col gap-4 px-6 py-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Agenda</h1>
          <select
            value={props.currentSiteId}
            onChange={(e) => navigate({ site: e.target.value })}
            className="rounded-lg border border-line-strong bg-transparent px-2 py-1 text-sm"
          >
            {props.sites.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
          <div className="flex items-center gap-1">
            <button onClick={() => shiftDate(-1)} className="rounded-lg border border-line px-2 py-1 text-sm hover:bg-subtle">←</button>
            <input
              type="date"
              value={props.date}
              onChange={(e) => e.target.value && navigate({ date: e.target.value })}
              className="rounded-lg border border-line-strong bg-transparent px-2 py-1 text-sm"
            />
            <button onClick={() => shiftDate(1)} className="rounded-lg border border-line px-2 py-1 text-sm hover:bg-subtle">→</button>
          </div>
          <AutoRefresh intervalSeconds={20} />
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setModal({ mode: "walkin" })}
            className="rounded-lg border border-line px-3 py-1.5 text-sm hover:bg-subtle"
          >
            Walk-in
          </button>
          <button
            onClick={() => setModal({ mode: "new" })}
            className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white"
          >
            New appointment
          </button>
        </div>
      </header>

      {error ? <p className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p> : null}

      {props.staff.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line-strong px-5 py-8">
          {props.canManage ? (
            <p className="text-sm text-muted">
              No staff at this site yet. <Link href="/scheduling/admin" className="text-accent hover:underline">Add staff</Link>.
            </p>
          ) : (
            // A member can't open the tenant-level Scheduling admin — message only.
            <p className="text-sm text-muted">No staff at this site yet. Ask your administrator to add staff.</p>
          )}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto">
          {props.staff.map((st) => (
            <section key={st.id} className="flex w-64 shrink-0 flex-col gap-2">
              <h2 className="sticky top-0 border-b border-line pb-1 text-sm font-medium">{st.name}</h2>
              {activeByStaff(st.id).length === 0 ? (
                <p className="text-xs text-faint">No appointments</p>
              ) : (
                activeByStaff(st.id).map((a) => (
                  <article key={a.id} className="rounded-lg border border-line bg-card p-3 text-sm">
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{fmtTime(a.start_at, props.timezone)}–{fmtTime(a.service_end_at, props.timezone)}</span>
                      <span className={`rounded px-1.5 py-0.5 text-[11px] ${STATUS_STYLE[a.status] ?? ""}`}>{a.status}</span>
                    </div>
                    <p className="mt-1">{a.service_name}</p>
                    <p className="text-xs text-muted">
                      {/* Contact links only when CRM is enabled for this client. */}
                      {a.contact_id && props.contactsBase ? (
                        <Link href={`${props.contactsBase}/${a.contact_id}${fromQS}`} className="hover:underline">
                          {a.contact_name ?? "Contact"}
                        </Link>
                      ) : (
                        <span>{a.contact_id ? (a.contact_name ?? "Contact") : "Walk-in"}</span>
                      )}
                      {" · "}
                      <span className="text-faint">{a.origin}</span>
                    </p>
                    {a.source_conversation_id && a.contact_id && props.contactsBase ? (
                      <p className="text-xs">
                        <Link
                          href={`${props.contactsBase}/${a.contact_id}${fromQS ? `${fromQS}&` : "?"}tab=conversations`}
                          className="text-accent hover:underline"
                        >
                          View conversation
                        </Link>
                      </p>
                    ) : null}
                    {a.status === "scheduled" || a.status === "confirmed" ? (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {a.status === "scheduled" ? (
                          <ActBtn label="Confirm" disabled={pending} onClick={() => run(() => confirmAppointmentAction(props.clientId, a.id))} />
                        ) : null}
                        <ActBtn label="Complete" disabled={pending} onClick={() => run(() => completeAppointmentAction(props.clientId, a.id))} />
                        <ActBtn label="No-show" disabled={pending} onClick={() => run(() => noShowAppointmentAction(props.clientId, a.id))} />
                        <ActBtn label="Reschedule" disabled={pending} onClick={() => setModal({ mode: "reschedule", appt: a })} />
                        <ActBtn label="Cancel" danger disabled={pending} onClick={() => run(() => cancelAppointmentAction(props.clientId, a.id))} />
                      </div>
                    ) : null}
                  </article>
                ))
              )}
            </section>
          ))}
        </div>
      )}

      {modal ? (
        <AppointmentModal
          {...props}
          modal={modal}
          onClose={() => setModal(null)}
          onError={setError}
          onDone={() => {
            setModal(null);
            router.refresh();
          }}
        />
      ) : null}
    </main>
  );
}

function ActBtn({ label, onClick, danger, disabled }: { label: string; onClick: () => void; danger?: boolean; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`rounded border px-1.5 py-0.5 text-[11px] transition-colors disabled:opacity-50 ${
        danger ? "border-danger/40 text-danger hover:bg-danger/10" : "border-line hover:bg-subtle"
      }`}
    >
      {label}
    </button>
  );
}

/** Modal for new appointment / walk-in / reschedule — fetches real availability. */
function AppointmentModal(props: {
  clientId: string;
  timezone: string;
  currentSiteId: string;
  dayStartIso: string;
  dayEndIso: string;
  staff: StaffOpt[];
  services: ServiceOpt[];
  modal: { mode: "new" | "walkin" } | { mode: "reschedule"; appt: Appt };
  onClose: () => void;
  onError: (e: string | null) => void;
  onDone: () => void;
}) {
  const isReschedule = props.modal.mode === "reschedule";
  const [serviceId, setServiceId] = useState(props.services[0]?.id ?? "");
  const [staffId, setStaffId] = useState<string>("");
  const [slots, setSlots] = useState<Slot[]>([]);
  const [slotStart, setSlotStart] = useState<string>("");
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [pending, startTransition] = useTransition();

  const loadSlots = async () => {
    // Reschedule keeps the appointment's own service; "new"/"walk-in" uses the picked one.
    const effectiveServiceId = props.modal.mode === "reschedule" ? props.modal.appt.service_id : serviceId;
    if (!effectiveServiceId) return;
    props.onError(null);
    setLoadingSlots(true);
    setSlots([]);
    setSlotStart("");
    try {
      const params = new URLSearchParams({
        client_id: props.clientId, // the endpoint re-validates module + site↔client
        site_id: props.currentSiteId,
        service_id: effectiveServiceId,
        from: props.dayStartIso,
        to: props.dayEndIso,
      });
      if (staffId) params.set("staff_id", staffId);
      const res = await fetch(`/api/scheduling/internal/availability?${params.toString()}`);
      if (!res.ok) {
        props.onError("Could not load availability.");
        return;
      }
      const data = (await res.json()) as { slots: Slot[] };
      setSlots(data.slots);
    } finally {
      setLoadingSlots(false);
    }
  };

  const submit = () => {
    if (!slotStart) {
      props.onError("Pick a time slot.");
      return;
    }
    props.onError(null);
    startTransition(async () => {
      if (isReschedule) {
        const r = await rescheduleAppointmentAction(
          props.clientId,
          props.modal.mode === "reschedule" ? props.modal.appt.id : "",
          slotStart,
          staffId || null,
        );
        if (!r.ok) return props.onError(r.error);
      } else {
        const r = await createManualAppointmentAction(props.clientId, {
          siteId: props.currentSiteId,
          serviceId,
          staffId: staffId || null,
          startAt: slotStart,
          customerName: name || undefined,
          customerPhone: phone || undefined,
          customerEmail: email || undefined,
          walkIn: props.modal.mode === "walkin",
        });
        if (!r.ok) return props.onError(r.error);
      }
      props.onDone();
    });
  };

  const title = isReschedule ? "Reschedule appointment" : props.modal.mode === "walkin" ? "Register walk-in" : "New appointment";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={props.onClose}>
      <div
        className="w-full max-w-md rounded-xl border border-line bg-popover p-5 text-popover-foreground shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold">{title}</h2>
        <div className="mt-4 flex flex-col gap-3 text-sm">
          {!isReschedule ? (
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted">Service</span>
              <select value={serviceId} onChange={(e) => setServiceId(e.target.value)} className="rounded-lg border border-line-strong bg-transparent px-2 py-1.5">
                {props.services.map((s) => (
                  <option key={s.id} value={s.id}>{s.name} ({s.duration_min}m)</option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted">Barber</span>
            <select value={staffId} onChange={(e) => setStaffId(e.target.value)} className="rounded-lg border border-line-strong bg-transparent px-2 py-1.5">
              <option value="">Any</option>
              {props.staff.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </label>
          <button onClick={loadSlots} disabled={loadingSlots || (!isReschedule && !serviceId)} className="self-start rounded-lg border border-line px-3 py-1.5 hover:bg-subtle disabled:opacity-50">
            {loadingSlots ? "Loading…" : "Find times"}
          </button>
          {slots.length > 0 ? (
            <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
              {slots.map((s) => (
                <button
                  key={`${s.start_at}-${s.staff_id}`}
                  onClick={() => {
                    setSlotStart(s.start_at);
                    if (!staffId) setStaffId(s.staff_id);
                  }}
                  className={`rounded border px-2 py-1 text-xs ${slotStart === s.start_at ? "border-accent bg-accent/10 text-accent" : "border-line hover:bg-subtle"}`}
                >
                  {fmtTime(s.start_at, props.timezone)}
                </button>
              ))}
            </div>
          ) : null}
          {!isReschedule ? (
            <>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Customer name" className="rounded-lg border border-line-strong bg-transparent px-2 py-1.5" />
              <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Phone (E.164, e.g. +57300…)" className="rounded-lg border border-line-strong bg-transparent px-2 py-1.5" />
              <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email (optional)" className="rounded-lg border border-line-strong bg-transparent px-2 py-1.5" />
            </>
          ) : null}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={props.onClose} className="rounded-lg border border-line px-3 py-1.5 text-sm hover:bg-subtle">Cancel</button>
          <button onClick={submit} disabled={pending || !slotStart} className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">
            {pending ? "Saving…" : isReschedule ? "Reschedule" : "Book"}
          </button>
        </div>
      </div>
    </div>
  );
}

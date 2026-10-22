"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { createManualAppointmentAction } from "@/lib/schedulingActions";
import { findContactMatchesAction } from "@/lib/appointmentContactActions";
import type { ContactMatch, GuestField } from "@/lib/walkInContact";
import { priceLabelCOP } from "@/lib/money";
import { fmtTime, longDate, siteDayKey, siteMidnight, todayAtSite } from "@/lib/siteCalendar";
import { apptCategoryClass, serviceCategory } from "@/lib/agendaCategory";
import { Avatar, Button, INPUT } from "../ui/system";
import { SidePanel, PanelSection, type SidePanelHandle } from "./SidePanel";

/**
 * ATENCIÓN SIN CITA — one step. Who attends (ordered by who is free first, from the real
 * engine for the chosen service), the service, and the client's details — all optional.
 *
 * The client: Nombre, then Teléfono and Correo below it. Registering WITHOUT a contact is
 * allowed (what was typed stays on the appointment and is shown when it is reopened). To
 * save a contact a valid phone or email is needed; if a contact already has it, it is
 * offered to LINK — never duplicated. A name alone never creates or finds a contact. An
 * email does not mean WhatsApp.
 *
 * The time is the first free start the engine offers today for that professional and the
 * whole service — the site's minimum notice applies to the agenda as everywhere else.
 */
interface Svc { id: string; name: string; duration_min: number; category: string | null; price: string | null }
interface Slot { start_at: string; service_end_at: string; staff_id: string; available_staff_ids: string[] }

export function WalkInPanel(props: {
  clientId: string;
  siteId: string;
  siteName: string;
  timezone: string;
  staff: Array<{ id: string; name: string; photoUrl?: string | null }>;
  services: Svc[];
  lockStaffId: string | null;
  onClose: () => void;
  onSwitchToBooking: () => void;
  onDone: (result: { id: string; dayKey: string; message: string; warning?: string }) => void;
}) {
  const tz = props.timezone;
  const today = todayAtSite(tz);
  const [serviceId, setServiceId] = useState("");
  const [query, setQuery] = useState("");
  const [staffId, setStaffId] = useState(props.lockStaffId ?? "");
  const [slots, setSlots] = useState<{ state: "idle" | "loading" | "ready" | "error"; list: Slot[] }>({ state: "idle", list: [] });
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [saveContact, setSaveContact] = useState(false);
  const [linkTo, setLinkTo] = useState<ContactMatch | null>(null);
  const [matches, setMatches] = useState<ContactMatch[]>([]);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<GuestField, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [idemKey] = useState(() => crypto.randomUUID());
  const sending = useRef(false);
  const handle = useRef<SidePanelHandle | null>(null);
  const dirty = Boolean(serviceId || name.trim() || phone.trim() || email.trim() || (staffId && !props.lockStaffId));

  // Today's free starts for the service, every professional (engine: whole duration).
  useEffect(() => {
    if (!serviceId) return setSlots({ state: "idle", list: [] });
    const ctrl = new AbortController();
    setSlots((s) => ({ state: "loading", list: s.list }));
    const params = new URLSearchParams({
      client_id: props.clientId,
      site_id: props.siteId,
      service_id: serviceId,
      from: new Date().toISOString(),
      to: siteMidnight(nextDay(today), tz).toISOString(),
    });
    if (props.lockStaffId) params.set("staff_id", props.lockStaffId);
    fetch(`/api/scheduling/internal/availability?${params.toString()}`, { signal: ctrl.signal, cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        const data = (await r.json()) as { slots: Slot[] };
        setSlots({ state: "ready", list: data.slots });
      })
      .catch(() => !ctrl.signal.aborted && setSlots({ state: "error", list: [] }));
    return () => ctrl.abort();
  }, [serviceId, props.clientId, props.siteId, props.lockStaffId, today, tz]);

  // First free start per professional → "Libre a las HH:MM", ordered by who is free first.
  const firstFree = useMemo(() => {
    const m = new Map<string, Slot>();
    for (const s of slots.list) for (const id of s.available_staff_ids) if (!m.has(id) || m.get(id)!.start_at > s.start_at) m.set(id, s);
    return m;
  }, [slots.list]);
  const ordered = useMemo(() => {
    const list = props.lockStaffId ? props.staff.filter((s) => s.id === props.lockStaffId) : props.staff;
    return [...list].sort((a, b) => {
      const fa = firstFree.get(a.id)?.start_at ?? "~";
      const fb = firstFree.get(b.id)?.start_at ?? "~";
      return fa.localeCompare(fb) || a.name.localeCompare(b.name);
    });
  }, [props.staff, props.lockStaffId, firstFree]);
  useEffect(() => {
    if (slots.state !== "ready" || props.lockStaffId) return;
    if (staffId && firstFree.has(staffId)) return;
    const first = ordered.find((s) => firstFree.has(s.id));
    setStaffId(first?.id ?? "");
  }, [slots.state, ordered, firstFree, staffId, props.lockStaffId]);

  const slot = staffId ? firstFree.get(staffId) ?? null : null;
  const service = props.services.find((s) => s.id === serviceId) ?? null;
  const visibleServices = props.services.filter((s) => s.name.toLocaleLowerCase("es").includes(query.trim().toLocaleLowerCase("es")));

  // Duplicate check while typing (read-only).
  useEffect(() => {
    const p = phone.trim();
    const e = email.trim();
    if (p.replace(/\D/g, "").length < 7 && !/@.+\./.test(e)) {
      setMatches([]);
      setLinkTo(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      const r = await findContactMatchesAction(props.clientId, { siteId: props.siteId, phone: p || null, email: e || null });
      if (cancelled) return;
      setMatches(r.ok ? r.matches : []);
      if (!r.ok && r.fieldErrors) setFieldErrors(r.fieldErrors);
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [phone, email, props.clientId, props.siteId]);

  const submit = () => {
    if (!slot || !serviceId || sending.current) return;
    sending.current = true;
    setError(null);
    setFieldErrors({});
    startTransition(async () => {
      try {
        const r = await createManualAppointmentAction(props.clientId, {
          siteId: props.siteId,
          serviceId,
          staffId: staffId || null,
          startAt: slot.start_at,
          walkIn: true,
          idempotencyKey: idemKey,
          ...(linkTo
            ? { contactId: linkTo.contactId }
            : { customerName: name, customerPhone: phone, customerEmail: email, contactMode: saveContact ? ("create" as const) : ("guest" as const) }),
        });
        if (!r.ok) {
          if (r.fieldErrors) setFieldErrors(r.fieldErrors);
          if (r.matches) setMatches(r.matches);
          setError(r.fieldErrors ? null : r.error);
          return;
        }
        props.onDone({ id: r.id, dayKey: siteDayKey(slot.start_at, tz), message: "Atención registrada", warning: r.warning });
      } catch {
        setError("No se pudo registrar. Tus datos siguen aquí; vuelve a intentarlo.");
      } finally {
        sending.current = false;
      }
    });
  };

  const summary = slot && service ? `Hoy · ${fmtTime(slot.start_at, tz)} – ${fmtTime(slot.service_end_at, tz)} · ${service.name} · ${props.staff.find((s) => s.id === staffId)?.name.split(" ")[0] ?? ""}` : "Hoy, sin reserva previa";

  return (
    <SidePanel
      name="walkin"
      title="Atención sin cita"
      subtitle={
        <span className="flex flex-wrap items-center gap-x-1.5">
          {props.siteName} · {longDate(new Date().toISOString(), tz)} ·
          <button type="button" onClick={props.onSwitchToBooking} className="u-focus rounded font-medium text-foreground underline underline-offset-2">
            Cambiar a cita con reserva
          </button>
        </span>
      }
      dirty={dirty}
      onClose={props.onClose}
      handleRef={handle}
      footer={
        <div className="flex items-center gap-2">
          <p aria-live="polite" className="u-tnum min-w-0 flex-1 truncate text-[12.5px] text-muted">
            {summary}
          </p>
          <Button onClick={() => handle.current?.requestClose()} disabled={pending}>
            Cancelar
          </Button>
          <Button variant="primary" onClick={submit} disabled={!slot || pending || (saveContact && !linkTo && matches.length > 0)} loading={pending} loadingLabel="Registrando…">
            {error ? "Reintentar" : "Registrar atención"}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col">
        <PanelSection title="Servicio" id="wi-service">
          <input className={INPUT} placeholder="Buscar servicio" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Buscar servicio" />
          <div role="radiogroup" aria-labelledby="wi-service" className="grid gap-2 sm:grid-cols-2">
            {visibleServices.length === 0 ? <p className="text-[13px] text-muted">Ningún servicio coincide con «{query}».</p> : null}
            {visibleServices.map((s) => {
              const on = s.id === serviceId;
              return (
                <button
                  key={s.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => setServiceId(s.id)}
                  className={`u-focus flex min-h-[52px] items-start gap-2.5 rounded-[12px] border px-3 py-2.5 text-left transition-colors ${on ? "border-foreground shadow-[inset_0_0_0_1px_var(--foreground)]" : "border-line hover:bg-subtle"}`}
                >
                  <span aria-hidden className={`u-appt-service ${apptCategoryClass(serviceCategory(s.name, s.category))} mt-1.5 size-2 shrink-0 rounded-full bg-[var(--appt-rule)]`} />
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-medium">{s.name}</span>
                    <span className="block text-[12px] text-muted">
                      {s.duration_min} min{priceLabelCOP(s.price) ? ` · ${priceLabelCOP(s.price)}` : ""}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </PanelSection>

        <PanelSection title="¿Quién lo atiende?" id="wi-staff" hint={serviceId ? "Ordenado por quién queda libre antes, para la duración completa del servicio." : "Elige el servicio para ver quién queda libre antes."}>
          {slots.state === "error" ? (
            <p className="text-[13px] text-danger">No pudimos cargar la disponibilidad de hoy.</p>
          ) : null}
          <div role="radiogroup" aria-labelledby="wi-staff" className="flex flex-col gap-1.5">
            {ordered.map((s) => {
              const free = firstFree.get(s.id);
              const on = s.id === staffId;
              const disabled = Boolean(serviceId) && slots.state === "ready" && !free;
              return (
                <button
                  key={s.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  disabled={disabled || !serviceId}
                  onClick={() => setStaffId(s.id)}
                  className={`u-focus flex min-h-[52px] items-center gap-3 rounded-[12px] border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${on ? "border-foreground shadow-[inset_0_0_0_1px_var(--foreground)]" : "border-line hover:bg-subtle"}`}
                >
                  <Avatar name={s.name} photoUrl={s.photoUrl ?? undefined} />
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-medium">{s.name}</span>
                    <span className="block text-[12px] text-muted">
                      {!serviceId ? "—" : slots.state === "loading" ? "Calculando…" : free ? `Libre a las ${fmtTime(free.start_at, tz)}` : "Sin hueco hoy para este servicio"}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </PanelSection>

        <PanelSection title={<>Cliente <span className="font-normal text-muted">· opcional</span></>} id="wi-client">
          {linkTo ? (
            <div className="flex items-center gap-3 rounded-[12px] border border-foreground px-3.5 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-semibold">{linkTo.name ?? "Sin nombre"}</p>
                <p className="u-mono truncate text-[12px] text-muted">Se vinculará a este contacto · {linkTo.matchedValue}</p>
              </div>
              <Button size="sm" onClick={() => setLinkTo(null)}>Cambiar</Button>
            </div>
          ) : (
            <>
              <label className="flex flex-col gap-1.5">
                <span className="text-[13px] font-medium">Nombre</span>
                <input className={INPUT} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoComplete="off" aria-invalid={Boolean(fieldErrors.name)} />
                {fieldErrors.name ? <span className="text-[12.5px] text-danger">{fieldErrors.name}</span> : null}
              </label>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="flex flex-col gap-1.5">
                  <span className="text-[13px] font-medium">Teléfono</span>
                  <input className={INPUT} value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" autoComplete="off" placeholder="+57 300 000 0000" aria-invalid={Boolean(fieldErrors.phone)} aria-describedby={fieldErrors.phone ? "wi-phone-err" : undefined} />
                  {fieldErrors.phone ? <span id="wi-phone-err" className="text-[12.5px] text-danger">{fieldErrors.phone}</span> : null}
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-[13px] font-medium">Correo</span>
                  <input className={INPUT} value={email} onChange={(e) => setEmail(e.target.value)} inputMode="email" autoComplete="off" placeholder="nombre@correo.com" aria-invalid={Boolean(fieldErrors.email)} aria-describedby={fieldErrors.email ? "wi-email-err" : undefined} />
                  {fieldErrors.email ? <span id="wi-email-err" className="text-[12.5px] text-danger">{fieldErrors.email}</span> : null}
                </label>
              </div>
              {!phone.trim() && email.trim() ? <p className="text-[12.5px] text-muted">Con solo un correo no se le puede escribir por WhatsApp.</p> : null}
              {matches.length > 0 ? (
                <div role="status" className="flex flex-col gap-2 rounded-[12px] border border-line px-3.5 py-3">
                  <p className="text-[13px] font-medium">Ya existe un contacto con estos datos</p>
                  {matches.map((m) => (
                    <div key={m.contactId} className="flex items-center gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] font-semibold">{m.name ?? "Sin nombre"}</p>
                        <p className="u-mono truncate text-[12px] text-muted">{m.matchedBy === "phone" ? "Teléfono" : "Correo"} · {m.matchedValue}</p>
                      </div>
                      <Button size="sm" onClick={() => setLinkTo(m)}>Vincular</Button>
                    </div>
                  ))}
                  <p className="text-[12.5px] text-muted">Vincula en lugar de crear otro contacto con el mismo dato, o regístrala sin contacto.</p>
                </div>
              ) : null}
              <label className="flex min-h-[44px] items-start gap-2.5 text-[13px] md:min-h-0">
                <input type="checkbox" checked={saveContact} onChange={(e) => setSaveContact(e.target.checked)} className="mt-0.5 size-4 accent-[var(--foreground)]" />
                <span>
                  <span className="font-medium">Guardar como contacto</span>
                  <span className="block text-[12.5px] text-muted">Necesita un teléfono o un correo válido. Si no lo marcas, los datos quedan solo en esta atención.</span>
                </span>
              </label>
            </>
          )}
        </PanelSection>
        {error ? <p role="alert" className="mt-3 text-[13px] text-danger">{error}</p> : null}
      </div>
    </SidePanel>
  );
}

function nextDay(d: string): string {
  const [y, m, day] = d.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, day + 1));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}

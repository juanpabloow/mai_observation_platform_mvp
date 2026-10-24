"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { createManualAppointmentAction } from "@/lib/schedulingActions";
import { findContactMatchesAction } from "@/lib/appointmentContactActions";
import type { ContactMatch, GuestField } from "@/lib/walkInContact";
import { priceLabelCOP } from "@/lib/money";
import { fmtTime, siteDayKey, siteMidnight, todayAtSite } from "@/lib/siteCalendar";
import { apptCategoryClass, serviceCategory } from "@/lib/agendaCategory";
import { Button, INPUT } from "../ui/system";
import { AgAvatar } from "./AgendaChrome";
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
 * The time. «Ahora» is the first start inside the immediate window (src/scheduling/immediate.ts):
 * the ONE rule relaxed is the site's minimum notice, for someone who is already here — hours,
 * breaks, absences, appointments and the whole service duration still apply, and the server
 * re-checks all of it. With no room now the panel SAYS so and offers the next free start
 * today (normal availability, minimum notice included); it is booked only once the operator
 * accepts that time explicitly — never on its own.
 *
 * «Esta atención ya se realizó»: reception registering at the end of the day a service that
 * already happened TODAY. Then the professional (who did it) and a start of today whose
 * service has already ended (the engine's own starts, `past=1`) are chosen, and after an
 * explicit confirmation it is saved as COMPLETED — the charge stays pending, nothing is sent
 * to anyone. The server re-checks everything (src/scheduling/booking.ts · pastWalkIn) and an
 * overlap with another appointment of that professional is SHOWN, never resolved by changing it.
 */
interface Svc { id: string; name: string; duration_min: number; category: string | null; price: string | null }
interface Slot { start_at: string; service_end_at: string; staff_id: string; available_staff_ids: string[] }

export function WalkInPanel(props: {
  clientId: string;
  siteId: string;
  siteName: string;
  timezone: string;
  staff: Array<{ id: string; name: string; photoUrl?: string | null; tint?: "1" | "2" | "3" | "4" }>;
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
  /** The professional the operator PICKED (null = the one free first). */
  const [pickedStaff, setStaffId] = useState<string>(props.lockStaffId ?? "");
  const [slotState, setSlots] = useState<{ forKey: string; state: "ready" | "error"; now: Slot[]; later: Slot[] }>({ forKey: "", state: "ready", now: [], later: [] });
  /** Bumped to re-ask the engine (a start that stopped being «ahora», a slot just taken). */
  const [refresh, setRefresh] = useState(0);
  /** The later start the operator ACCEPTED («staff|start_at»); nothing else books a later time. */
  const [accepted, setAccepted] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [saveContact, setSaveContact] = useState(false);
  const [linkTo, setLinkTo] = useState<ContactMatch | null>(null);
  const [matchState, setMatches] = useState<{ forKey: string; list: ContactMatch[] }>({ forKey: "", list: [] });
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<GuestField, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [idemKey] = useState(() => crypto.randomUUID());
  // «Esta atención ya se realizó».
  const [done, setDone] = useState(false);
  const [pastStart, setPastStart] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [conflicts, setConflicts] = useState<Array<{ startAt: string; endAt: string; service: string; status: string }>>([]);
  const [pastState, setPast] = useState<{ forKey: string; state: "ready" | "error"; list: Slot[] }>({ forKey: "", state: "ready", list: [] });
  const sending = useRef(false);
  const handle = useRef<SidePanelHandle | null>(null);
  // Two answers from the real engine, tagged with service + refresh so "loading" is derived:
  //   now   — immediate=1: starts within the immediate window, minimum notice waived;
  //   later — the normal starts left today (minimum notice included), offered when «now» is full.
  const slotKey = `${serviceId}|${refresh}`;
  const slots: { state: "idle" | "loading" | "ready" | "error"; now: Slot[]; later: Slot[] } = !serviceId
    ? { state: "idle", now: [], later: [] }
    : slotState.forKey === slotKey
      ? slotState
      : { state: "loading", now: [], later: [] };
  useEffect(() => {
    if (!serviceId) return;
    const ctrl = new AbortController();
    const ask = (immediate: boolean) => {
      const params = new URLSearchParams({
        client_id: props.clientId,
        site_id: props.siteId,
        service_id: serviceId,
        from: new Date().toISOString(),
        to: siteMidnight(nextDay(today), tz).toISOString(),
      });
      if (immediate) params.set("immediate", "1");
      if (props.lockStaffId) params.set("staff_id", props.lockStaffId);
      return fetch(`/api/scheduling/internal/availability?${params.toString()}`, { signal: ctrl.signal, cache: "no-store" }).then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        return ((await r.json()) as { slots: Slot[] }).slots;
      });
    };
    const key = `${serviceId}|${refresh}`;
    Promise.all([ask(true), ask(false)])
      .then(([now, later]) => setSlots({ forKey: key, state: "ready", now, later }))
      .catch(() => !ctrl.signal.aborted && setSlots({ forKey: key, state: "error", now: [], later: [] }));
    return () => ctrl.abort();
  }, [serviceId, refresh, props.clientId, props.siteId, props.lockStaffId, today, tz]);

  // «Ya se realizó»: the starts of today whose service already ended (the engine's own grid).
  const pastKey = `${serviceId}|${refresh}`;
  const past: { state: "idle" | "loading" | "ready" | "error"; list: Slot[] } = !done || !serviceId
    ? { state: "idle", list: [] }
    : pastState.forKey === pastKey
      ? pastState
      : { state: "loading", list: [] };
  useEffect(() => {
    if (!done || !serviceId) return;
    const ctrl = new AbortController();
    const params = new URLSearchParams({
      client_id: props.clientId,
      site_id: props.siteId,
      service_id: serviceId,
      from: siteMidnight(today, tz).toISOString(),
      to: new Date().toISOString(),
      past: "1",
    });
    if (props.lockStaffId) params.set("staff_id", props.lockStaffId);
    const key = `${serviceId}|${refresh}`;
    fetch(`/api/scheduling/internal/availability?${params.toString()}`, { signal: ctrl.signal, cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        const list = ((await r.json()) as { slots: Slot[] }).slots;
        setPast({ forKey: key, state: "ready", list });
      })
      .catch(() => !ctrl.signal.aborted && setPast({ forKey: key, state: "error", list: [] }));
    return () => ctrl.abort();
  }, [done, serviceId, refresh, props.clientId, props.siteId, props.lockStaffId, today, tz]);
  const pastFor = (id: string) => past.list.filter((s) => s.available_staff_ids.includes(id)).sort((a, b) => b.start_at.localeCompare(a.start_at));

  // First start per professional, «now» and «later»; ordered: free now, then soonest later.
  const nowFree = useMemo(() => firstPerStaff(slots.now), [slots.now]);
  const laterFree = useMemo(() => firstPerStaff(slots.later), [slots.later]);
  const ordered = useMemo(() => {
    const list = props.lockStaffId ? props.staff.filter((s) => s.id === props.lockStaffId) : props.staff;
    // Numeric rank (a locale collation would put a "~" sentinel before the digits).
    const rank = (id: string) => {
      const n = nowFree.get(id) ?? laterFree.get(id);
      return n ? (nowFree.has(id) ? 0 : 1e15) + Date.parse(n.start_at) : Infinity;
    };
    return [...list].sort((a, b) => rank(a.id) - rank(b.id) || a.name.localeCompare(b.name));
  }, [props.staff, props.lockStaffId, nowFree, laterFree]);
  const canTake = (id: string) => nowFree.has(id) || laterFree.has(id);
  // The picked professional while they can take it, else whoever is free first.
  // «Ya se realizó»: whoever DID it is chosen explicitly (no «free first» — it already happened).
  const staffId = done
    ? props.lockStaffId ?? pickedStaff
    : props.lockStaffId ?? (pickedStaff && canTake(pickedStaff) ? pickedStaff : ordered.find((s) => canTake(s.id))?.id ?? "");
  const dirty = Boolean(done || serviceId || name.trim() || phone.trim() || email.trim() || (pickedStaff && !props.lockStaffId));
  const pastList = done && staffId ? pastFor(staffId) : [];
  const pastSlot = pastList.find((s) => s.start_at === pastStart) ?? null;

  // «Ahora» when there is room now; otherwise the next start today, only once accepted.
  const nowSlot = staffId ? nowFree.get(staffId) ?? null : null;
  const laterSlot = !nowSlot && staffId ? laterFree.get(staffId) ?? null : null;
  const laterAccepted = Boolean(laterSlot && accepted === `${staffId}|${laterSlot.start_at}`);
  const slot = nowSlot ?? (laterAccepted ? laterSlot : null);
  const service = props.services.find((s) => s.id === serviceId) ?? null;
  const visibleServices = props.services.filter((s) => s.name.toLocaleLowerCase("es").includes(query.trim().toLocaleLowerCase("es")));

  // Duplicate check while typing (read-only), tagged with what was typed.
  const typedKey = `${phone.trim()}|${email.trim()}`;
  const searchable = phone.trim().replace(/\D/g, "").length >= 7 || /@.+\./.test(email.trim());
  const matches = searchable && matchState.forKey === typedKey ? matchState.list : [];
  useEffect(() => {
    if (!searchable) return;
    const p = phone.trim();
    const e = email.trim();
    let cancelled = false;
    const t = setTimeout(async () => {
      const r = await findContactMatchesAction(props.clientId, { siteId: props.siteId, phone: p || null, email: e || null });
      if (cancelled) return;
      setMatches({ forKey: `${p}|${e}`, list: r.ok ? r.matches : [] });
      if (!r.ok && r.fieldErrors) setFieldErrors(r.fieldErrors);
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [phone, email, searchable, props.clientId, props.siteId]);

  const submitDone = () => {
    if (!pastSlot || !serviceId || !staffId || sending.current) return;
    sending.current = true;
    setError(null);
    setFieldErrors({});
    setConflicts([]);
    startTransition(async () => {
      try {
        const r = await createManualAppointmentAction(props.clientId, {
          siteId: props.siteId,
          serviceId,
          staffId,
          startAt: pastSlot.start_at,
          walkIn: true,
          alreadyDone: true,
          idempotencyKey: idemKey,
          ...(linkTo
            ? { contactId: linkTo.contactId }
            : { customerName: name, customerPhone: phone, customerEmail: email, contactMode: saveContact ? ("create" as const) : ("guest" as const) }),
        });
        if (!r.ok) {
          setConfirming(false);
          if (r.fieldErrors) setFieldErrors(r.fieldErrors);
          if (r.matches) setMatches({ forKey: typedKey, list: r.matches });
          setConflicts(r.conflicts ?? []);
          setError(r.fieldErrors ? null : r.error);
          if (!r.fieldErrors && !r.matches) setRefresh((n) => n + 1);
          return;
        }
        props.onDone({ id: r.id, dayKey: siteDayKey(pastSlot.start_at, tz), message: "Atención registrada como completada · cobro pendiente", warning: r.warning });
      } catch {
        setConfirming(false);
        setError("No se pudo registrar. Tus datos siguen aquí; vuelve a intentarlo.");
      } finally {
        sending.current = false;
      }
    });
  };

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
          // Only a start inside the immediate window waives the minimum notice; an accepted
          // later time is a normal walk-in, checked with the site's notice like any booking.
          immediate: slot === nowSlot,
          idempotencyKey: idemKey,
          ...(linkTo
            ? { contactId: linkTo.contactId }
            : { customerName: name, customerPhone: phone, customerEmail: email, contactMode: saveContact ? ("create" as const) : ("guest" as const) }),
        });
        if (!r.ok) {
          if (r.fieldErrors) setFieldErrors(r.fieldErrors);
          if (r.matches) setMatches({ forKey: typedKey, list: r.matches });
          setError(r.fieldErrors ? null : r.error);
          // The time may have just stopped being free or «ahora»: re-ask the engine. What was
          // typed stays; a later time must be accepted again.
          if (!r.fieldErrors && !r.matches) {
            setAccepted("");
            setRefresh((n) => n + 1);
          }
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

  const staffFirst = props.staff.find((s) => s.id === staffId)?.name.split(" ")[0] ?? "";
  const summary = done
    ? pastSlot && service
      ? `Hoy · ${fmtTime(pastSlot.start_at, tz)} – ${fmtTime(pastSlot.service_end_at, tz)} · ${service.name} · ${staffFirst} · ya realizada`
      : "Elige quién la realizó, el servicio y la hora"
    : slot && service
      ? `${slot === nowSlot ? "Ahora" : "Hoy"} · ${fmtTime(slot.start_at, tz)} – ${fmtTime(slot.service_end_at, tz)} · ${service.name} · ${staffFirst}`
      : "Hoy, sin reserva previa";

  return (
    <SidePanel
      name="walkin"
      title="Atención sin cita"
      subtitle={
        <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
          <span>
            {props.siteName} · {shortToday(tz)} ·
          </span>
          <button type="button" onClick={props.onSwitchToBooking} className="u-focus rounded text-foreground hover:underline">
            Cambiar a cita con reserva
          </button>
        </span>
      }
      dirty={dirty}
      onClose={props.onClose}
      handleRef={handle}
      footer={
        done ? (
          <div className="flex flex-col gap-2">
            {confirming && pastSlot ? (
              <div role="alertdialog" aria-labelledby="wi-done-confirm" className="flex flex-col gap-1 rounded-[10px] bg-[var(--chip)] px-3 py-2.5">
                <p id="wi-done-confirm" className="text-[13px] font-medium">¿Registrar esta atención como completada?</p>
                <p className="u-tnum text-[12.5px] text-muted">
                  {summary.replace(" · ya realizada", "")}. Queda como completada con la fecha de hoy y tu nombre como quien la registró; el cobro queda pendiente y no se envía ningún mensaje al cliente.
                </p>
              </div>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <div aria-live="polite" className="flex w-full min-w-0 flex-col sm:w-auto sm:flex-1">
                <span className="text-[12.5px] text-muted">Atención ya realizada hoy</span>
                <span className="truncate text-[14px] font-medium tabular-nums">{summary}</span>
              </div>
              <span className="flex-1 sm:hidden" />
              {confirming ? (
                <>
                  <Button autoFocus onClick={() => setConfirming(false)} disabled={pending}>
                    Volver
                  </Button>
                  <Button variant="primary" onClick={submitDone} loading={pending} loadingLabel="Registrando…">
                    Confirmar registro
                  </Button>
                </>
              ) : (
                <>
                  <Button onClick={() => handle.current?.requestClose()} disabled={pending}>
                    Cancelar
                  </Button>
                  <Button variant="primary" onClick={() => setConfirming(true)} disabled={!pastSlot || pending || (saveContact && !linkTo && matches.length > 0)}>
                    {error ? "Revisar de nuevo" : "Revisar registro"}
                  </Button>
                </>
              )}
            </div>
          </div>
        ) : (
        <div className="flex flex-wrap items-center gap-2">
          <div aria-live="polite" className="flex w-full min-w-0 flex-col sm:w-auto sm:flex-1">
            <span className="text-[12.5px] text-muted">Hoy, sin reserva previa</span>
            <span className="truncate text-[14px] font-medium tabular-nums">{slot && service ? summary : "Elige servicio y profesional"}</span>
          </div>
          <span className="flex-1 sm:hidden" />
          <Button onClick={() => handle.current?.requestClose()} disabled={pending}>
            Cancelar
          </Button>
          <Button variant="primary" onClick={submit} disabled={!slot || pending || (saveContact && !linkTo && matches.length > 0)} loading={pending} loadingLabel="Registrando…">
            {error ? "Reintentar" : slot && slot !== nowSlot ? `Registrar a las ${fmtTime(slot.start_at, tz)}` : "Registrar atención"}
          </Button>
        </div>
        )
      }
    >
      <div className="flex flex-col">
        <label className="mb-1 flex min-h-[44px] items-start gap-2.5 rounded-[10px] px-3 py-2.5 text-[13px] shadow-[inset_0_0_0_1px_var(--line)] md:min-h-0">
          <input
            type="checkbox"
            checked={done}
            onChange={(e) => {
              setDone(e.target.checked);
              setConfirming(false);
              setConflicts([]);
              setError(null);
              setPastStart("");
            }}
            className="mt-0.5 size-4 accent-[var(--foreground)]"
          />
          <span>
            <span className="font-medium">Esta atención ya se realizó</span>
            <span className="block text-[12.5px] text-muted">Para registrar al final del día un servicio de hoy que ya terminó. Se guarda como completada; el cobro queda pendiente y no se envía ningún mensaje.</span>
          </span>
        </label>
        <PanelSection
          title={done ? "¿Quién lo realizó?" : "¿Quién lo atiende?"}
          id="wi-staff"
          size="lg"
          hint={done ? "Elige al profesional que hizo el servicio." : serviceId ? "Ordenado por quién queda libre antes, para la duración completa del servicio." : "Elige el servicio y verás quién queda libre antes."}
        >
          {slots.state === "error" ? (
            <p className="text-[13px] text-danger">No pudimos cargar la disponibilidad de hoy.</p>
          ) : null}
          <div role="radiogroup" aria-labelledby="wi-staff" className="flex flex-col gap-1.5">
            {ordered.map((s) => {
              const free = nowFree.get(s.id);
              const next = laterFree.get(s.id);
              const on = s.id === staffId;
              const disabled = !done && Boolean(serviceId) && slots.state === "ready" && !free && !next;
              const doneCount = done ? pastFor(s.id).length : 0;
              return (
                <button
                  key={s.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  disabled={disabled}
                  onClick={() => setStaffId(s.id)}
                  className={`u-focus flex min-h-[56px] items-center gap-3 rounded-[12px] px-3 py-2 text-left transition-shadow disabled:cursor-not-allowed disabled:opacity-50 ${on ? "shadow-[inset_0_0_0_1.5px_var(--foreground)]" : "shadow-[inset_0_0_0_1px_var(--line)] hover:bg-[var(--subtle)]"}`}
                >
                  <AgAvatar name={s.name} id={s.id} size={40} tint={s.tint} photoUrl={s.photoUrl ?? null} />
                  <span className="min-w-0">
                    <span className="block truncate text-[14px]">{s.name}</span>
                    <span className="block text-[12.5px] tabular-nums text-muted">
                      {done
                        ? !serviceId
                          ? "Elige un servicio"
                          : past.state === "loading"
                            ? "Calculando…"
                            : doneCount > 0
                              ? `${doneCount} ${doneCount === 1 ? "horario terminado" : "horarios terminados"} hoy`
                              : "Sin horarios terminados hoy para este servicio"
                        : !serviceId ? "Elige un servicio" : slots.state === "loading" ? "Calculando…" : free ? `Puede atender ahora · ${fmtTime(free.start_at, tz)}` : next ? `Ahora no · siguiente a las ${fmtTime(next.start_at, tz)}` : "Sin hueco hoy para este servicio"}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
          {!done && serviceId && slots.state === "ready" && staffId && !nowSlot && laterSlot ? (
            <div role="status" className="flex flex-col gap-2 rounded-[10px] bg-[var(--chip)] px-3 py-2.5">
              <p className="text-[13px] font-medium">No hay espacio ahora con {props.staff.find((s) => s.id === staffId)?.name.split(" ")[0] ?? "este profesional"}</p>
              <p className="u-tnum text-[12.5px] text-muted">
                El siguiente horario disponible hoy es a las {fmtTime(laterSlot.start_at, tz)} – {fmtTime(laterSlot.service_end_at, tz)}. No se reserva hasta que lo confirmes.
              </p>
              <label className="flex min-h-[44px] items-center gap-2.5 text-[13px] md:min-h-0">
                <input
                  type="checkbox"
                  checked={laterAccepted}
                  onChange={(e) => setAccepted(e.target.checked ? `${staffId}|${laterSlot.start_at}` : "")}
                  className="size-4 accent-[var(--foreground)]"
                />
                <span className="font-medium">Usar las {fmtTime(laterSlot.start_at, tz)}</span>
              </label>
            </div>
          ) : null}
          {!done && serviceId && slots.state === "ready" && ordered.length > 0 && !ordered.some((s) => canTake(s.id)) ? (
            <div role="status" className="flex flex-col gap-1.5 rounded-[10px] bg-[var(--chip)] px-3 py-2.5">
              <p className="text-[13px] font-medium">No hay espacio hoy para este servicio</p>
              <p className="text-[12.5px] text-muted">Puedes reservarle una cita otro día.</p>
            </div>
          ) : null}
        </PanelSection>

        <PanelSection title="Servicio" id="wi-service" size="lg">
          <label className="flex h-[38px] items-center gap-2 rounded-[10px] bg-[var(--chip)] px-3 text-muted">
            <svg aria-hidden viewBox="0 0 16 16" className="size-[14px] shrink-0" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="7" cy="7" r="4.6" /><path d="M10.4 10.4L14 14" /></svg>
            <input type="search" placeholder="Buscar servicio" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Buscar servicio" className="min-w-0 flex-1 bg-transparent text-[14px] text-foreground outline-none placeholder:text-muted" />
          </label>
          <div role="radiogroup" aria-labelledby="wi-service" className="grid grid-cols-2 gap-2">
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
                  className={`u-focus flex min-h-[56px] items-start gap-2.5 rounded-[10px] px-3 py-2.5 text-left transition-shadow ${on ? "shadow-[inset_0_0_0_1.5px_var(--foreground)]" : "shadow-[inset_0_0_0_1px_var(--line-strong)] hover:bg-[var(--subtle)]"}`}
                >
                  <span aria-hidden className={`u-appt-service ${apptCategoryClass(serviceCategory(s.name, s.category))} mt-1.5 size-2 shrink-0 rounded-full bg-[var(--appt-rule)]`} />
                  <span className="min-w-0">
                    <span className="block truncate text-[14px]">{s.name}</span>
                    <span className="block text-[12.5px] tabular-nums text-muted">
                      {s.duration_min} min{priceLabelCOP(s.price) ? ` · ${priceLabelCOP(s.price)}` : ""}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </PanelSection>

        {done ? (
          <PanelSection title="Hora de inicio · hoy" id="wi-time" size="lg" hint="Solo horarios de hoy cuyo servicio ya terminó, según la hora de la sede.">
            {!serviceId || !staffId ? (
              <p className="text-[13px] text-muted">Elige el servicio y quién lo realizó.</p>
            ) : past.state === "loading" ? (
              <p className="text-[13px] text-muted">Calculando…</p>
            ) : past.state === "error" ? (
              <p className="text-[13px] text-danger">No pudimos cargar los horarios de hoy.</p>
            ) : pastList.length === 0 ? (
              <p className="text-[13px] text-muted">No hay horarios de hoy ya terminados en los que {staffFirst || "este profesional"} estuviera disponible para este servicio (fuera de su horario, pausas, bloqueos u otras citas).</p>
            ) : (
              <label className="flex flex-col gap-1.5">
                <span className="sr-only">Hora de inicio</span>
                <select
                  value={pastSlot ? pastStart : ""}
                  onChange={(e) => {
                    setPastStart(e.target.value);
                    setConfirming(false);
                    setConflicts([]);
                  }}
                  data-own-escape=""
                  className={INPUT}
                >
                  <option value="">Elige la hora</option>
                  {pastList.map((s) => (
                    <option key={s.start_at} value={s.start_at}>
                      {fmtTime(s.start_at, tz)} – {fmtTime(s.service_end_at, tz)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {conflicts.length > 0 ? (
              <div role="status" className="flex flex-col gap-1 rounded-[10px] bg-[var(--warn-soft)] px-3 py-2.5 text-[12.5px] text-[var(--warn)]">
                <span className="font-medium">Se cruza con {conflicts.length === 1 ? "esta cita" : "estas citas"} de {staffFirst || "este profesional"}:</span>
                {conflicts.map((c) => (
                  <span key={c.startAt} className="u-tnum">
                    {fmtTime(c.startAt, tz)} – {fmtTime(c.endAt, tz)} · {c.service} · {STATUS_WORD[c.status] ?? c.status}
                  </span>
                ))}
                <span>No se cambió ninguna cita. Elige otra hora o revisa la cita existente.</span>
              </div>
            ) : null}
          </PanelSection>
        ) : null}

        <PanelSection title={<>Cliente <span className="font-normal text-muted">· opcional</span></>} id="wi-client" size="lg">
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

const STATUS_WORD: Record<string, string> = { scheduled: "Sin confirmar", confirmed: "Confirmada", completed: "Completada", no_show: "Inasistencia" };

function nextDay(d: string): string {
  const [y, m, day] = d.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, day + 1));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}

function firstPerStaff(list: Slot[]): Map<string, Slot> {
  const m = new Map<string, Slot>();
  for (const s of list) for (const id of s.available_staff_ids) if (!m.has(id) || m.get(id)!.start_at > s.start_at) m.set(id, s);
  return m;
}

const WD = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
const MO = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
/** "jue 22 oct" — today at the site, as the reference's subtitle reads. */
function shortToday(tz: string): string {
  const [y, m, d] = todayAtSite(tz).split("-").map(Number);
  return `${WD[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${d} ${MO[m - 1]}`;
}

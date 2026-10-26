"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { checkPastAttendanceAction, createManualAppointmentAction, searchSchedulingContactsAction, type ContactSearchHit, type PastAttendanceCheck } from "@/lib/schedulingActions";
import { findContactMatchesAction } from "@/lib/appointmentContactActions";
import type { ContactMatch, GuestField } from "@/lib/walkInContact";
import { priceLabelCOP } from "@/lib/money";
import { dayShort, fmtTime, siteDayKey, siteLocalToUtc, siteMidnight, todayAtSite } from "@/lib/siteCalendar";
import { PAST_STATUS_WORD, pastProblemText, type PastConflict } from "@/lib/pastAttendance";
import { apptCategoryClass, serviceCategory } from "@/lib/agendaCategory";
import { Button, Field, INPUT } from "../ui/system";
import { AgAvatar } from "./AgendaChrome";
import { SidePanel, PanelSection, type SidePanelHandle } from "./SidePanel";

/**
 * ATENCIÓN SIN CITA — one step. Who attends (ordered by who is free first, from the real
 * engine for the chosen service), the service, and the client's details — all optional.
 *
 * The client: an existing contact found by name, phone or email (the booking's own search),
 * or Nombre, Teléfono and Correo for a new one — or nothing at all (registered unidentified:
 * what was typed stays on the appointment). To save a contact a valid phone or email is
 * needed; if a contact already has it, it is offered to LINK — never duplicated. A name alone
 * never creates or finds a contact. An email does not mean WhatsApp.
 *
 * The time. «Ahora» is the first start inside the immediate window (src/scheduling/immediate.ts):
 * the ONE rule relaxed is the site's minimum notice, for someone who is already here — hours,
 * breaks, absences, appointments and the whole service duration still apply, and the server
 * re-checks all of it. With no room now the panel SAYS so and offers the next free start
 * today (normal availability, minimum notice included); it is booked only once the operator
 * accepts that time explicitly — never on its own.
 *
 * «Esta atención ya se realizó» («Registrar atención realizada»): a service that already
 * happened — today or an earlier day — recorded with WHO did it, the service, the date and its
 * REAL start (any minute, not the booking grid), in the site's timezone. The end is the
 * professional's own duration for the service, shown before saving (a range painted on the
 * grid never changes it silently). The server checks that exact interval as the form types it
 * (checkPastAttendanceAction): what stands in the way is SHOWN with its reason — hours, a
 * break, a block, another appointment (which can be opened to review or complete instead of
 * duplicating it); a no-show does not block. Only then «Revisar registro» → «Confirmar
 * registro»; changing the date, time, professional, service or client voids that review. It is
 * saved as COMPLETED — the charge stays pending, nothing is sent to anyone.
 */
interface Svc { id: string; name: string; duration_min: number; category: string | null; price: string | null }
interface Slot { start_at: string; service_end_at: string; staff_id: string; available_staff_ids: string[] }

/** What the agenda already knows when the panel opens (a range painted on the grid, or the
 *  booking form it was switched from) — kept, never asked again. */
export interface WalkInContext {
  staffId?: string;
  startAt?: string;
  spanMin?: number;
  serviceId?: string;
  /** Open on «Esta atención ya se realizó» (the range has already ended). */
  done?: boolean;
}

export function WalkInPanel(props: {
  clientId: string;
  siteId: string;
  siteName: string;
  timezone: string;
  staff: Array<{ id: string; name: string; photoUrl?: string | null; tint?: "1" | "2" | "3" | "4" }>;
  services: Svc[];
  lockStaffId: string | null;
  /** The day the agenda is showing — the default date of a past attendance (never after today). */
  viewDate: string;
  initial?: WalkInContext;
  onClose: () => void;
  /** To «Nueva cita», carrying what is chosen here (professional, start, service). */
  onSwitchToBooking: (context: WalkInContext) => void;
  /** Open an existing appointment (to review or complete it instead of duplicating it). */
  onOpenAppointment?: (id: string, dayKey: string) => void;
  /** The past attendance being prepared — the calendar draws it at its real size. */
  onDraft?: (d: { staffId: string; startAt: string; durationMin: number; label: string; past: true } | null) => void;
  onDone: (result: { id: string; dayKey: string; message: string; warning?: string }) => void;
}) {
  const tz = props.timezone;
  const today = todayAtSite(tz);
  const initial = props.initial ?? {};
  const [serviceId, setServiceId] = useState(initial.serviceId && props.services.some((s) => s.id === initial.serviceId) ? initial.serviceId : "");
  const [query, setQuery] = useState("");
  /** The professional the operator PICKED (null = the one free first). */
  const [pickedStaff, setStaffId] = useState<string>(props.lockStaffId ?? (initial.staffId && props.staff.some((s) => s.id === initial.staffId) ? initial.staffId : ""));
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
  const [done, setDone] = useState(Boolean(initial.done));
  const [pastDay, setPastDay] = useState(() => {
    const d = initial.startAt ? siteDayKey(initial.startAt, tz) : props.viewDate;
    return d <= today ? d : today;
  });
  const [pastTime, setPastTime] = useState(() => (initial.startAt && siteDayKey(initial.startAt, tz) <= today ? fmtTime(initial.startAt, tz) : ""));
  const [openedWhen] = useState({ day: pastDay, time: pastTime });
  /** The data the operator REVIEWED (the key below). Any change to it closes the review. */
  const [reviewed, setReviewed] = useState<string | null>(null);
  /** «Revisar registro» was pressed with something missing: say what, next to each field. */
  const [showMissing, setShowMissing] = useState(false);
  /** A refused registration, tied to the data it was for (it goes once that data changes). */
  const [doneError, setDoneError] = useState<{ key: string; message: string } | null>(null);
  const [checkState, setCheck] = useState<{ forKey: string; state: "ready" | "error"; data: PastAttendanceCheck | null }>({ forKey: "", state: "ready", data: null });
  const sending = useRef(false);
  const handle = useRef<SidePanelHandle | null>(null);
  // Two answers from the real engine, tagged with service + refresh so "loading" is derived:
  //   now   — immediate=1: starts within the immediate window, minimum notice waived;
  //   later — the normal starts left today (minimum notice included), offered when «now» is full.
  const slotKey = `${serviceId}|${refresh}`;
  const slots: { state: "idle" | "loading" | "ready" | "error"; now: Slot[]; later: Slot[] } = !serviceId || done
    ? { state: "idle", now: [], later: [] }
    : slotState.forKey === slotKey
      ? slotState
      : { state: "loading", now: [], later: [] };
  useEffect(() => {
    if (!serviceId || done) return;
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
  }, [serviceId, done, refresh, props.clientId, props.siteId, props.lockStaffId, today, tz]);

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
  // Unsaved = anything beyond what the panel opened with (a painted range is not a change).
  const dirty = Boolean(
    done !== Boolean(initial.done) ||
      (serviceId && serviceId !== initial.serviceId) ||
      name.trim() || phone.trim() || email.trim() || linkTo ||
      (pickedStaff && !props.lockStaffId && pickedStaff !== initial.staffId) ||
      (done && (pastDay !== openedWhen.day || pastTime !== openedWhen.time)),
  );

  // «Ahora» when there is room now; otherwise the next start today, only once accepted.
  const nowSlot = staffId ? nowFree.get(staffId) ?? null : null;
  const laterSlot = !nowSlot && staffId ? laterFree.get(staffId) ?? null : null;
  const laterAccepted = Boolean(laterSlot && accepted === `${staffId}|${laterSlot.start_at}`);
  const slot = nowSlot ?? (laterAccepted ? laterSlot : null);
  const service = props.services.find((s) => s.id === serviceId) ?? null;
  const visibleServices = props.services.filter((s) => s.name.toLocaleLowerCase("es").includes(query.trim().toLocaleLowerCase("es")));
  const staffFirst = props.staff.find((s) => s.id === staffId)?.name.split(" ")[0] ?? "";

  // Duplicate check while typing (read-only), tagged with what was typed.
  const typedKey = `${phone.trim()}|${email.trim()}`;
  const searchable = phone.trim().replace(/\D/g, "").length >= 7 || /@.+\./.test(email.trim());
  const matches = searchable && matchState.forKey === typedKey ? matchState.list : [];

  // ── «Ya se realizó»: the exact interval and what the server says about it ─────────────────
  const pastStart = done && pastDay && pastDay <= today ? siteLocalToUtc(pastDay, pastTime, tz)?.toISOString() ?? null : null;
  const doneKey = `${serviceId}|${staffId}|${pastStart ?? ""}|${linkTo?.contactId ?? ""}`;
  const checkKey = `${doneKey}|${refresh}`;
  const checkReady = Boolean(done && serviceId && staffId && pastStart);
  const check: { state: "idle" | "loading" | "ready" | "error"; data: PastAttendanceCheck | null } = !checkReady
    ? { state: "idle", data: null }
    : checkState.forKey === checkKey
      ? checkState
      : { state: "loading", data: null };
  useEffect(() => {
    if (!checkReady || !pastStart) return;
    let cancelled = false;
    const key = `${serviceId}|${staffId}|${pastStart}|${linkTo?.contactId ?? ""}|${refresh}`;
    // A short pause while a time is being typed: ask once it settles.
    const t = setTimeout(async () => {
      try {
        const r = await checkPastAttendanceAction(props.clientId, { siteId: props.siteId, serviceId, staffId, startAt: pastStart, contactId: linkTo?.contactId ?? null });
        if (!cancelled) setCheck({ forKey: key, state: "ready", data: r });
      } catch {
        if (!cancelled) setCheck({ forKey: key, state: "error", data: null });
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [checkReady, serviceId, staffId, pastStart, linkTo, refresh, props.clientId, props.siteId]);
  const result = check.state === "ready" && check.data?.ok ? check.data : null;
  const pastEnd = result?.serviceEndAt ?? null;
  const fits = Boolean(result && result.problems.length === 0 && result.conflicts.length === 0);
  const contactBlocked = saveContact && !linkTo && matches.length > 0;
  const canReview = fits && !contactBlocked;
  /** The review is open only for the data it was made of — derived, so it cannot go stale. */
  const confirmOpen = done && reviewed === doneKey && canReview;
  const pastFailure = doneError && doneError.key === doneKey ? doneError.message : null;
  // The confirmation opens with the focus on its safe choice («Volver»).
  useEffect(() => {
    if (confirmOpen) document.querySelector<HTMLButtonElement>("[data-wi-confirm-back]")?.focus();
  }, [confirmOpen]);

  // The draft on the calendar, at the professional's real duration.
  const onDraft = props.onDraft;
  const draftDur = result?.durationMin ?? null;
  const draftLabel = service ? `Atención realizada · ${service.name}` : "";
  useEffect(() => {
    if (!onDraft) return;
    onDraft(done && staffId && pastStart && draftDur ? { staffId, startAt: pastStart, durationMin: draftDur, label: draftLabel, past: true } : null);
  }, [onDraft, done, staffId, pastStart, draftDur, draftLabel]);
  useEffect(() => () => onDraft?.(null), [onDraft]);

  /** What is still missing, in the order of the form — each with the control to focus. */
  const missing: Array<{ label: string; focus: string }> = done
    ? [
        ...(!staffId ? [{ label: "quién la realizó", focus: "#wi-staff-list [role=radio]" }] : []),
        ...(!serviceId ? [{ label: "el servicio", focus: "#wi-service-list [role=radio]" }] : []),
        ...(!pastDay || pastDay > today ? [{ label: "la fecha", focus: "#wi-date" }] : []),
        ...(!siteLocalToUtc(pastDay || today, pastTime, tz) ? [{ label: "la hora de inicio", focus: "#wi-time" }] : []),
      ]
    : [];

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

  // An existing contact by name, phone or email — the booking form's own search.
  const [contactQuery, setContactQuery] = useState("");
  const [hitState, setHits] = useState<{ forKey: string; hits: ContactSearchHit[] }>({ forKey: "", hits: [] });
  const term = contactQuery.trim();
  const hits = term.length >= 2 && hitState.forKey === term ? hitState.hits : [];
  const searching = term.length >= 2 && hitState.forKey !== term;
  useEffect(() => {
    if (term.length < 2) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      const r = await searchSchedulingContactsAction(props.clientId, term);
      if (!cancelled) setHits({ forKey: term, hits: r.ok ? r.hits : [] });
    }, 220);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [term, props.clientId]);
  const pickHit = (h: ContactSearchHit) => {
    setLinkTo({ contactId: h.id, name: h.name, matchedBy: h.email && !h.phone ? "email" : "phone", matchedValue: h.phone ?? h.email ?? h.identity });
    setContactQuery("");
  };

  const review = () => {
    if (missing.length > 0) {
      setShowMissing(true);
      document.querySelector<HTMLElement>(missing[0].focus)?.focus();
      return;
    }
    if (check.state === "error" || (check.state === "ready" && !check.data?.ok)) {
      setRefresh((n) => n + 1);
      return;
    }
    if (!canReview) {
      setShowMissing(true);
      document.querySelector<HTMLElement>(contactBlocked ? "#wi-client-matches button" : "#wi-done-issues")?.focus();
      return;
    }
    setDoneError(null);
    setReviewed(doneKey);
  };

  const submitDone = () => {
    if (!confirmOpen || !pastStart || !serviceId || !staffId || sending.current) return;
    sending.current = true;
    setError(null);
    setFieldErrors({});
    const key = doneKey;
    const day = pastDay;
    startTransition(async () => {
      try {
        const r = await createManualAppointmentAction(props.clientId, {
          siteId: props.siteId,
          serviceId,
          staffId,
          startAt: pastStart,
          walkIn: true,
          alreadyDone: true,
          idempotencyKey: idemKey,
          ...(linkTo
            ? { contactId: linkTo.contactId }
            : { customerName: name, customerPhone: phone, customerEmail: email, contactMode: saveContact ? ("create" as const) : ("guest" as const) }),
        });
        if (!r.ok) {
          // Everything typed stays; the review closes and the check runs again with the data as it is now.
          setReviewed(null);
          if (r.fieldErrors) setFieldErrors(r.fieldErrors);
          if (r.matches) setMatches({ forKey: typedKey, list: r.matches });
          if (!r.fieldErrors) setDoneError({ key, message: r.error });
          if (!r.fieldErrors && !r.matches) setRefresh((n) => n + 1);
          return;
        }
        props.onDone({ id: r.id, dayKey: day, message: "Atención registrada como completada · cobro pendiente", warning: r.warning });
      } catch {
        setReviewed(null);
        setDoneError({ key, message: "No se pudo registrar. Tus datos siguen aquí; vuelve a intentarlo." });
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

  const pastDayLabel = pastDay === today ? "Hoy" : dayShort(pastDay);
  const pastRange = pastStart ? `${fmtTime(pastStart, tz)}${pastEnd ? ` – ${fmtTime(pastEnd, tz)}` : ""}` : null;
  const summary = done
    ? pastRange && service && staffId
      ? `${pastDayLabel} · ${pastRange} · ${service.name} · ${staffFirst}`
      : "Elige quién la realizó, el servicio, la fecha y la hora"
    : slot && service
      ? `${slot === nowSlot ? "Ahora" : "Hoy"} · ${fmtTime(slot.start_at, tz)} – ${fmtTime(slot.service_end_at, tz)} · ${service.name} · ${staffFirst}`
      : "Hoy, sin reserva previa";

  // What the grid marked, said once at the top — the panel starts from it.
  const painted = initial.startAt && initial.staffId
    ? `${dayShort(siteDayKey(initial.startAt, tz))} · ${fmtTime(initial.startAt, tz)}${initial.spanMin ? ` – ${fmtTime(new Date(Date.parse(initial.startAt) + initial.spanMin * 60_000).toISOString(), tz)}` : ""} · ${props.staff.find((s) => s.id === initial.staffId)?.name.split(" ")[0] ?? ""}`
    : null;
  const switchContext = (): WalkInContext => ({
    staffId: staffId || initial.staffId,
    startAt: done ? pastStart ?? initial.startAt : initial.startAt,
    spanMin: initial.spanMin,
    serviceId: serviceId || undefined,
  });
  const toggleDone = (on: boolean) => {
    setDone(on);
    setReviewed(null);
    setShowMissing(false);
    setError(null);
  };

  // A painted range differs from the service's real length: say which end is kept.
  const paintedDiff = (() => {
    if (!done || !result || !initial.spanMin || !initial.startAt || !pastStart || pastStart !== initial.startAt) return null;
    if (result.durationMin === initial.spanMin) return null;
    const markedEnd = fmtTime(new Date(Date.parse(initial.startAt) + initial.spanMin * 60_000).toISOString(), tz);
    return `Marcaste hasta las ${markedEnd} (${initial.spanMin} min), pero ${service?.name ?? "el servicio"} con ${staffFirst || "este profesional"} dura ${result.durationMin} min: se registra de ${fmtTime(pastStart, tz)} a ${fmtTime(result.serviceEndAt, tz)}.`;
  })();

  const conflictRow = (c: PastConflict, extra?: string) => (
    <span key={c.id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="u-tnum">
        {c.dayKey !== pastDay ? `${dayShort(c.dayKey)} · ` : ""}
        {fmtTime(c.startAt, tz)} – {fmtTime(c.endAt, tz)} · {c.service}
        {c.customer ? ` · ${c.customer}` : ""} · {PAST_STATUS_WORD[c.status] ?? c.status}
        {extra ? ` · ${extra}` : ""}
      </span>
      {props.onOpenAppointment ? (
        <button
          type="button"
          onClick={() => handle.current?.requestCloseThen(() => props.onOpenAppointment?.(c.id, c.dayKey))}
          className="u-focus rounded text-[12.5px] font-medium text-foreground underline underline-offset-2"
        >
          {c.status === "completed" ? "Ver cita" : "Abrir para completarla"}
        </button>
      ) : null}
    </span>
  );

  return (
    <SidePanel
      name="walkin"
      title={done ? "Registrar atención realizada" : "Atención sin cita"}
      subtitle={
        <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
          <span>
            {props.siteName} · {done ? (pastDay ? dayShort(pastDay) : shortToday(tz)) : shortToday(tz)} ·
          </span>
          <button type="button" onClick={() => props.onSwitchToBooking(switchContext())} className="u-focus rounded text-foreground hover:underline">
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
            {confirmOpen && pastStart && service ? (
              <div role="alertdialog" aria-labelledby="wi-done-confirm" className="flex flex-col gap-1 rounded-[10px] bg-[var(--chip)] px-3 py-2.5">
                <p id="wi-done-confirm" className="text-[13px] font-medium">¿Registrar esta atención como completada?</p>
                <p className="u-tnum text-[12.5px] text-muted">
                  {summary}. Queda completada en esa fecha y hora; el registro queda con tu nombre y la fecha de hoy. El cobro queda pendiente y no se envía ningún mensaje al cliente.
                </p>
              </div>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <div aria-live="polite" className="flex w-full min-w-0 flex-col sm:w-auto sm:flex-1">
                <span className="text-[12.5px] text-muted">Atención ya realizada</span>
                <span className="truncate text-[14px] font-medium tabular-nums">{summary}</span>
              </div>
              <span className="flex-1 sm:hidden" />
              {confirmOpen ? (
                <>
                  <Button data-wi-confirm-back="" onClick={() => setReviewed(null)} disabled={pending}>
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
                  <Button variant="primary" onClick={review} loading={check.state === "loading" && missing.length === 0} loadingLabel="Comprobando…" disabled={pending}>
                    {pastFailure ? "Revisar de nuevo" : "Revisar registro"}
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
        {painted ? (
          <p className="mb-2 rounded-[10px] bg-[var(--chip)] px-3 py-2 text-[12.5px] leading-[1.45] text-[var(--ag-ink2)]">
            <span className="font-medium text-foreground">Marcaste {painted}.</span>{" "}
            {done
              ? "La fecha, la hora y el profesional ya están puestos; elige el servicio."
              : "La atención sin cita empieza ahora. Para esa hora, usa «Cambiar a cita con reserva»: se conserva lo que marcaste."}
          </p>
        ) : null}
        <label className="mb-1 flex min-h-[44px] items-start gap-2.5 rounded-[10px] px-3 py-2.5 text-[13px] shadow-[inset_0_0_0_1px_var(--line)] md:min-h-0">
          <input type="checkbox" checked={done} onChange={(e) => toggleDone(e.target.checked)} className="mt-0.5 size-4 accent-[var(--foreground)]" />
          <span>
            <span className="font-medium">Esta atención ya se realizó</span>
            <span className="block text-[12.5px] text-muted">Para registrar un servicio que ya terminó, de hoy o de un día anterior. Se guarda como completada; el cobro queda pendiente y no se envía ningún mensaje.</span>
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
          <div id="wi-staff-list" role="radiogroup" aria-labelledby="wi-staff" className="flex flex-col gap-1.5">
            {ordered.map((s) => {
              const free = nowFree.get(s.id);
              const next = laterFree.get(s.id);
              const on = s.id === staffId;
              const disabled = !done && Boolean(serviceId) && slots.state === "ready" && !free && !next;
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
                    {done ? null : (
                      <span className="block text-[12.5px] tabular-nums text-muted">
                        {!serviceId ? "Elige un servicio" : slots.state === "loading" ? "Calculando…" : free ? `Puede atender ahora · ${fmtTime(free.start_at, tz)}` : next ? `Ahora no · siguiente a las ${fmtTime(next.start_at, tz)}` : "Sin hueco hoy para este servicio"}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
          {done && showMissing && !staffId ? <p className="text-[12.5px] text-danger">Falta elegir quién la realizó.</p> : null}
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
          <div id="wi-service-list" role="radiogroup" aria-labelledby="wi-service" className="grid grid-cols-2 gap-2">
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
          {done && showMissing && !serviceId ? <p className="text-[12.5px] text-danger">Falta elegir el servicio.</p> : null}
        </PanelSection>

        {done ? (
          <PanelSection title="Fecha y hora de inicio" id="wi-when" size="lg" hint="La hora real en que empezó, en la hora de la sede. Puede ser de hoy o de un día anterior.">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Fecha" error={showMissing && (!pastDay || pastDay > today) ? (pastDay > today ? "No puede ser posterior a hoy." : "Falta la fecha.") : undefined}>
                <input
                  id="wi-date"
                  type="date"
                  className={INPUT}
                  value={pastDay}
                  max={today}
                  onChange={(e) => setPastDay(e.target.value)}
                  aria-invalid={showMissing && (!pastDay || pastDay > today)}
                  data-own-escape=""
                />
              </Field>
              <Field label="Hora de inicio" error={showMissing && !siteLocalToUtc(pastDay || today, pastTime, tz) ? "Falta la hora de inicio." : undefined}>
                <input
                  id="wi-time"
                  type="time"
                  step={60}
                  className={INPUT}
                  value={pastTime}
                  onChange={(e) => setPastTime(e.target.value)}
                  aria-invalid={showMissing && !siteLocalToUtc(pastDay || today, pastTime, tz)}
                  data-own-escape=""
                />
              </Field>
            </div>
            <div id="wi-done-issues" tabIndex={-1} aria-live="polite" className="flex flex-col gap-2 outline-none">
              {!checkReady ? (
                <p className="text-[13px] text-muted">
                  {missing.length > 0 ? `Falta ${joinEs(missing.map((m) => m.label))}.` : "Elige el servicio y quién la realizó."}
                </p>
              ) : check.state === "loading" ? (
                <p className="text-[13px] text-muted">Comprobando la agenda de {staffFirst || "este profesional"}…</p>
              ) : check.state === "error" ? (
                <p role="alert" className="text-[13px] text-danger">No pudimos comprobar ese horario. Tus datos siguen aquí; pulsa «Revisar registro» para intentarlo de nuevo.</p>
              ) : check.data && !check.data.ok ? (
                <p role="alert" className="text-[13px] text-danger">{check.data.error}</p>
              ) : result ? (
                <>
                  <p className="u-tnum text-[13px]">
                    <span className="font-medium">
                      {fmtTime(pastStart!, tz)} – {fmtTime(result.serviceEndAt, tz)}
                    </span>
                    <span className="text-muted"> · {service?.name} dura {result.durationMin} min con {staffFirst}</span>
                  </p>
                  {paintedDiff ? <p className="text-[12.5px] leading-[1.45] text-[var(--ag-ink2)]">{paintedDiff}</p> : null}
                  {result.problems.length > 0 ? (
                    <div role="status" className="flex flex-col gap-1 rounded-[10px] bg-[var(--warn-soft)] px-3 py-2.5 text-[12.5px] text-[var(--warn)]">
                      <span className="font-medium">No se puede registrar a esa hora:</span>
                      {result.problems.map((p) => (
                        <span key={p.code} className="u-tnum">{pastProblemText(p, tz, staffFirst)}</span>
                      ))}
                      {result.problems.some((p) => p.code !== "not_ended") ? (
                        <span>Si de verdad se atendió entonces, primero ajusta el horario, la pausa o el bloqueo de ese día; aquí no se hace ninguna excepción.</span>
                      ) : null}
                    </div>
                  ) : null}
                  {result.conflicts.length > 0 ? (
                    <div role="status" className="flex flex-col gap-1 rounded-[10px] bg-[var(--warn-soft)] px-3 py-2.5 text-[12.5px] text-[var(--warn)]">
                      <span className="font-medium">Se cruza con {result.conflicts.length === 1 ? "esta cita" : "estas citas"} de {staffFirst || "este profesional"}:</span>
                      {result.conflicts.map((c) => conflictRow(c))}
                      <span>
                        {result.conflicts.some((c) => c.status !== "completed")
                          ? "Si es la misma atención, ábrela y complétala en lugar de registrar otra. No se cambió ninguna cita."
                          : "Ya hay una atención registrada en ese tiempo. No se cambió ninguna cita."}
                      </span>
                    </div>
                  ) : null}
                  {result.noShows.length > 0 && result.conflicts.length === 0 ? (
                    <p className="flex flex-col gap-0.5 rounded-[10px] bg-[var(--chip)] px-3 py-2 text-[12.5px] text-[var(--ag-ink2)]">
                      <span>
                        En ese tiempo {result.noShows.length === 1 ? "hay una inasistencia" : "hay inasistencias"}: {result.noShows.map((c) => `${fmtTime(c.startAt, tz)} ${c.customer ?? c.service}`).join(", ")}. No impide registrar a quien se atendió; la inasistencia no cambia.
                      </span>
                    </p>
                  ) : null}
                  {result.sameClient.length > 0 ? (
                    <div role="status" className="flex flex-col gap-1 rounded-[10px] bg-[var(--chip)] px-3 py-2.5 text-[12.5px] text-[var(--ag-ink2)]">
                      <span className="font-medium text-foreground">{linkTo?.name ?? "Este cliente"} tenía cita ese día:</span>
                      {result.sameClient.map((c) => conflictRow(c, c.staffName ?? undefined))}
                      <span>Si es esa misma visita, ábrela y complétala para no duplicarla.</span>
                    </div>
                  ) : null}
                </>
              ) : null}
              {pastFailure ? <p role="alert" className="text-[13px] text-danger">{pastFailure}</p> : null}
              {showMissing && missing.length === 0 && check.state === "ready" && !canReview ? (
                <p className="text-[12.5px] text-danger">{contactBlocked ? "Vincula el contacto que ya existe o desmarca «Guardar como contacto»." : "Cambia la hora, el profesional o el servicio, o revisa la cita existente."}</p>
              ) : null}
            </div>
          </PanelSection>
        ) : null}

        <PanelSection title={<>Cliente <span className="font-normal text-muted">· opcional</span></>} id="wi-client" size="lg">
          {linkTo ? (
            <div className="flex items-center gap-3 rounded-[12px] border border-foreground px-3.5 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-semibold">{linkTo.name ?? "Sin nombre"}</p>
                <p className="u-mono truncate text-[12px] text-muted">Se vinculará a este contacto{linkTo.matchedValue ? ` · ${linkTo.matchedValue}` : ""}</p>
              </div>
              <Button size="sm" onClick={() => setLinkTo(null)}>Cambiar</Button>
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-1.5">
                <label className="flex h-[38px] items-center gap-2 rounded-[10px] bg-[var(--chip)] px-3 text-muted">
                  <svg aria-hidden viewBox="0 0 16 16" className="size-[14px] shrink-0" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="7" cy="7" r="4.6" /><path d="M10.4 10.4L14 14" /></svg>
                  <input type="search" placeholder="Buscar cliente: nombre, teléfono o correo" value={contactQuery} onChange={(e) => setContactQuery(e.target.value)} aria-label="Buscar cliente existente" className="min-w-0 flex-1 bg-transparent text-[14px] text-foreground outline-none placeholder:text-muted" />
                </label>
                {term.length >= 2 ? (
                  <div className="flex flex-col">
                    <span className="text-[12.5px] text-muted">{searching ? "Buscando…" : `${hits.length} resultado${hits.length === 1 ? "" : "s"}`}</span>
                    {hits.map((h) => (
                      <button key={h.id} type="button" onClick={() => pickHit(h)} className="u-focus flex min-h-[48px] w-full flex-col justify-center rounded-[10px] px-2 py-1.5 text-left hover:bg-[var(--subtle)]">
                        <span className="truncate text-[14px]">{h.name ?? "Contacto sin nombre"}</span>
                        {h.phone || h.email || h.identity ? <span className="truncate text-[12.5px] tabular-nums text-muted">{[h.phone, h.email].filter(Boolean).join(" · ") || h.identity}</span> : null}
                      </button>
                    ))}
                    {!searching && hits.length === 0 ? <p className="px-2 py-1.5 text-[13px] text-muted">Sin resultados para «{term}». Escribe sus datos abajo como cliente nuevo.</p> : null}
                  </div>
                ) : null}
              </div>
              <p className="text-[12.5px] text-muted">O cliente nuevo. Si lo dejas vacío, se registra sin identificar.</p>
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
                <div id="wi-client-matches" role="status" className="flex flex-col gap-2 rounded-[12px] border border-line px-3.5 py-3">
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

/** «quién la realizó, el servicio y la hora» */
function joinEs(parts: string[]): string {
  return parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} y ${parts[parts.length - 1]}`;
}

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

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { priceLabelCOP } from "@/lib/money";
import {
  dayHeadline,
  fmtTime,
  monthDiff,
  monthSegments,
  shiftMonth,
  siteDayKey,
  timezoneLabel,
  todayAtSite,
  weekdayKeyOf,
  type DayKey,
  type HourFormat,
  type MonthKey,
} from "@/lib/siteCalendar";
import { BookingStepper } from "./BookingStepper";
import { BookingSummary, type SummaryRow } from "./BookingSummary";
import { BookingConfirmation, type PublicConfirmation } from "./BookingConfirmation";
import { MonthCalendar, type DayStatus } from "./MonthCalendar";
import { ServiceList, priceText, type ServiceOption } from "./ServiceList";
import { SlotPicker } from "./SlotPicker";
import { StaffChooser, type StaffOption } from "./StaffChooser";
import { TurnstileField, type TurnstileHandle } from "./TurnstileField";

/**
 * PUBLIC booking flow — three steps for a customer arriving from Instagram, WhatsApp or
 * a website:
 *   1. Servicio y profesional   2. Fecha y hora   3. Tus datos → confirmación
 *
 * Layout (the "Reserva pública" design): one card — progress line, the current step at
 * full width, and a footer that always states the running choice in two lines next to
 * Volver / Continuar. "Continuar" is never a dead disabled button: pressed early, it says
 * what is missing. The month calendar keeps the app's own look (MonthCalendar).
 *
 * Everything real comes from the public /api/booking/{slug}/* endpoints, which run the
 * SAME booking engine as staff and n8n. This component never computes availability: it
 * asks for each month in consecutive ≤14-day segments (the endpoint's cap) and only
 * decides how to SHOW the answer. It never sends a tenant, client, price, duration,
 * status or origin — the server derives all of them.
 *
 * Instagram/WhatsApp in-app browsers: no popups, no new tabs, no cookies, no hover-only
 * signals, 44px+ targets, real `autocomplete` and `inputMode`, and every selection lives
 * in state so the keyboard opening and closing never loses it.
 */

interface PublicSite {
  name: string;
  address: string | null;
  timezone: string;
  closed_weekdays: string[];
}
interface StaffDetail extends StaffOption {
  duration_min: number;
  price: string | null;
}
interface Slot {
  start_at: string;
  service_end_at: string;
  staff_id: string;
  available_staff_ids: string[];
}
type Step = 1 | 2 | 3;
type Banner = { tone: "error" | "info"; text: string; retry?: () => void } | null;
type LoadState = "idle" | "loading" | "loaded" | "error";

const STEPS = [
  { value: 1 as const, label: "Servicio y profesional" },
  { value: 2 as const, label: "Fecha y hora" },
  { value: 3 as const, label: "Tus datos" },
];

/** Dialling codes offered beside the phone field. The SERVER still normalizes the
 * number (site region aware) — this only saves the visitor typing the prefix. */
const COUNTRY_CODES = [
  { code: "+57", label: "🇨🇴 +57", nationalLength: 10 },
  { code: "+52", label: "🇲🇽 +52", nationalLength: 10 },
  { code: "+34", label: "🇪🇸 +34", nationalLength: 9 },
  { code: "+1", label: "🇺🇸 +1", nationalLength: 10 },
] as const;

/** How far ahead the month arrows go. The site's booking horizon still decides which
 * days actually have room; this only stops the arrows wandering into empty years. */
const MAX_MONTHS_AHEAD = 12;
/** A month's availability is reused for this long before it is fetched again. */
const AVAILABILITY_TTL_MS = 60_000;

const NETWORK_ERROR = "No pudimos conectar. Revisa tu conexión e inténtalo de nuevo.";
const UNAVAILABLE_TITLE = "Las reservas en línea no están disponibles";

const INPUT =
  "u-focus h-[48px] w-full min-w-0 rounded-[10px] border border-line-strong bg-surface px-3.5 text-base text-foreground outline-none placeholder:text-faint aria-[invalid=true]:border-danger";

/** A per-attempt Idempotency-Key. randomUUID needs a secure context; fall back to
 * getRandomValues so a plain-http preview still works. */
function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

async function readError(res: Response): Promise<{ code: string; message: string }> {
  try {
    const d = (await res.json()) as { error?: { code?: string; message?: string } };
    return { code: d.error?.code ?? "", message: d.error?.message ?? "No pudimos completar la reserva. Inténtalo de nuevo." };
  } catch {
    return { code: "", message: "No pudimos completar la reserva. Inténtalo de nuevo." };
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function FieldError({ id, children }: { id?: string; children: React.ReactNode }) {
  return (
    <span id={id} role="alert" className="flex items-center gap-1.5 text-[13px] text-danger">
      <span aria-hidden>!</span>
      {children}
    </span>
  );
}

export function BookingFlow({
  slug,
  site,
  initialServices,
  turnstileSiteKey,
  turnstileMisconfigured,
  privacyPolicyUrl,
}: {
  slug: string;
  site: PublicSite;
  initialServices: ServiceOption[];
  turnstileSiteKey: string | null;
  turnstileMisconfigured: boolean;
  privacyPolicyUrl: string | null;
}) {
  const tz = site.timezone;
  const api = `/api/booking/${encodeURIComponent(slug)}`;
  const todayKey = todayAtSite(tz);

  const [step, setStep] = useState<Step>(1);
  const [unavailable, setUnavailable] = useState(false);
  const [banner, setBanner] = useState<Banner>(null);
  /** "Continuar" pressed before the step is complete — says what is missing. */
  const [hint, setHint] = useState("");
  const [hourFormat, setHourFormat] = useState<HourFormat>("24");

  // ── Step 1 ──
  const [services, setServices] = useState<ServiceOption[]>(initialServices);
  const [serviceId, setServiceId] = useState("");
  const [staffId, setStaffId] = useState(""); // "" = Cualquier profesional
  const [staffByService, setStaffByService] = useState<Record<string, StaffDetail[]>>({});
  const [staffState, setStaffState] = useState<LoadState>("idle");

  // ── Step 2 ──
  const [month, setMonth] = useState<MonthKey>(todayKey.slice(0, 7));
  const [day, setDay] = useState<DayKey | null>(null);
  const [slotStart, setSlotStart] = useState<string | null>(null);
  const [monthSlots, setMonthSlots] = useState<Slot[]>([]);
  const [monthState, setMonthState] = useState<LoadState>("idle");
  const cache = useRef(new Map<string, { slots: Slot[]; at: number }>());
  const request = useRef(0);

  // ── Step 3 ──
  const [name, setName] = useState("");
  const [countryCode, setCountryCode] = useState<string>(COUNTRY_CODES[0].code);
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [attempted, setAttempted] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [confirmation, setConfirmation] = useState<PublicConfirmation | null>(null);
  const idemKey = useRef<string>("");
  const turnstile = useRef<TurnstileHandle>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  /** The times panel — on the phone it sits UNDER the month, so picking a day brings it into view. */
  const timesRef = useRef<HTMLDivElement>(null);
  /** "¿Con quién?" — under the services on the phone, so choosing one brings it into view. */
  const staffRef = useRef<HTMLDivElement>(null);
  const firstRender = useRef(true);

  const service = services.find((s) => s.id === serviceId) ?? null;
  const staffList = serviceId ? staffByService[serviceId] ?? [] : [];
  const staff = staffList.find((s) => s.id === staffId) ?? null;

  // Move focus to the step's heading when the step changes (keyboard + screen readers),
  // and bring the card's top into view on the phone.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    const target = confirmation ? document.getElementById("booking-done-title") : headingRef.current;
    target?.focus({ preventScroll: true });
    topRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [step, confirmation]);

  // ── Data loading ────────────────────────────────────────────────────────────────

  const loadStaff = useCallback(
    async (svc: string) => {
      setStaffState("loading");
      try {
        const res = await fetch(`${api}/staff?service_id=${encodeURIComponent(svc)}`, { cache: "no-store" });
        if (res.status === 404) return setUnavailable(true);
        if (!res.ok) {
          setStaffState("error");
          return;
        }
        const d = (await res.json()) as { staff?: StaffDetail[] };
        setStaffByService((prev) => ({ ...prev, [svc]: d.staff ?? [] }));
        setStaffState("loaded");
      } catch {
        setStaffState("error");
      }
    },
    [api],
  );

  const refreshServices = useCallback(async () => {
    try {
      const res = await fetch(`${api}/services`, { cache: "no-store" });
      if (res.status === 404) return setUnavailable(true);
      if (!res.ok) return;
      const d = (await res.json()) as { services?: ServiceOption[] };
      setServices(d.services ?? []);
    } catch {
      /* the banner already told the customer what happened */
    }
  }, [api]);

  const loadMonth = useCallback(
    async (svc: string, stf: string, m: MonthKey, opts: { force?: boolean } = {}) => {
      const key = `${svc}|${stf}|${m}`;
      const hit = cache.current.get(key);
      const id = ++request.current;
      if (hit && !opts.force && Date.now() - hit.at < AVAILABILITY_TTL_MS) {
        setMonthSlots(hit.slots);
        setMonthState("loaded");
        return hit.slots;
      }
      setMonthState("loading");
      setMonthSlots([]);
      const segments = monthSegments(m, todayAtSite(tz), tz);
      try {
        const responses = await Promise.all(
          segments.map((seg) => {
            const q = new URLSearchParams({ service_id: svc, from: seg.from.toISOString(), to: seg.to.toISOString() });
            if (stf) q.set("staff_id", stf);
            return fetch(`${api}/availability?${q.toString()}`, { cache: "no-store" });
          }),
        );
        if (id !== request.current) return null; // a newer month/service/staff won
        if (responses.some((r) => r.status === 404)) {
          setUnavailable(true);
          return null;
        }
        const conflict = responses.find((r) => r.status === 409);
        if (conflict) {
          const e = await readError(conflict);
          setBanner({ tone: "error", text: e.message });
          setStep(1);
          setServiceId("");
          void refreshServices();
          return null;
        }
        if (responses.some((r) => !r.ok)) throw new Error("availability");
        const bodies = (await Promise.all(responses.map((r) => r.json()))) as Array<{ slots?: Slot[] }>;
        if (id !== request.current) return null;
        const slots = bodies.flatMap((b) => b.slots ?? []);
        cache.current.set(key, { slots, at: Date.now() });
        setMonthSlots(slots);
        setMonthState("loaded");
        return slots;
      } catch {
        if (id !== request.current) return null;
        setMonthState("error");
        return null;
      }
    },
    [api, tz, refreshServices],
  );

  /** Slots of the loaded month, by site day, one per clock time (for "any" several
   * professionals can share a start; the customer picks a TIME, the engine the person). */
  const slotsByDay = useMemo(() => {
    const map = new Map<DayKey, Slot[]>();
    const seen = new Set<string>();
    for (const s of [...monthSlots].sort((a, b) => a.start_at.localeCompare(b.start_at))) {
      if (seen.has(s.start_at)) continue;
      seen.add(s.start_at);
      const k = siteDayKey(s.start_at, tz);
      const list = map.get(k);
      if (list) list.push(s);
      else map.set(k, [s]);
    }
    return map;
  }, [monthSlots, tz]);

  // Entering step 2 (or changing what we search for) loads that month; once loaded, a
  // day is picked for the customer when theirs has no room — the first with cupos.
  useEffect(() => {
    if (step !== 2 || !serviceId) return;
    let cancelled = false;
    void loadMonth(serviceId, staffId, month).then((slots) => {
      if (cancelled || !slots) return;
      const days = new Set(slots.map((s) => siteDayKey(s.start_at, tz)));
      setDay((current) => {
        if (current && current.startsWith(month) && days.has(current)) return current;
        const first = [...days].sort()[0];
        return first ?? null;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [step, serviceId, staffId, month, loadMonth, tz]);

  // ── Derived display values ──────────────────────────────────────────────────────

  const daySlots = day ? slotsByDay.get(day) ?? [] : [];
  const slot = slotStart ? daySlots.find((s) => s.start_at === slotStart) ?? null : null;
  const closed = new Set(site.closed_weekdays);

  const statusOf = (d: DayKey, inMonth: boolean): DayStatus => {
    if (!inMonth) return "outside";
    if (d < todayKey) return "past";
    if (closed.has(weekdayKeyOf(d))) return "closed";
    if (monthState === "loading" || monthState === "idle") return "loading";
    if (monthState === "error") return "past";
    return (slotsByDay.get(d)?.length ?? 0) > 0 ? "available" : "full";
  };

  /** Duration + price the customer will actually get: the chosen professional's own
   * values, or — for "any" — the site's, with "Desde" when professionals differ. */
  const durationMin = staff?.duration_min ?? service?.duration_min ?? null;
  const priceLabel = (() => {
    if (!service) return null;
    if (staff) return priceText(staff.price);
    const prices = staffList.map((s) => s.price).filter((p): p is string => p != null).map(Number);
    if (prices.length > 1 && new Set(prices).size > 1) {
      const min = priceLabelCOP(Math.min(...prices));
      return min ? `Desde ${min}` : priceText(service.price);
    }
    return priceText(service.price);
  })();
  const staffLabel = !serviceId ? null : staff ? staff.name : "Primer profesional disponible";
  const dayLabel = day ? dayHeadline(day) : null;
  const timeLabel = slot ? `${fmtTime(slot.start_at, tz, hourFormat)} – ${fmtTime(slot.service_end_at, tz, hourFormat)}` : null;

  const summaryRows: SummaryRow[] = [
    { label: "Sede", value: site.name },
    { label: "Servicio", value: service?.name ?? null },
    { label: "Profesional", value: staffLabel },
    { label: "Fecha", value: slot ? dayLabel : null },
    { label: "Hora", value: timeLabel, mono: true },
    { label: "Duración", value: durationMin != null && service ? `${durationMin} min` : null, mono: true },
    { label: "Precio", value: priceLabel },
    { label: "Zona horaria", value: timezoneLabel(tz) },
  ];

  /** The footer's two lines: WHAT (service · duration · price), then WHO and WHEN. */
  const footLine1 = service ? [service.name, durationMin != null ? `${durationMin} min` : null, priceLabel].filter(Boolean).join(" · ") : "Elige servicio, fecha y hora";
  const footLine2 =
    [service ? (staff ? staff.name : "Cualquier profesional") : null, slot ? dayLabel : null, timeLabel].filter(Boolean).join(" · ") ||
    "Nada se reserva hasta que confirmes";

  // ── Step 3 validation ───────────────────────────────────────────────────────────

  const country = COUNTRY_CODES.find((c) => c.code === countryCode) ?? COUNTRY_CODES[0];
  const phoneDigits = phone.replace(/\D/g, "");
  const fullPhone = phone.trim().startsWith("+") ? phone.trim() : `${country.code} ${phoneDigits}`;
  const errors = {
    name: name.trim().length < 2 ? "Escribe tu nombre para saber a quién esperamos." : "",
    phone: !phoneDigits
      ? "Necesitamos un número para avisarte sobre tu cita."
      : !phone.trim().startsWith("+") && phoneDigits.length !== country.nationalLength
        ? `El número debe tener ${country.nationalLength} dígitos (tienes ${phoneDigits.length}).`
        : "",
    email: email.trim() && !EMAIL_RE.test(email.trim()) ? "Revisa el correo: falta algo como «@» o «.com»." : "",
    consent: accepted ? "" : "Marca la casilla para poder confirmar.",
  };
  const show = (k: keyof typeof errors) => ((attempted || touched[k]) && errors[k]) || "";
  const touch = (k: string) => () => setTouched((t) => ({ ...t, [k]: true }));
  const turnstileOk = !turnstileSiteKey || Boolean(turnstileToken);
  const formOk = !errors.name && !errors.phone && !errors.email && !errors.consent && turnstileOk && !turnstileMisconfigured;

  // ── Actions ─────────────────────────────────────────────────────────────────────

  const chooseService = (id: string) => {
    setBanner(null);
    setHint("");
    if (id !== serviceId) {
      setServiceId(id);
      setStaffId("");
      setDay(null);
      setSlotStart(null);
    }
    if (!staffByService[id]) void loadStaff(id);
    else setStaffState("loaded");
    if (window.matchMedia("(max-width: 767px)").matches) {
      requestAnimationFrame(() => staffRef.current?.scrollIntoView({ block: "start", behavior: "smooth" }));
    }
  };

  const chooseStaff = (id: string) => {
    setStaffId(id);
    setSlotStart(null);
  };

  const changeMonth = (delta: number) => {
    setMonth((m) => shiftMonth(m, delta));
    setDay(null);
    setSlotStart(null);
  };

  const go = (next: Step) => {
    setBanner(null);
    setHint("");
    setStep(next);
  };

  const retryMonth = () => {
    if (serviceId) void loadMonth(serviceId, staffId, month, { force: true });
  };

  /** A slot was lost (409) or is now in the past: drop it, refetch the month, step 2. */
  const backToTimes = (message: string) => {
    for (const k of [...cache.current.keys()]) if (k.startsWith(`${serviceId}|`)) cache.current.delete(k);
    setSlotStart(null);
    setBanner({ tone: "error", text: message });
    setStep(2);
    if (serviceId) {
      void loadMonth(serviceId, staffId, month, { force: true });
    }
  };

  const submit = async () => {
    setAttempted(true);
    if (!slot || !service || submitting) return;
    if (!formOk) {
      setHint(turnstileSiteKey && !turnstileToken ? "Completa la verificación de seguridad." : "Revisa los campos marcados.");
      return;
    }
    setBanner(null);
    setHint("");
    setSubmitting(true);
    if (!idemKey.current) idemKey.current = newIdempotencyKey();
    try {
      const res = await fetch(api, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": idemKey.current },
        cache: "no-store",
        body: JSON.stringify({
          service_id: service.id,
          // Omitted for "Cualquier profesional": the engine assigns whoever is free AT
          // COMMIT TIME, which survives a race the suggested professional would lose.
          ...(staffId ? { staff_id: staffId } : {}),
          start_at: slot.start_at,
          customer_name: name.trim(),
          customer_phone: fullPhone,
          ...(email.trim() ? { customer_email: email.trim() } : {}),
          privacy_accepted: true,
          ...(turnstileToken ? { turnstile_token: turnstileToken } : {}),
        }),
      });
      if (res.ok) {
        const d = (await res.json()) as { confirmation: PublicConfirmation };
        idemKey.current = "";
        cache.current.clear();
        setConfirmation(d.confirmation);
        return;
      }
      if (res.status === 404) {
        setUnavailable(true);
        return;
      }
      const e = await readError(res);
      switch (e.code) {
        case "slot_taken":
        case "staff_unavailable":
        case "past_start":
          backToTimes(e.message);
          return;
        case "service_unavailable":
          setBanner({ tone: "error", text: e.message });
          setServiceId("");
          setSlotStart(null);
          setStep(1);
          void refreshServices();
          return;
        case "duplicate_request":
          idemKey.current = "";
          break;
        case "verification_failed":
        case "verification_unavailable":
          turnstile.current?.reset();
          break;
      }
      setBanner({ tone: "error", text: e.message });
    } catch {
      // Keep the Idempotency-Key: a retry of the SAME attempt must dedupe, never book twice.
      setBanner({ tone: "error", text: NETWORK_ERROR, retry: () => void submit() });
    } finally {
      setSubmitting(false);
    }
  };

  /** The footer's primary action. Never disabled for "not chosen yet": it explains. */
  const next = () => {
    if (step === 1) {
      if (!serviceId) return setHint("Elige un servicio para continuar.");
      return go(2);
    }
    if (step === 2) {
      if (!slot) return setHint(day ? "Elige un horario para continuar." : "Elige un día y un horario para continuar.");
      return go(3);
    }
    void submit();
  };

  const startOver = () => {
    setConfirmation(null);
    setServiceId("");
    setStaffId("");
    setDay(null);
    setSlotStart(null);
    setAccepted(false);
    setAttempted(false);
    setTouched({});
    setTurnstileToken(null);
    setBanner(null);
    setHint("");
    setMonth(todayAtSite(tz).slice(0, 7));
    setStep(1);
  };

  // ── Render ──────────────────────────────────────────────────────────────────────

  /** One card. On the phone it runs edge to edge (only its top corners rounded). */
  const CARD =
    "flex scroll-mt-4 flex-col overflow-hidden border border-line bg-surface rounded-2xl max-sm:-mx-[var(--content-pad)] max-sm:-mb-[var(--content-pad)] max-sm:rounded-b-none max-sm:rounded-t-[18px] max-sm:border-x-0 max-sm:border-b-0";

  if (unavailable) {
    return (
      <div className={`${CARD} items-center gap-2 px-6 py-14 text-center`}>
        <h2 className="text-lg font-semibold">{UNAVAILABLE_TITLE}</h2>
        <p className="max-w-sm text-sm text-muted">En este momento no es posible reservar en esta sede. Comunícate directamente con ella.</p>
      </div>
    );
  }

  if (confirmation) {
    return (
      <div ref={topRef} className={`${CARD} px-4 sm:px-8`}>
        <BookingConfirmation confirmation={confirmation} firstName={name.trim().split(/\s+/)[0] || null} format={hourFormat} onAnother={startOver} />
      </div>
    );
  }

  const headingId = "booking-step-heading";
  const legend = "text-[17px] font-semibold text-foreground outline-none";

  return (
    <section ref={topRef} aria-label="Reservar cita" className={CARD}>
      <div className="border-b border-line px-4 py-3.5 sm:px-6 sm:py-4">
        <BookingStepper steps={STEPS} current={step} onSelect={(s) => go(s)} />
      </div>

      {/* The step. From md up the card keeps ONE height across steps (the step scrolls
          inside it), so Volver/Continuar never jump; on the phone it flows and the
          footer rides the bottom of the screen. */}
      <div className="flex min-w-0 flex-col gap-4 px-4 pb-6 pt-5 sm:px-8 sm:pb-8 sm:pt-7 md:h-[600px] md:overflow-y-auto">
        {banner ? (
          <div
            role="alert"
            className={`flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl px-3.5 py-3 text-sm ${
              banner.tone === "error" ? "bg-danger/10 text-danger" : "bg-subtle text-foreground"
            }`}
          >
            <span className="min-w-0 flex-1">{banner.text}</span>
            {banner.retry ? (
              <button type="button" onClick={banner.retry} className="u-focus h-[36px] rounded-lg border border-current px-3 text-xs font-medium">
                Reintentar
              </button>
            ) : null}
          </div>
        ) : null}

        {step === 1 ? (
          <div className="flex flex-col gap-7">
            <section aria-labelledby={headingId} className="flex flex-col gap-3.5">
              <h2 id={headingId} ref={headingRef} tabIndex={-1} className={legend}>
                ¿Qué servicio quieres?
              </h2>
              <ServiceList services={services} selected={serviceId} onSelect={chooseService} />
            </section>

            <div ref={staffRef} role="group" aria-labelledby="booking-staff-heading" className="flex min-w-0 scroll-mt-3 flex-col gap-3">
              <div className="flex flex-col gap-1">
                <h3 id="booking-staff-heading" className={legend}>
                  ¿Con quién?
                </h3>
                <p className="text-[13px] text-muted">
                  {serviceId
                    ? "Si no tienes preferencia, te asignamos a quien tenga el horario libre."
                    : "Elige un servicio para ver quién lo hace."}
                </p>
              </div>
              <StaffChooser
                staff={staffList}
                selected={staffId}
                onSelect={chooseStaff}
                disabled={!serviceId}
                loading={staffState === "loading"}
                error={staffState === "error" ? "No pudimos cargar los profesionales. Puedes continuar con «Cualquier profesional»." : null}
              />
            </div>
          </div>
        ) : null}

        {step === 2 ? (
          <section aria-labelledby={headingId} className="flex flex-col gap-4">
            <h2 id={headingId} ref={headingRef} tabIndex={-1} className="sr-only">
              Elige fecha y hora
            </h2>
            <div className="flex flex-wrap items-start gap-7">
              {/* The calendar keeps the app's own look. */}
              <div className="min-w-0 flex-[1_1_340px]">
                <MonthCalendar
                  month={month}
                  selected={day}
                  today={todayKey}
                  statusOf={statusOf}
                  onSelect={(d) => {
                    setDay(d);
                    setSlotStart(null);
                    setHint("");
                    if (window.matchMedia("(max-width: 767px)").matches) {
                      requestAnimationFrame(() => timesRef.current?.scrollIntoView({ block: "start", behavior: "smooth" }));
                    }
                  }}
                  onPrev={() => changeMonth(-1)}
                  onNext={() => changeMonth(1)}
                  canPrev={monthDiff(todayKey.slice(0, 7), month) > 0}
                  canNext={monthDiff(todayKey.slice(0, 7), month) < MAX_MONTHS_AHEAD}
                  loading={monthState === "loading"}
                />
              </div>

              <div
                ref={timesRef}
                className="flex min-w-0 flex-[1_1_240px] scroll-mt-3 flex-col gap-3 md:min-w-[240px] md:max-w-[300px] md:border-l md:border-line md:pl-7"
              >
                <div className="flex items-center gap-2">
                  <h3 className="min-w-0 flex-1 truncate text-[15px] font-semibold">{dayLabel ?? "Horarios"}</h3>
                  <div role="group" aria-label="Formato de hora" className="flex shrink-0 rounded-lg bg-subtle p-0.5">
                    {(["12", "24"] as const).map((f) => (
                      <button
                        key={f}
                        type="button"
                        aria-pressed={hourFormat === f}
                        onClick={() => setHourFormat(f)}
                        className={`u-focus h-[28px] whitespace-nowrap rounded-md px-2.5 text-xs ${
                          hourFormat === f ? "bg-surface text-foreground shadow-[0_1px_2px_rgba(18,21,27,0.12)]" : "text-muted"
                        }`}
                      >
                        {f} h
                      </button>
                    ))}
                  </div>
                </div>
                <div className="flex h-[40px] items-center gap-1.5 rounded-[9px] border border-line px-3 text-[13px] text-muted">
                  Zona horaria: <span className="truncate font-medium text-foreground">{timezoneLabel(tz)}</span>
                </div>

                {monthState === "error" ? (
                  <div className="flex flex-col items-start gap-2 rounded-xl border border-line bg-subtle/40 p-3 text-xs text-muted">
                    No pudimos cargar la disponibilidad.
                    <button type="button" onClick={retryMonth} className="u-focus h-[44px] rounded-lg border border-line-strong px-3 font-medium text-foreground lg:h-[36px]">
                      Reintentar
                    </button>
                  </div>
                ) : (
                  <div className="md:max-h-[27rem] md:overflow-y-auto md:pr-1">
                    <SlotPicker
                      slots={daySlots}
                      timezone={tz}
                      format={hourFormat}
                      selected={slotStart}
                      onSelect={(s) => {
                        setSlotStart(s);
                        setHint("");
                      }}
                      loading={monthState === "loading" || monthState === "idle"}
                      emptyMessage={
                        day
                          ? "No quedan horarios libres este día. Prueba otro día u otro profesional."
                          : monthSlots.length === 0
                            ? "No hay horarios libres este mes. Prueba el mes siguiente u otro profesional."
                            : "Elige un día en el calendario para ver los horarios."
                      }
                    />
                  </div>
                )}
              </div>
            </div>
          </section>
        ) : null}

        {step === 3 ? (
          <section aria-labelledby={headingId} className="flex flex-wrap items-start gap-8">
            <form
              id="booking-form"
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
              className="flex min-w-0 max-w-[520px] flex-[1_1_340px] flex-col gap-5"
            >
              <div className="flex flex-col gap-1">
                <h2 id={headingId} ref={headingRef} tabIndex={-1} className={legend}>
                  Tus datos
                </h2>
                <p className="text-[13px] text-muted">Solo lo necesario para apartar tu horario y avisarte si algo cambia.</p>
              </div>

              <div className="flex flex-col gap-1.5">
                <label htmlFor="f-name" className="text-sm font-medium">
                  Nombre completo
                </label>
                <input
                  id="f-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onBlur={touch("name")}
                  name="name"
                  autoComplete="name"
                  autoCapitalize="words"
                  enterKeyHint="next"
                  maxLength={120}
                  aria-invalid={Boolean(show("name"))}
                  aria-describedby={show("name") ? "e-name" : undefined}
                  className={INPUT}
                />
                {show("name") ? <FieldError id="e-name">{show("name")}</FieldError> : null}
              </div>

              <div className="flex flex-col gap-1.5">
                <label htmlFor="f-phone" className="text-sm font-medium">
                  WhatsApp o teléfono
                </label>
                <div className="flex gap-2">
                  <select
                    aria-label="Indicativo de país"
                    autoComplete="tel-country-code"
                    value={countryCode}
                    onChange={(e) => setCountryCode(e.target.value)}
                    className="u-focus h-[48px] shrink-0 rounded-[10px] border border-line-strong bg-surface px-2.5 text-[15px] text-foreground outline-none"
                  >
                    {COUNTRY_CODES.map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                  <input
                    id="f-phone"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value.replace(/[^\d +]/g, ""))}
                    onBlur={touch("phone")}
                    name="tel"
                    type="tel"
                    inputMode="tel"
                    autoComplete="tel-national"
                    enterKeyHint="next"
                    maxLength={32}
                    placeholder="300 123 4567"
                    aria-invalid={Boolean(show("phone"))}
                    aria-describedby={show("phone") ? "e-phone" : "h-phone"}
                    className={INPUT}
                  />
                </div>
                {show("phone") ? (
                  <FieldError id="e-phone">{show("phone")}</FieldError>
                ) : (
                  <span id="h-phone" className="text-[13px] text-muted">
                    Te contactaremos aquí si hay algún cambio en tu cita.
                  </span>
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <label htmlFor="f-email" className="text-sm font-medium">
                  Correo electrónico <span className="font-normal text-muted">(opcional)</span>
                </label>
                <input
                  id="f-email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onBlur={touch("email")}
                  name="email"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  autoCapitalize="none"
                  enterKeyHint="done"
                  maxLength={254}
                  placeholder="nombre@correo.com"
                  aria-invalid={Boolean(show("email"))}
                  className={INPUT}
                />
                {show("email") ? <FieldError>{show("email")}</FieldError> : null}
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="flex cursor-pointer items-start gap-3">
                  <input
                    type="checkbox"
                    checked={accepted}
                    onChange={(e) => setAccepted(e.target.checked)}
                    required
                    aria-invalid={Boolean(attempted && errors.consent)}
                    className="u-focus mt-px size-5 shrink-0 cursor-pointer accent-[var(--ink)]"
                  />
                  <span className="text-sm leading-[1.45] text-foreground/80">
                    Acepto que {site.name} use mis datos solo para gestionar esta reserva.
                    {privacyPolicyUrl ? (
                      <>
                        {" "}
                        <a href={privacyPolicyUrl} rel="noopener noreferrer" className="text-foreground underline underline-offset-2">
                          Política de privacidad
                        </a>
                      </>
                    ) : null}
                  </span>
                </label>
                {attempted && errors.consent ? <span role="alert" className="pl-8 text-[13px] text-danger">{errors.consent}</span> : null}
              </div>

              {turnstileMisconfigured ? (
                <p role="alert" className="rounded-xl bg-danger/10 px-3 py-2.5 text-xs text-danger">
                  Las reservas en línea no están disponibles en este momento. Inténtalo más tarde.
                </p>
              ) : turnstileSiteKey ? (
                <TurnstileField ref={turnstile} siteKey={turnstileSiteKey} onToken={setTurnstileToken} />
              ) : null}
            </form>

            <div className="min-w-0 max-w-[340px] flex-[1_1_240px]">
              <BookingSummary rows={summaryRows} />
            </div>
          </section>
        ) : null}
      </div>

      {/* FOOTER — the running choice in two lines + the actions. Sticky on the phone so
          the primary action stays under the thumb. */}
      <footer className="sticky bottom-0 z-10 flex flex-wrap items-center gap-3 border-t border-line bg-surface px-4 pb-5 pt-3 sm:px-6 sm:py-4">
        <div className="flex min-w-0 flex-[1_1_220px] flex-col gap-0.5" aria-live="polite">
          <span className="truncate text-sm text-foreground">{footLine1}</span>
          <span className="truncate text-[12.5px] text-muted">{footLine2}</span>
          {hint ? (
            <span role="alert" className="flex items-center gap-1.5 text-[13px] text-warn">
              <span aria-hidden className="size-1.5 rounded-full bg-warn-rule" />
              {hint}
            </span>
          ) : null}
        </div>
        <div className="flex flex-[1_1_100%] gap-2 sm:ml-auto sm:flex-none">
          {step > 1 ? (
            <button
              type="button"
              onClick={() => go((step - 1) as Step)}
              className="u-focus h-[48px] whitespace-nowrap rounded-xl border border-line-strong bg-surface px-[18px] text-sm text-foreground transition-colors hover:bg-subtle sm:h-[44px] sm:rounded-[10px]"
            >
              Volver
            </button>
          ) : null}
          <button
            type="button"
            onClick={next}
            disabled={submitting || (step === 3 && turnstileMisconfigured)}
            className="u-focus h-[48px] flex-1 whitespace-nowrap rounded-xl border border-ink bg-ink px-[22px] text-sm font-medium text-ink-fg transition-colors hover:bg-ink-hover disabled:opacity-50 sm:h-[44px] sm:flex-none sm:rounded-[10px]"
          >
            {step === 3 ? (submitting ? "Confirmando…" : "Confirmar cita") : "Continuar"}
          </button>
        </div>
      </footer>
    </section>
  );
}

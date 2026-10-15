"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { dayHeadline, dayShort, fmtTime, monthDiff, monthSegments, shiftMonth, siteDayKey, timezoneLabel, todayAtSite, weekdayKeyOf, type DayKey, type MonthKey } from "@/lib/siteCalendar";
import {
  CLEARED_MESSAGE,
  STEP_LABELS,
  STEP_TITLES,
  contactErrors,
  dayStatusOf,
  emptyDayCopy,
  expectedPriceOf,
  fullPhone,
  lastBookableDay,
  onArtistChange,
  onServiceChange,
  priceShown,
  priceText,
  reachableStep,
  reconcileArtist,
  revalidateSlot,
  type ArtistChoice,
  type ClearedReason,
  type ContactDraft,
  type ContactErrors,
  type Selection,
  type ServerDayKind,
  type Step,
} from "@/lib/publicBookingFlow";
import { whatsappLink } from "@/lib/bookingPage";
import { priceLabelCOP } from "@/lib/money";
import { ArtistProfile } from "./ArtistProfile";
import { ArtistStep } from "./ArtistStep";
import { BookingDone } from "./BookingDone";
import { BusinessInfo } from "./BusinessInfo";
import { ReviewsDialog, type ReviewsTarget } from "./ReviewsDialog";
import type { PublicPromotionView } from "./ServiceStep";
import { DateTimeStep, type EmptyAction, type EmptyState } from "./DateTimeStep";
import { DetailsStep, type SummaryRow } from "./DetailsStep";
import { ServiceStep } from "./ServiceStep";
import type { TurnstileHandle } from "./TurnstileField";
import {
  CTA_BASE,
  ctaTone,
  IconArrow,
  IconBack,
  IconWhatsApp,
  RatingButton,
  SERIF,
  Spinner,
  type CategoryView,
  type PublicConfirmation,
  type PublicReview,
  type PublicSiteView,
  type RatingSummary,
  type ServiceOption,
  type Slot,
  type StaffOption,
} from "./ui";

/**
 * PUBLIC BOOKING — "Gallery Reserva v3": four fixed steps for a customer arriving from
 * Instagram, WhatsApp or the business's website.
 *   1. Elige tu servicio   2. Elige a tu artista   3. Elige fecha y hora   4. Tus datos
 *
 * Header, title, progress and the bottom bar keep their place; only the content changes
 * and scrolls naturally. Progress is navigable back to any step already reached.
 *
 * Everything real comes from /api/booking/{slug}/* — the SAME engine as staff and n8n.
 * This component never computes availability (it asks for each month in ≤14-day
 * segments, the endpoint's cap) and never sends a tenant, client, price, duration,
 * status or origin: the server derives all of them, re-checks the slot at confirmation
 * and returns the snapshot shown on success. "Sin preferencia" omits staff_id so the
 * engine assigns whoever is free at commit time.
 *
 * Instagram/WhatsApp in-app browsers: no popups or new tabs, no cookies or storage, no
 * hover-only signals, 44px+ targets, 16px fields, real autocomplete/inputMode, and every
 * selection lives in state so the keyboard opening and closing never loses it. The
 * bottom bar respects the safe area and rides above the on-screen keyboard
 * (visualViewport); the focused field is scrolled above it.
 */

type Load = "idle" | "loading" | "loaded" | "error";
type DayReason = "vacation" | "unavailable" | "site_closed" | null;
/** One month of availability for (service, artist choice): the engine's slots and the
 *  server's per-day kinds (web/lib/publicAvailability.ts). */
interface MonthData {
  slots: Slot[];
  days: Array<{ date: DayKey; kind: ServerDayKind; reason: DayReason }>;
  at: number;
}
/** /next-available: the first real day with times, within the booking horizon. */
interface NextInfo {
  staffId: string | null;
  artist: DayKey | null;
  any: DayKey | null;
  others: Array<{ id: string; name: string; first_day: DayKey | null }>;
  horizon_days: number;
}
type SubmitState = "idle" | "sending" | "error" | "taken";

const AVAILABILITY_TTL_MS = 60_000;
const UNAVAILABLE_TITLE = "Las reservas en línea no están disponibles";
const BLANK: ContactDraft = { name: "", cc: "+57", phone: "", email: "", consent: false };
/** Wall-clock ms for the availability cache (only ever read inside async loads). */
const nowMs = () => Date.now();
/** "Mié 14 oct" — the compact date, capitalised as in the design. */
const shortDay = (d: DayKey) => {
  const t = dayShort(d);
  return t.charAt(0).toLocaleUpperCase("es") + t.slice(1);
};

function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

async function readError(res: Response): Promise<{ code: string; message: string; price?: string | null }> {
  try {
    const d = (await res.json()) as { error?: { code?: string; message?: string; price?: string | null } };
    return { code: d.error?.code ?? "", message: d.error?.message ?? "No pudimos completar la reserva. Inténtalo de nuevo.", price: d.error?.price };
  } catch {
    return { code: "", message: "No pudimos completar la reserva. Inténtalo de nuevo." };
  }
}

/** Bottom offset that keeps the bar above the on-screen keyboard (iOS does not resize
 * the layout viewport; Android does with interactive-widget=resizes-content → 0). */
function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    if (!vv) return;
    const update = () => {
      if (vv.scale > 1.05) return setInset(0); // pinch-zoom is not a keyboard
      setInset(Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)));
    };
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    update();
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);
  return inset;
}

export function BookingFlow({
  slug,
  site,
  logoUrl,
  initialServices,
  initialCategories = [],
  siteRating = null,
  siteReviews = [],
  promotions = [],
  turnstileSiteKey,
  turnstileMisconfigured,
  privacyPolicyUrl,
}: {
  slug: string;
  site: PublicSiteView;
  logoUrl: string | null;
  initialServices: ServiceOption[];
  initialCategories?: CategoryView[];
  /** The BUSINESS rating (every approved review of the site) and its latest reviews. */
  siteRating?: RatingSummary | null;
  siteReviews?: PublicReview[];
  /** Published promotions on offer now (the server already applied window A). */
  promotions?: PublicPromotionView[];
  turnstileSiteKey: string | null;
  turnstileMisconfigured: boolean;
  privacyPolicyUrl: string | null;
}) {
  const tz = site.timezone;
  const api = `/api/booking/${encodeURIComponent(slug)}`;
  const todayKey = todayAtSite(tz);
  const lastDay = lastBookableDay(todayKey, site.booking_horizon_days);
  const closedWeekdays = useMemo(() => new Set(site.closed_weekdays), [site.closed_weekdays]);
  // "Bogotá (GMT−5)" with a true minus sign, as in the design.
  const tzText = timezoneLabel(tz).replace(/GMT-(\d)/, "GMT−$1");

  const [step, setStep] = useState<Step>(1);
  // Which way the visitor last moved, so the next step slides in from that side.
  const [stepDir, setStepDir] = useState<"fwd" | "back" | null>(null);
  const [monthDir, setMonthDir] = useState<"fwd" | "back" | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [hint, setHint] = useState("");

  // ── Selection ──
  const [services, setServices] = useState<ServiceOption[]>(initialServices);
  const [categories, setCategories] = useState<CategoryView[]>(initialCategories);
  const [reviews, setReviews] = useState<{ target: ReviewsTarget; trigger: HTMLElement } | null>(null);
  const [sel, setSel] = useState<Selection>({ serviceId: null, artist: null, day: null, slotStart: null });
  // The selection as of the LAST event, kept synchronously: handlers and async loads read
  // it, so no decision ever depends on WHEN React runs a state updater.
  const selRef = useRef(sel);
  const updateSel = (next: Selection | ((cur: Selection) => Selection)) => {
    const value = typeof next === "function" ? next(selRef.current) : next;
    selRef.current = value;
    setSel(value);
  };
  const [cleared, setCleared] = useState<ClearedReason | null>(null);
  const [artistNotice, setArtistNotice] = useState<string | null>(null);
  const [staffByService, setStaffByService] = useState<Record<string, StaffOption[]>>({});
  const [staffLoad, setStaffLoad] = useState<Record<string, Load>>({});
  const [profile, setProfile] = useState<{ id: string; trigger: HTMLElement } | null>(null);

  // ── Availability ──
  const [month, setMonth] = useState<MonthKey>(todayKey.slice(0, 7));
  const [monthSlots, setMonthSlots] = useState<Slot[]>([]);
  const [monthLoad, setMonthLoad] = useState<Load>("idle");
  const [anyDays, setAnyDays] = useState<Set<DayKey> | null>(null);
  // The server's per-day kinds for the loaded month (site closed / artist away / no times).
  const [monthKinds, setMonthKinds] = useState<Map<DayKey, { kind: ServerDayKind; reason: DayReason }>>(() => new Map());
  // The first real day with times, for this artist / anyone / each other artist.
  const [nextInfo, setNextInfo] = useState<NextInfo | null>(null);
  // The day the page chose itself (the first with room), so it can say so.
  const [autoDay, setAutoDay] = useState<DayKey | null>(null);
  const cache = useRef(new Map<string, MonthData>());
  const request = useRef(0);

  // ── Details ──
  const [form, setForm] = useState<ContactDraft>(BLANK);
  const [touched, setTouched] = useState<Partial<Record<keyof ContactErrors, boolean>>>({});
  const [showAll, setShowAll] = useState(false);
  const [phoneServerError, setPhoneServerError] = useState<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [submit, setSubmit] = useState<SubmitState>("idle");
  const [takenTime, setTakenTime] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<PublicConfirmation | null>(null);
  // The server refused because the price changed: shown vs current (raw numeric strings).
  const [priceChange, setPriceChange] = useState<{ previous: string | null; current: string | null; accepted: boolean } | null>(null);
  const idem = useRef<{ key: string; sig: string } | null>(null);
  const sending = useRef(false);
  const turnstile = useRef<TurnstileHandle>(null);

  const topRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const firstRender = useRef(true);
  const fromHistory = useRef(false);
  const kbInset = useKeyboardInset();

  const service = services.find((s) => s.id === sel.serviceId) ?? null;
  const staffList = sel.serviceId ? staffByService[sel.serviceId] ?? [] : [];
  const artist = sel.artist && sel.artist !== "any" ? staffList.find((s) => s.id === sel.artist) ?? null : null;
  const reach = reachableStep(sel);
  const staffParam = sel.artist && sel.artist !== "any" ? sel.artist : "";

  // ── Focus, scroll and history per step ──────────────────────────────────────────
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      if (typeof window !== "undefined") window.history.replaceState({ ...(window.history.state ?? {}), pb3Step: 1 }, "");
      return;
    }
    const target = confirmation ? document.getElementById("pb-done-title") : titleRef.current;
    target?.focus({ preventScroll: true });
    topRef.current?.scrollIntoView({ block: "start" });
    if (!confirmation && !fromHistory.current && window.history.state?.pb3Step !== step) {
      window.history.pushState({ ...(window.history.state ?? {}), pb3Step: step }, "");
    }
    fromHistory.current = false;
  }, [step, confirmation]);

  // The phone's back button walks the steps instead of leaving the page.
  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      const s = (e.state?.pb3Step ?? 1) as Step;
      fromHistory.current = true;
      setProfile(null);
      setReviews(null);
      setStepDir("back");
      setStep((cur) => (s < cur ? s : cur));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // ── Data ────────────────────────────────────────────────────────────────────────
  // Loads are started by the EVENT that needs them (choosing a service, entering the
  // date step, changing month, retrying) — never from an effect — so each request knows
  // exactly which (service, artist, month) it answers.

  /** A chosen artist who does not perform the (new) service is dropped, with a notice. */
  const applyEligibility = (svc: string, list: StaffOption[], prevArtist: ArtistChoice, prevName: string | null, svcName: string) => {
    const ids = list.map((x) => x.id);
    updateSel((cur) => (cur.serviceId === svc ? reconcileArtist(cur, ids).sel : cur));
    if (prevArtist && prevArtist !== "any" && !ids.includes(prevArtist)) {
      setArtistNotice(`${prevName ?? "El artista que elegiste"} no realiza ${svcName}. Elige otro artista o reserva sin preferencia.`);
    }
  };

  const loadStaff = async (svc: string, prevArtist: ArtistChoice = null, prevName: string | null = null, svcName = "este servicio") => {
    setStaffLoad((m) => ({ ...m, [svc]: "loading" }));
    try {
      const res = await fetch(`${api}/staff?service_id=${encodeURIComponent(svc)}`, { cache: "no-store" });
      if (res.status === 404) return setUnavailable(true);
      if (!res.ok) return setStaffLoad((m) => ({ ...m, [svc]: "error" }));
      const d = (await res.json()) as { staff?: StaffOption[] };
      const list = d.staff ?? [];
      setStaffByService((prev) => ({ ...prev, [svc]: list }));
      setStaffLoad((m) => ({ ...m, [svc]: "loaded" }));
      applyEligibility(svc, list, prevArtist, prevName, svcName);
    } catch {
      setStaffLoad((m) => ({ ...m, [svc]: "error" }));
    }
  };

  const refreshServices = async () => {
    try {
      const res = await fetch(`${api}/services`, { cache: "no-store" });
      if (res.status === 404) return setUnavailable(true);
      if (!res.ok) return;
      const d = (await res.json()) as { services?: ServiceOption[]; categories?: CategoryView[] };
      setServices(d.services ?? []);
      if (d.categories) setCategories(d.categories);
    } catch {
      /* the banner already says what happened */
    }
  };

  /** One month of free times for (service, artist), from the cache when fresh. */
  const fetchMonth = async (svc: string, stf: string, m: MonthKey, force = false): Promise<MonthData | "unavailable" | "conflict" | "error"> => {
    // One cache entry per (service, artist choice, month): one artist's answer can never be
    // read as another's, and a stale request is ignored by its caller (request.current).
    const key = `${svc}|${stf}|${m}`;
    const hit = cache.current.get(key);
    if (hit && !force && nowMs() - hit.at < AVAILABILITY_TTL_MS) return hit;
    const segments = monthSegments(m, todayAtSite(tz), tz);
    try {
      const responses = await Promise.all(
        segments.map((seg) => {
          const q = new URLSearchParams({ service_id: svc, from: seg.from.toISOString(), to: seg.to.toISOString(), explain: "1" });
          if (stf) q.set("staff_id", stf);
          return fetch(`${api}/availability?${q.toString()}`, { cache: "no-store" });
        }),
      );
      if (responses.some((r) => r.status === 404)) return "unavailable";
      if (responses.some((r) => r.status === 409)) return "conflict";
      if (responses.some((r) => !r.ok)) return "error";
      const bodies = (await Promise.all(responses.map((r) => r.json()))) as Array<{ slots?: Slot[]; days?: MonthData["days"] }>;
      const data: MonthData = { slots: bodies.flatMap((b) => b.slots ?? []), days: bodies.flatMap((b) => b.days ?? []), at: nowMs() };
      cache.current.set(key, data);
      return data;
    } catch {
      return "error";
    }
  };

  /** "Otro artista sí tiene horarios ese día": asked only when a chosen artist's day is
   *  empty. `id` is the request it belongs to — an answer for an older choice is dropped. */
  const checkOthers = async (svc: string, m: MonthKey, id: number) => {
    const r = await fetchMonth(svc, "", m);
    if (id !== request.current || typeof r === "string") return;
    setAnyDays(new Set(r.slots.map((x) => siteDayKey(x.start_at, tz))));
  };

  /** The first real day with times (this artist, anyone, each other artist) — asked when
   *  the loaded month has none left for the current choice. Same staleness rule. */
  const loadNext = async (svc: string, stf: string, id: number) => {
    try {
      const q = new URLSearchParams({ service_id: svc });
      if (stf) q.set("staff_id", stf);
      const res = await fetch(`${api}/next-available?${q.toString()}`, { cache: "no-store" });
      if (!res.ok || id !== request.current) return;
      const d = (await res.json()) as Omit<NextInfo, "staffId">;
      if (id === request.current) setNextInfo({ ...d, staffId: stf || null });
    } catch {
      /* the month view still works without it */
    }
  };

  const requestMonth = async (svc: string | null, art: ArtistChoice, m: MonthKey, force = false) => {
    if (!svc || !art) return;
    const stf = art === "any" ? "" : art;
    const id = ++request.current;
    setMonthLoad("loading");
    setAnyDays(null);
    setNextInfo(null);
    const r = await fetchMonth(svc, stf, m, force);
    if (id !== request.current) return; // a newer month/service/artist won
    if (r === "unavailable") return setUnavailable(true);
    if (r === "conflict") {
      setBanner("Este servicio ya no está disponible en esta sede. Elige otro servicio.");
      updateSel((cur) => ({ ...cur, serviceId: null, slotStart: null }));
      setStep(1);
      void refreshServices();
      return;
    }
    if (r === "error") return setMonthLoad("error");
    setMonthSlots(r.slots);
    setMonthKinds(new Map(r.days.map((d) => [d.date, { kind: d.kind, reason: d.reason }])));
    setMonthLoad("loaded");
    // Keep the visitor's day when it is in this month; otherwise the first day with room —
    // and say that the page picked it.
    const open = new Set(r.slots.map((x) => siteDayKey(x.start_at, tz)));
    const cur = selRef.current;
    const keep = Boolean(cur.day && cur.day.startsWith(m));
    const chosen: DayKey = keep ? (cur.day as DayKey) : ([...open].sort()[0] ?? (m === todayKey.slice(0, 7) ? todayKey : `${m}-01`));
    setAutoDay(!keep && open.has(chosen) ? chosen : null);
    // The chosen time survives only if the engine STILL offers it for this artist choice.
    const v = revalidateSlot({ ...cur, day: chosen }, { month: m, slots: r.slots }, (iso) => siteDayKey(iso, tz));
    updateSel(v.sel);
    if (v.cleared) setCleared(v.cleared);
    if (stf && !open.has(chosen)) void checkOthers(svc, m, id);
    if (![...open].some((d) => d >= chosen)) void loadNext(svc, stf, id);
  };

  /** Show a specific day (possibly in another month) — an explicit action of the visitor. */
  const jumpToDay = (d: DayKey) => {
    const m = d.slice(0, 7);
    setAutoDay(null);
    setHint("");
    if (m === month) return pickDay(d);
    setMonthDir(m > month ? "fwd" : "back");
    setMonth(m);
    updateSel((c) => ({ ...c, day: d, slotStart: null }));
    void requestMonth(selRef.current.serviceId, selRef.current.artist, m);
  };

  // ── Derived ─────────────────────────────────────────────────────────────────────

  /** One entry per clock time (for "Sin preferencia" several artists share a start). */
  const slotsByDay = useMemo(() => {
    const map = new Map<DayKey, Slot[]>();
    const seen = new Set<string>();
    for (const x of [...monthSlots].sort((p, q) => p.start_at.localeCompare(q.start_at))) {
      if (seen.has(x.start_at)) continue;
      seen.add(x.start_at);
      const k = siteDayKey(x.start_at, tz);
      const list = map.get(k);
      if (list) list.push(x);
      else map.set(k, [x]);
    }
    return map;
  }, [monthSlots, tz]);
  const openDays = useMemo(() => new Set(slotsByDay.keys()), [slotsByDay]);
  const kindMap = useMemo(() => new Map([...monthKinds].map(([d, v]) => [d, v.kind])), [monthKinds]);
  const statusOf = (d: DayKey) => dayStatusOf(d, { today: todayKey, lastDay, closedWeekdays, load: monthLoad, openDays, kinds: kindMap });
  const daySlots = sel.day ? slotsByDay.get(sel.day) ?? [] : [];
  const slot = sel.slotStart ? daySlots.find((x) => x.start_at === sel.slotStart) ?? monthSlots.find((x) => x.start_at === sel.slotStart) ?? null : null;

  const durationMin = artist?.duration_min ?? service?.duration_min ?? null;
  const price = priceShown({ servicePrice: service?.price ?? null, artist: sel.artist, staff: staffList });
  const artistName = sel.artist === "any" ? "Sin preferencia" : artist?.name ?? "";
  const timeLabel = slot ? fmtTime(slot.start_at, tz, "24") : null;

  // ── Actions ─────────────────────────────────────────────────────────────────────

  const goStep = (n: Step) => {
    if (n > reach) return;
    setStepDir(n >= step ? "fwd" : "back");
    setBanner(null);
    setHint("");
    if (n < 4) setSubmit((x) => (x === "taken" || x === "error" ? "idle" : x));
    if (n === 3) {
      const m = sel.day ? sel.day.slice(0, 7) : month;
      if (m !== month) setMonth(m);
      void requestMonth(sel.serviceId, sel.artist, m);
    }
    setStep(n);
  };

  const pickService = (id: string) => {
    const r = onServiceChange(selRef.current, id);
    const svcName = services.find((x) => x.id === id)?.name ?? "este servicio";
    updateSel(r.sel);
    if (r.cleared) setCleared(r.cleared);
    setArtistNotice(null);
    setHint("");
    setBanner(null);
    const cached = staffByService[id];
    if (cached) applyEligibility(id, cached, sel.artist, artist?.name ?? null, svcName);
    else if (staffLoad[id] !== "loading") void loadStaff(id, sel.artist, artist?.name ?? null, svcName);
  };

  /** "Reservar mi experiencia": choose the service and go straight on to the artist. */
  const reserveService = (id: string) => {
    pickService(id);
    setStepDir("fwd");
    setStep(2);
  };

  const openReviews = (target: ReviewsTarget, trigger: HTMLElement) => setReviews({ target, trigger });

  const pickArtist = (choice: Exclude<ArtistChoice, null>) => {
    const r = onArtistChange(selRef.current, choice);
    updateSel(r.sel);
    if (r.cleared) setCleared(r.cleared);
    setArtistNotice(null);
    setProfile(null);
    setHint("");
    if (step === 3 && choice !== sel.artist) void requestMonth(sel.serviceId, choice, month);
  };

  const pickDay = (d: DayKey) => {
    updateSel((cur) => ({ ...cur, day: d, slotStart: cur.day === d ? cur.slotStart : null }));
    setHint("");
    setAutoDay(null);
    const cur = selRef.current;
    const stf = cur.artist && cur.artist !== "any" ? cur.artist : "";
    if (stf && cur.serviceId && monthLoad === "loaded" && !openDays.has(d) && !anyDays) void checkOthers(cur.serviceId, month, request.current);
    if (cur.serviceId && monthLoad === "loaded" && !nextInfo && ![...openDays].some((x) => x >= d)) void loadNext(cur.serviceId, stf, request.current);
  };

  const changeMonth = (delta: number) => {
    const next = shiftMonth(month, delta);
    setMonthDir(delta > 0 ? "fwd" : "back");
    setMonth(next);
    updateSel((cur) => ({ ...cur, day: null, slotStart: null }));
    void requestMonth(selRef.current.serviceId, selRef.current.artist, next);
  };

  const pickSlot = (start: string) => {
    updateSel((s) => ({ ...s, slotStart: start }));
    setCleared(null);
    setHint("");
  };

  const pickOtherTime = () => {
    for (const k of [...cache.current.keys()]) if (k.startsWith(`${sel.serviceId}|`)) cache.current.delete(k);
    updateSel((s) => ({ ...s, slotStart: null }));
    setCleared("taken");
    setSubmit("idle");
    setStepDir("back");
    setStep(3);
    void requestMonth(sel.serviceId, sel.artist, month, true);
  };

  const setField = <K extends keyof ContactDraft>(k: K, v: ContactDraft[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    if (k === "phone" || k === "cc") setPhoneServerError(null);
  };
  const touch = (k: keyof ContactErrors) => setTouched((t) => ({ ...t, [k]: true }));
  const errors = contactErrors(form, site.name);
  const show = (k: keyof ContactErrors) => {
    if (k === "phone" && phoneServerError) return phoneServerError;
    return (showAll || (touched[k] && k !== "consent") ? errors[k] : "") || "";
  };
  const errorCount = showAll ? (["name", "phone", "email", "consent"] as const).filter((k) => show(k)).length : 0;

  /** Keep the focused field visible above the bar and the keyboard (phones). */
  const onFieldFocus = (el: HTMLElement) => {
    if (!window.matchMedia("(max-width: 1023px)").matches) return;
    window.setTimeout(() => el.scrollIntoView({ block: "center", behavior: "smooth" }), 280);
  };

  const confirm = async () => {
    if (!service || !slot || sending.current) return;
    setShowAll(true);
    const hasErrors = Object.values(errors).some(Boolean) || Boolean(phoneServerError);
    if (hasErrors) {
      // Take the visitor to the first field to fix — centred, so the fixed bar never hides
      // it (or its error) on a phone.
      const first = (["name", "phone", "email", "consent"] as const).find((k) => (k === "phone" && phoneServerError) || errors[k]);
      window.setTimeout(() => {
        const el = first ? document.getElementById(`pb-${first}`) : null;
        el?.focus({ preventScroll: true });
        el?.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
      }, 0);
      return;
    }
    if (turnstileMisconfigured) return;
    if (turnstileSiteKey && !turnstileToken) {
      setBanner("Completa la verificación de seguridad.");
      return;
    }
    if (priceChange && !priceChange.accepted) return;
    // The price the visitor is SHOWN (after an accepted change: the new one). The server
    // never takes it as the price — it refuses with price_changed if it no longer holds.
    const shown = priceChange ? priceChange.current : expectedPriceOf({ artist: sel.artist, staff: staffList });
    const payload = {
      service_id: service.id,
      // Omitted for "Sin preferencia": the engine assigns whoever is free AT COMMIT TIME.
      ...(staffParam ? { staff_id: staffParam } : {}),
      start_at: slot.start_at,
      customer_name: form.name.trim(),
      customer_phone: fullPhone(form),
      ...(form.email.trim() ? { customer_email: form.email.trim() } : {}),
      privacy_accepted: true as const,
      ...(shown !== undefined ? { expected_price: shown } : {}),
    };
    // Same booking → same Idempotency-Key, so a retry after a lost response can never
    // book twice. A DIFFERENT booking (another time, another phone…) gets a new key.
    const sig = JSON.stringify(payload);
    if (!idem.current || idem.current.sig !== sig) idem.current = { key: newIdempotencyKey(), sig };
    sending.current = true;
    setSubmit("sending");
    setBanner(null);
    try {
      const res = await fetch(api, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": idem.current.key },
        cache: "no-store",
        body: JSON.stringify({ ...payload, ...(turnstileToken ? { turnstile_token: turnstileToken } : {}) }),
      });
      if (res.ok) {
        const d = (await res.json()) as { confirmation: PublicConfirmation };
        idem.current = null;
        cache.current.clear();
        setSubmit("idle");
        setPriceChange(null);
        setConfirmation(d.confirmation);
        return;
      }
      if (res.status === 404) return setUnavailable(true);
      const e = await readError(res);
      switch (e.code) {
        case "slot_taken":
        case "staff_unavailable":
        case "past_start":
          for (const k of [...cache.current.keys()]) if (k.startsWith(`${sel.serviceId}|`)) cache.current.delete(k);
          setTakenTime(timeLabel);
          setSubmit("taken");
          return;
        case "service_unavailable":
          setSubmit("idle");
          setBanner(e.message);
          updateSel((s) => ({ ...s, serviceId: null, slotStart: null }));
          setStep(1);
          void refreshServices();
          return;
        case "invalid_phone":
          setSubmit("idle");
          setPhoneServerError(e.message);
          return;
        case "price_changed":
          // Nothing was booked. Show both prices and ask for an explicit acceptance;
          // refresh what the page lists so every price on it is the current one.
          setSubmit("idle");
          setPriceChange({ previous: shown ?? null, current: e.price ?? null, accepted: false });
          if (sel.serviceId) void loadStaff(sel.serviceId, sel.artist, artist?.name ?? null, service.name);
          void refreshServices();
          return;
        case "duplicate_request":
          idem.current = null;
          break;
        case "verification_failed":
        case "verification_unavailable":
          turnstile.current?.reset();
          setTurnstileToken(null);
          break;
      }
      setSubmit("idle");
      setBanner(e.message);
    } catch {
      // Keep the Idempotency-Key: a retry of the SAME attempt must dedupe, never book twice.
      setSubmit("error");
    } finally {
      sending.current = false;
    }
  };

  const restart = () => {
    setConfirmation(null);
    setPriceChange(null);
    setStepDir("back");
    updateSel({ serviceId: null, artist: null, day: null, slotStart: null });
    setCleared(null);
    setArtistNotice(null);
    setForm((f) => ({ ...BLANK, name: f.name, cc: f.cc, phone: f.phone, email: f.email }));
    setShowAll(false);
    setTouched({});
    setTurnstileToken(null);
    setSubmit("idle");
    setMonth(todayAtSite(tz).slice(0, 7));
    setStep(1);
  };

  // ── CTA / bar ───────────────────────────────────────────────────────────────────

  let ctaLabel = "Continuar";
  let ctaState: "on" | "muted" | "sending" | "outline" = "on";
  let barHint = "";
  let cta: () => void = () => goStep((step + 1) as Step);
  if (confirmation) {
    ctaLabel = "Hacer otra reserva";
    ctaState = "outline";
    cta = restart;
  } else if (step === 1) {
    if (!service) {
      ctaState = "muted";
      barHint = "Elige un servicio para continuar.";
    }
  } else if (step === 2) {
    if (!sel.artist) {
      ctaState = "muted";
      barHint = "Elige un artista o Sin preferencia.";
    }
  } else if (step === 3) {
    if (!slot) {
      ctaState = "muted";
      barHint = "Elige una hora disponible.";
    }
  } else {
    cta = () => void confirm();
    ctaLabel = submit === "sending" ? "Confirmando…" : submit === "error" ? "Reintentar" : "Confirmar cita";
    ctaState = submit === "sending" ? "sending" : submit === "taken" || turnstileMisconfigured ? "muted" : "on";
    if (priceChange && !priceChange.accepted && submit !== "sending") {
      ctaState = "muted";
      barHint = "Revisa el nuevo precio para continuar.";
    }
  }
  const ctaDisabled = ctaState === "muted" || ctaState === "sending";
  const onCta = () => {
    if (ctaDisabled) {
      if (barHint) setHint(barHint);
      return;
    }
    cta();
  };
  // After an accepted (or pending) price change the server's current price is the one shown.
  const priceNow = priceChange ? { label: priceLabelCOP(priceChange.current), from: false } : price;
  const barPrice = service && !confirmation ? priceText(priceNow, true) : "";
  const barSub = !service
    ? ""
    : step === 1
      ? `${service.name} · ${durationMin ?? service.duration_min} min`
      : step === 2
        ? [service.name, artistName].filter(Boolean).join(" · ")
        : slot && sel.day
          ? `${shortDay(sel.day)} · ${timeLabel} · ${artistName}`
          : `${service.name} · ${artistName}`;

  // ── Step 3 empty state ──────────────────────────────────────────────────────────

  const empty: EmptyState | null = (() => {
    if (step !== 3 || !sel.day || monthLoad !== "loaded") return null;
    const day = sel.day;
    const st = statusOf(day);
    if (st === "open" || st === "loading" || st === "unknown") return null;
    const specific = sel.artist !== "any" ? artistName : null;
    const laterOpen = [...openDays].filter((d) => d > day).sort()[0];
    // Beyond this month: the engine's real next day for the current choice (never a guess).
    const nextReal = nextInfo && nextInfo.staffId === (staffParam || null) ? (specific ? nextInfo.artist : nextInfo.any) : null;
    const nextMonth = shiftMonth(month, 1);
    const next = laterOpen
      ? { label: `Ver ${dayShort(laterOpen)}`, action: { kind: "day" as const, day: laterOpen } }
      : nextReal && nextReal > day
        ? { label: `Ver ${dayShort(nextReal)}`, action: { kind: "jump" as const, day: nextReal } }
        : !nextInfo && `${nextMonth}-01` <= lastDay
          ? { label: "Ver el mes siguiente", action: { kind: "nextMonth" as const } }
          : undefined;
    if (st === "past" || st === "out") {
      return { title: "Este día no se puede reservar", text: `Puedes reservar hasta el ${dayHeadline(lastDay).toLocaleLowerCase("es")}.`, next };
    }

    // The chosen artist has NO time left within the booking window: say so, and offer the
    // real alternatives as explicit actions — the artist is never changed for the visitor.
    if (specific && nextInfo && nextInfo.staffId === staffParam && !laterOpen && !nextInfo.artist) {
      const withTimes = nextInfo.others.filter((o) => o.first_day);
      return {
        title: `${specific} no tiene horarios disponibles hasta el ${dayHeadline(lastDay).toLocaleLowerCase("es")}`,
        text: withTimes.length ? "Puedes elegir a otro artista o reservar sin preferencia." : "Por ahora ningún artista tiene horarios para este servicio en línea.",
        note: withTimes.length ? withTimes.map((o) => `${o.name} tiene horarios desde el ${dayHeadline(o.first_day as DayKey).toLocaleLowerCase("es")}.`).join(" ") : undefined,
        next: nextInfo.any ? { label: "Buscar sin preferencia", action: { kind: "any" as const } } : undefined,
        alt: withTimes.length ? { label: "Ver otros artistas", action: { kind: "artist" as const } } : undefined,
      };
    }

    const anyHas = specific ? (anyDays?.has(day) ?? false) : false;
    const copy = emptyDayCopy({
      status: st,
      artistName: specific,
      siteName: site.name,
      reason: monthKinds.get(day)?.reason ?? null,
      closedWeekday: closedWeekdays.has(weekdayKeyOf(day)),
      othersHaveTimes: anyHas,
    });
    if (!specific || st === "closed") return { ...copy, next };
    return {
      ...copy,
      next,
      alt: anyHas ? { label: "Reservar sin preferencia", action: { kind: "any" as const } } : { label: "Ver otros artistas", action: { kind: "artist" as const } },
    };
  })();

  const onEmptyAction = (a: EmptyAction) => {
    if (a.kind === "day") pickDay(a.day);
    else if (a.kind === "jump") jumpToDay(a.day);
    else if (a.kind === "nextMonth") changeMonth(1);
    else if (a.kind === "any") pickArtist("any");
    else goStep(2);
  };

  // ── Step 4 summary ──────────────────────────────────────────────────────────────

  const summaryRows: SummaryRow[] = [];
  if (service) summaryRows.push({ k: "Servicio", v: service.name, sub: durationMin ? `${durationMin} min` : null, edit: { label: "Editar servicio", step: 1 } });
  if (sel.artist)
    summaryRows.push({
      k: "Artista",
      v: artistName,
      sub: sel.artist === "any" ? "Te asignaremos un artista disponible" : null,
      edit: { label: "Editar artista", step: 2 },
    });
  if (slot && sel.day)
    summaryRows.push({
      k: "Fecha y hora",
      v: `${dayHeadline(siteDayKey(slot.start_at, tz))} · ${timeLabel}–${fmtTime(slot.service_end_at, tz, "24")}`,
      sub: `Hora de ${tzText}`,
      edit: { label: "Editar fecha y hora", step: 3 },
    });
  summaryRows.push({ k: "Sede", v: site.name, sub: site.address, edit: null });

  // ── Render ──────────────────────────────────────────────────────────────────────

  const monogram = (site.name.trim().charAt(0) || "?").toLocaleUpperCase("es");
  const waHello = whatsappLink(site.whatsapp ?? null, `Hola ${site.name}, quiero reservar.`);
  const stepAnim = stepDir === "fwd" ? "pb-step-fwd" : stepDir === "back" ? "pb-step-back" : "";

  const root = "pb3 relative -m-[var(--content-pad)] flex min-h-[calc(100%_+_var(--content-pad)_*_2)] flex-none flex-col";

  if (unavailable) {
    return (
      <div className={root}>
        <div className="mx-auto flex w-full max-w-[560px] flex-1 flex-col items-start justify-center gap-2 px-6 py-16">
          <h1 className={`${SERIF} m-0 text-[32px] leading-[1.08]`}>{UNAVAILABLE_TITLE}</h1>
          <p className="m-0 text-[15.5px] leading-[1.5] text-pb-muted">En este momento no es posible reservar en esta sede. Comunícate directamente con ella.</p>
        </div>
      </div>
    );
  }

  const brandMark = logoUrl ? (
    // eslint-disable-next-line @next/next/no-img-element -- the business's own uploaded logo (R2)
    <img src={logoUrl} alt="" className="size-11 flex-none rounded-full border border-pb-line object-cover" />
  ) : (
    <span aria-hidden className={`${SERIF} flex size-11 flex-none items-center justify-center rounded-full bg-pb-ink text-[22px] text-white`}>
      {monogram}
    </span>
  );

  return (
    <div className={root} ref={topRef}>
      <div className="flex-1">
        <div className="mx-auto w-full max-w-[640px] px-4 pb-5 pt-3 lg:flex lg:max-w-[1120px] lg:items-start lg:gap-7 lg:px-6 lg:pb-10 lg:pt-9">
          <main lang="es" className="flex min-w-0 flex-1 flex-col gap-5 lg:gap-[22px]">
            {!confirmation ? (
              <div className="flex flex-col gap-3.5">
                {/* ONE brand row at every width, inside the column: back (from step 2),
                    the business mark and name, and the step count. On the phone the back
                    button takes the mark's place to keep the row on one line. */}
                <div className="flex min-h-11 items-center gap-2.5">
                  {step > 1 ? (
                    <button
                      type="button"
                      aria-label="Volver al paso anterior"
                      onClick={() => goStep((step - 1) as Step)}
                      className="flex size-11 flex-none items-center justify-center rounded-full border border-pb-line2 bg-white p-0 text-pb-ink"
                    >
                      <IconBack />
                    </button>
                  ) : null}
                  <span className={step > 1 ? "hidden lg:block" : ""}>{brandMark}</span>
                  <div className="flex min-w-0 flex-col gap-px">
                    <span className={`${SERIF} truncate text-[19px] leading-[1.1] lg:text-[21px]`}>{site.name}</span>
                    {siteRating && step === 1 ? (
                      <span className="flex min-w-0 items-center">
                        <RatingButton
                          rating={siteRating}
                          label={site.name}
                          onOpen={(t) =>
                            openReviews({ title: `de ${site.name}`, scope: "Todas las citas de la sede.", rating: siteRating, reviews: siteReviews }, t)
                          }
                        />
                      </span>
                    ) : site.address ? (
                      <span className="truncate text-[12.5px] text-pb-muted lg:text-[13px]">{site.address}</span>
                    ) : null}
                  </div>
                  <span className="ml-auto flex flex-none items-center gap-2">
                    {waHello ? (
                      <a
                        href={waHello}
                        rel="noopener noreferrer"
                        aria-label={`Escribir a ${site.name} por WhatsApp`}
                        className="pb-press flex size-11 items-center justify-center rounded-full border border-pb-line2 bg-white text-pb-ink"
                      >
                        <IconWhatsApp />
                      </a>
                    ) : null}
                    <span className="text-[13px] text-pb-muted [font-variant-numeric:tabular-nums]">Paso {step} de 4</span>
                  </span>
                </div>
                <h1 ref={titleRef} tabIndex={-1} className={`${SERIF} m-0 mt-0.5 text-[32px] leading-[1.08] tracking-[-0.01em]`}>
                  {STEP_TITLES[step]}
                </h1>
                <nav aria-label="Pasos de la reserva">
                  <ol className="m-0 grid list-none grid-cols-4 gap-1.5 p-0">
                    {([1, 2, 3, 4] as const).map((n) => {
                      const cur = n === step;
                      const dis = n > reach;
                      return (
                        <li key={n} className="min-w-0">
                          <button
                            type="button"
                            disabled={dis}
                            aria-current={cur ? "step" : undefined}
                            onClick={() => goStep(n)}
                            className={`flex min-h-11 w-full flex-col items-start justify-center gap-1.5 bg-transparent p-0 text-left text-[13px] ${
                              cur ? "font-semibold text-pb-ink" : dis ? "cursor-default text-pb-faint" : "text-pb-tx2"
                            }`}
                          >
                            <span aria-hidden className="relative block h-[3px] w-full overflow-hidden rounded-[2px] bg-pb-bar">
                              <span
                                className="absolute inset-0 origin-left bg-pb-ink transition-transform duration-200 ease-out motion-reduce:transition-none"
                                style={{ transform: n <= step ? "scaleX(1)" : "scaleX(0)" }}
                              />
                            </span>
                            <span className="max-w-full truncate">
                              <span className="sr-only">Paso {n}: {STEP_LABELS[n]}</span>
                              {/* "Fecha y hora" does not fit a quarter of 360 px: a short visible label. */}
                              <span aria-hidden className={n === 3 ? "min-[400px]:hidden" : ""}>
                                {n === 3 ? "Fecha" : STEP_LABELS[n]}
                              </span>
                              {n === 3 ? (
                                <span aria-hidden className="hidden min-[400px]:inline">
                                  {STEP_LABELS[n]}
                                </span>
                              ) : null}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ol>
                </nav>
              </div>
            ) : null}

            {banner ? (
              <div role="alert" className="rounded-[12px] border border-pb-err-bd2 bg-pb-err-bg px-3.5 py-3 text-[14px] leading-[1.45] text-pb-err-fg">
                {banner}
              </div>
            ) : null}

            <div key={confirmation ? "done" : step} className={confirmation ? "pb-fade" : stepAnim}>
            {confirmation ? (
              <BookingDone confirmation={confirmation} firstName={form.name.trim().split(/\s+/)[0] || null} site={site} />
            ) : step === 1 ? (
              <div className="flex flex-col gap-6">
                <ServiceStep
                  services={services}
                  categories={categories}
                  selected={sel.serviceId}
                  onSelect={pickService}
                  onReserve={reserveService}
                  onOpenReviews={(s, t) =>
                    s.rating ? openReviews({ title: `de ${s.name}`, scope: "Solo citas de este servicio.", rating: s.rating, reviews: (s.reviews ?? []).slice(0, 3) }, t) : undefined
                  }
                  siteName={site.name}
                  whatsapp={site.whatsapp ?? null}
                  willRecheck={Boolean(sel.artist || sel.slotStart)}
                  promotions={promotions}
                />
                <BusinessInfo
                  siteName={site.name}
                  address={site.address}
                  hours={site.hours ?? []}
                  directionsUrl={site.directions_url ?? null}
                  whatsapp={site.whatsapp ?? null}
                  whatsappText={`Hola ${site.name}, quiero reservar.`}
                />
              </div>
            ) : step === 2 && service ? (
              <ArtistStep
                serviceName={service.name}
                staff={staffList}
                state={staffLoad[service.id] ?? "idle"}
                selected={sel.artist}
                notice={artistNotice}
                onPick={pickArtist}
                onView={(id, trigger) => setProfile({ id, trigger })}
                onRetry={() => void loadStaff(service.id, sel.artist, artist?.name ?? null, service.name)}
                onOpenReviews={(a, t) =>
                  a.rating ? openReviews({ title: `de ${a.name}`, scope: "Solo citas con este artista.", rating: a.rating, reviews: (a.reviews ?? []).slice(0, 3) }, t) : undefined
                }
              />
            ) : step === 3 && service ? (
              <DateTimeStep
                serviceLine={`${service.name} · ${durationMin ?? service.duration_min} min`}
                artistLine={artistName}
                onChangeService={() => goStep(1)}
                onChangeArtist={() => goStep(2)}
                notice={cleared && cleared !== "artist_gone" ? CLEARED_MESSAGE[cleared] : null}
                month={month}
                today={todayKey}
                selectedDay={sel.day}
                statusOf={statusOf}
                onPickDay={pickDay}
                canPrev={monthDiff(todayKey.slice(0, 7), month) > 0}
                canNext={`${shiftMonth(month, 1)}-01` <= lastDay}
                onPrev={() => changeMonth(-1)}
                onNext={() => changeMonth(1)}
                timezone={tz}
                timezoneText={tzText}
                slots={daySlots}
                selectedSlot={sel.slotStart}
                onPickSlot={pickSlot}
                loading={monthLoad === "loading" || monthLoad === "idle"}
                error={monthLoad === "error"}
                onRetry={() => void requestMonth(sel.serviceId, sel.artist, month, true)}
                empty={empty}
                onEmptyAction={onEmptyAction}
                monthDir={monthDir}
                autoPicked={autoDay !== null && autoDay === sel.day}
              />
            ) : step === 4 && service ? (
              <DetailsStep
                rows={summaryRows}
                priceLabel={priceText(priceNow, true)}
                priceSub={priceNow.from ? "El precio final depende del artista asignado." : null}
                priceChange={
                  priceChange
                    ? { previous: priceText({ label: priceLabelCOP(priceChange.previous), from: false }, true), current: priceText({ label: priceLabelCOP(priceChange.current), from: false }, true), accepted: priceChange.accepted }
                    : null
                }
                onAcceptPrice={() => setPriceChange((p) => (p ? { ...p, accepted: true } : p))}
                form={form}
                setField={setField}
                touch={touch}
                errors={errors}
                show={show}
                errorCount={errorCount}
                submitState={submit}
                takenTime={takenTime}
                onPickOtherTime={pickOtherTime}
                siteName={site.name}
                privacyPolicyUrl={privacyPolicyUrl}
                turnstileSiteKey={turnstileSiteKey}
                turnstileMisconfigured={turnstileMisconfigured}
                turnstileRef={turnstile}
                onTurnstile={setTurnstileToken}
                onSubmit={() => void confirm()}
                onFieldFocus={onFieldFocus}
                onEdit={(n) => goStep(n)}
              />
            ) : null}
            </div>

            <p className="m-0 mt-1.5 text-center text-[12.5px] text-pb-muted lg:mt-4 lg:text-left">Impulsado por M_AI</p>
          </main>

          {/* Desktop: the compact selection and the CTA, always in view. */}
          <aside
            aria-label="Tu selección"
            className="sticky top-7 hidden w-[340px] flex-none flex-col gap-3.5 rounded-[16px] border border-pb-line bg-white p-5 lg:flex"
          >
            <h2 className={`${SERIF} m-0 text-[23px]`}>Tu selección</h2>
            {service ? (
              <div className="flex flex-col">
                <MiniRow key={`s-${service.id}`} k="Servicio" v={`${service.name} · ${durationMin ?? service.duration_min} min`} />
                {sel.artist ? <MiniRow key={`a-${sel.artist}`} k="Artista" v={artistName} /> : null}
                {slot && sel.day ? <MiniRow key={`t-${slot.start_at}`} k="Fecha y hora" v={`${shortDay(sel.day)} · ${timeLabel}`} /> : null}
              </div>
            ) : (
              <p className="m-0 text-[14px] leading-[1.5] text-pb-muted">Elige un servicio para empezar.</p>
            )}
            {barPrice ? (
              <div className="flex items-baseline justify-between">
                <span className="text-[15px] font-[590]">Precio</span>
                <span key={barPrice} className="pb-fade text-[17px] font-semibold [font-variant-numeric:tabular-nums]">
                  {barPrice}
                </span>
              </div>
            ) : null}
            {barHint ? <span className="text-[13.5px] text-pb-muted">{barHint}</span> : null}
            <CtaButton label={ctaLabel} state={ctaState} disabled={ctaDisabled} onClick={onCta} arrow={false} full />
            {hint ? (
              <span role="status" className="text-center text-[13px] text-pb-warn-fg">
                {hint}
              </span>
            ) : null}
            {!confirmation && step === 4 ? <span className="text-center text-[13px] text-pb-muted">Nada se reserva hasta que confirmes.</span> : null}
          </aside>
        </div>
      </div>

      {/* Phone/tablet bottom bar: safe area + rides above the keyboard. `sticky` honours the
          shell scroller's padding, so it is offset by --content-pad to sit flush. */}
      <div
        className="sticky z-10 flex-none border-t border-pb-line bg-white px-4 pb-[calc(12px+env(safe-area-inset-bottom))] pt-3 [bottom:calc(-1*var(--content-pad))] lg:hidden"
        style={kbInset > 0 ? { transform: `translateY(-${kbInset}px)` } : undefined}
      >
        <div className="mx-auto flex max-w-[640px] flex-col gap-1.5">
          <div className="flex items-center gap-3.5">
            <div className="flex min-w-0 flex-1 flex-col gap-px" aria-live="polite">
              {barPrice ? (
                <>
                  <span key={barPrice} className="pb-fade text-[18px] font-semibold [font-variant-numeric:tabular-nums]">
                    {barPrice}
                  </span>
                  <span key={barSub} className="pb-fade truncate text-[13px] text-pb-muted">
                    {barSub}
                  </span>
                </>
              ) : null}
              {barHint ? <span className={`leading-[1.35] text-pb-muted ${barPrice ? "text-[13px]" : "text-[14px]"}`}>{barHint}</span> : null}
              {hint ? (
                <span role="status" className="sr-only">
                  {hint}
                </span>
              ) : null}
            </div>
            <CtaButton label={ctaLabel} state={ctaState} disabled={ctaDisabled} onClick={onCta} arrow={!confirmation && step < 4 && ctaState !== "sending"} />
          </div>
          {!confirmation && step === 4 ? <span className="text-center text-[12.5px] text-pb-muted">Nada se reserva hasta que confirmes.</span> : null}
        </div>
      </div>

      <ReviewsDialog target={reviews?.target ?? null} onClose={() => setReviews(null)} returnFocusTo={reviews?.trigger ?? null} />
      <ArtistProfile
        artist={profile ? staffList.find((s) => s.id === profile.id) ?? null : null}
        siteName={site.name}
        services={services}
        isChosen={Boolean(profile && sel.artist === profile.id)}
        onClose={() => setProfile(null)}
        onChoose={(id) => pickArtist(id)}
        returnFocusTo={profile?.trigger ?? null}
      />
    </div>
  );
}

function MiniRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="pb-fade flex flex-col gap-px border-b border-pb-hair py-[9px]">
      <span className="text-[12.5px] text-pb-muted">{k}</span>
      <span className="text-[15px] [font-variant-numeric:tabular-nums]">{v}</span>
    </div>
  );
}

function CtaButton({
  label,
  state,
  disabled,
  onClick,
  arrow,
  full,
}: {
  label: string;
  state: "on" | "muted" | "sending" | "outline";
  disabled: boolean;
  onClick: () => void;
  arrow: boolean;
  full?: boolean;
}) {
  return (
    <button
      type="button"
      aria-disabled={disabled || undefined}
      aria-busy={state === "sending" || undefined}
      onClick={onClick}
      className={`${CTA_BASE} ${ctaTone(state)} ${full ? "w-full" : "flex-none"}`}
    >
      {state === "sending" ? <Spinner /> : null}
      {label}
      {arrow ? <IconArrow /> : null}
    </button>
  );
}

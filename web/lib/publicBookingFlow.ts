/**
 * PUBLIC BOOKING FLOW (v3) — the decisions the four-step page makes, as pure functions so
 * they are unit-tested apart from the UI (test/unit/publicBookingFlow.test.ts).
 *
 * Nothing here computes AVAILABILITY or a PRICE that is charged: availability comes from
 * the public endpoints (the same engine as staff and n8n) and the price that counts is
 * the server's snapshot on the appointment. These helpers only decide what to SHOW and
 * what a change invalidates.
 */

import { priceLabelCOP } from "./money";
import { addDays, siteHour, weekdayKeyOf, type DayKey } from "./siteCalendar";

export type Step = 1 | 2 | 3 | 4;
/** null = not chosen yet; "any" = "Sin preferencia" (the engine assigns at confirmation). */
export type ArtistChoice = null | "any" | string;

export const STEP_TITLES: Record<Step, string> = {
  1: "Elige tu experiencia",
  2: "Elige a tu artista",
  3: "Elige fecha y hora",
  4: "Tus datos",
};
export const STEP_LABELS: Record<Step, string> = { 1: "Experiencia", 2: "Artista", 3: "Fecha y hora", 4: "Datos" };

/** The furthest step the visitor may open: each step needs the previous choices. */
export function reachableStep(s: { serviceId: string | null; artist: ArtistChoice; slotStart: string | null }): Step {
  if (!s.serviceId) return 1;
  if (!s.artist) return 2;
  if (!s.slotStart) return 3;
  return 4;
}

// ── Calendar ─────────────────────────────────────────────────────────────────────

/**
 *  past     — before today (not selectable)
 *  out      — after the site's booking horizon (not selectable)
 *  closed   — the SITE does not open: its weekday hours, or a site-wide closure that day
 *  loading  — availability for the month is still on its way
 *  open     — at least one free time ("Hay cupos")
 *  away     — the chosen ARTIST is not working that day (the site may well be open)
 *  full     — people work, but no free time holds this service
 *  unknown  — availability could not be loaded (the times panel offers a retry)
 *
 * `closed` / `away` / `full` come from the server's day status (publicAvailability.ts),
 * which reads the engine's own inputs; without it the page falls back to weekday hours
 * and "full".
 */
export type DayStatus = "past" | "out" | "closed" | "loading" | "open" | "away" | "full" | "unknown";

/** The server's public day kinds (web/lib/publicAvailability.ts). */
export type ServerDayKind = "open" | "site_closed" | "artist_unavailable" | "no_slots";

export function lastBookableDay(today: DayKey, horizonDays: number): DayKey {
  return addDays(today, Math.max(0, horizonDays));
}

export function dayStatusOf(
  day: DayKey,
  ctx: {
    today: DayKey;
    lastDay: DayKey;
    closedWeekdays: ReadonlySet<string>;
    load: "idle" | "loading" | "loaded" | "error";
    openDays: ReadonlySet<DayKey>;
    /** The server's per-day kinds for THIS service and artist choice, when known. */
    kinds?: ReadonlyMap<DayKey, ServerDayKind>;
  },
): DayStatus {
  if (day < ctx.today) return "past";
  if (day > ctx.lastDay) return "out";
  if (ctx.closedWeekdays.has(weekdayKeyOf(day))) return "closed";
  if (ctx.load === "idle" || ctx.load === "loading") return "loading";
  if (ctx.load === "error") return "unknown";
  if (ctx.openDays.has(day)) return "open";
  const k = ctx.kinds?.get(day);
  return k === "site_closed" ? "closed" : k === "artist_unavailable" ? "away" : "full";
}

export const DAY_STATUS_SPOKEN: Record<DayStatus, string> = {
  past: "no disponible",
  out: "fuera del periodo de reservas",
  closed: "cerrado",
  loading: "cargando disponibilidad",
  open: "hay cupos",
  away: "el artista no atiende",
  full: "sin cupos",
  unknown: "disponibilidad no cargada",
};

export function isSelectableDay(status: DayStatus): boolean {
  return status !== "past" && status !== "out";
}

// ── Times ────────────────────────────────────────────────────────────────────────

export interface SlotLike {
  start_at: string;
}

export type DayPeriod = "Mañana" | "Tarde" | "Noche";

/** Morning (before 12:00), afternoon (12:00–17:59) and evening (from 18:00), in the SITE's
 *  clock; empty groups dropped. Every slot lands in exactly one group — none is hidden. */
export function groupSlots<T extends SlotLike>(slots: T[], timeZone: string): Array<{ name: DayPeriod; items: T[] }> {
  const at = (s: T) => siteHour(s.start_at, timeZone);
  return [
    { name: "Mañana" as const, items: slots.filter((s) => at(s) < 12) },
    { name: "Tarde" as const, items: slots.filter((s) => at(s) >= 12 && at(s) < 18) },
    { name: "Noche" as const, items: slots.filter((s) => at(s) >= 18) },
  ].filter((g) => g.items.length > 0);
}

/**
 * What an empty day SAYS — the three cases are never confused: the site is closed, THIS
 * artist does not work that day, or no time is left for the service. A block's reason is
 * used only when it is a published one ("vacation"); otherwise the wording is neutral.
 */
export function emptyDayCopy(input: {
  status: Exclude<DayStatus, "open" | "loading" | "unknown">;
  /** null = "Sin preferencia". */
  artistName: string | null;
  siteName: string;
  /** The server's published reason for the day, if any. */
  reason?: "vacation" | "unavailable" | "site_closed" | null;
  closedWeekday: boolean;
  /** Another artist has real times that same day (checked with the engine). */
  othersHaveTimes: boolean;
}): { title: string; text: string } {
  const { status, artistName: who } = input;
  if (status === "past" || status === "out") return { title: "Este día no se puede reservar", text: "" };
  if (status === "closed") {
    return input.closedWeekday
      ? { title: `${input.siteName} no abre este día`, text: "La sede no atiende ese día de la semana. Elige otro día." }
      : { title: "La sede está cerrada este día", text: "Elige otro día." };
  }
  if (status === "away" && who) {
    const title = input.reason === "vacation" ? `${who} está de vacaciones en esa fecha` : `${who} no tiene disponibilidad este día`;
    return {
      title,
      text: input.othersHaveTimes ? "Otro artista sí tiene horarios ese día. Puedes reservar sin preferencia o cambiar de día." : "Prueba con otro día o con otro artista.",
    };
  }
  if (who) {
    return {
      title: "No quedan horarios para este servicio este día",
      text: input.othersHaveTimes ? `${who} ya no tiene horarios libres ese día, pero otro artista sí. Puedes reservar sin preferencia o cambiar de día.` : `${who} ya no tiene horarios libres ese día. Prueba con otro día o con otro artista.`,
    };
  }
  return { title: "No quedan horarios para este servicio este día", text: "Prueba con otro día." };
}

// ── Invalidation ─────────────────────────────────────────────────────────────────

export type ClearedReason = "svc" | "art" | "taken" | "gone" | "artist_gone";

export const CLEARED_MESSAGE: Record<Exclude<ClearedReason, "artist_gone">, string> = {
  svc: "Cambiaste el servicio, así que quitamos la hora que tenías. Elige una nueva.",
  art: "Cambiaste de artista, así que quitamos la hora que tenías. Elige una nueva.",
  taken: "Esa hora se acaba de ocupar. Elige otra; tus datos siguen guardados.",
  gone: "La hora que habías elegido ya no está disponible. Elige otra; tus datos siguen guardados.",
};

/**
 * After availability is reloaded (back to the date step, another month, a retry): the
 * chosen time survives only if the engine STILL offers it for the current artist choice.
 * Otherwise it is dropped — never kept as a selection the server would refuse.
 */
export function revalidateSlot(
  sel: Selection,
  loaded: { month: string; slots: ReadonlyArray<{ start_at: string; available_staff_ids: string[] }> },
  dayOf: (iso: string) => DayKey,
): { sel: Selection; cleared: ClearedReason | null } {
  if (!sel.slotStart || !dayOf(sel.slotStart).startsWith(loaded.month)) return { sel, cleared: null };
  const who = sel.artist && sel.artist !== "any" ? sel.artist : null;
  const still = loaded.slots.some((s) => s.start_at === sel.slotStart && (!who || s.available_staff_ids.includes(who)));
  return still ? { sel, cleared: null } : { sel: { ...sel, slotStart: null }, cleared: "gone" };
}

export interface Selection {
  serviceId: string | null;
  artist: ArtistChoice;
  day: DayKey | null;
  slotStart: string | null;
}

/** Choosing a (different) service keeps the artist and the day, drops the time. */
export function onServiceChange(sel: Selection, serviceId: string): { sel: Selection; cleared: ClearedReason | null } {
  if (sel.serviceId === serviceId) return { sel, cleared: null };
  return { sel: { ...sel, serviceId, slotStart: null }, cleared: sel.slotStart ? "svc" : null };
}

/** Choosing a (different) artist keeps the service and the day, drops the time. */
export function onArtistChange(sel: Selection, artist: Exclude<ArtistChoice, null>): { sel: Selection; cleared: ClearedReason | null } {
  if (sel.artist === artist) return { sel, cleared: null };
  return { sel: { ...sel, artist, slotStart: null }, cleared: sel.slotStart ? "art" : null };
}

/**
 * Once the professionals of the (new) service are known: an artist who does not perform
 * it is dropped (with the time), so the visitor never books someone the server refuses.
 */
export function reconcileArtist(sel: Selection, eligibleIds: readonly string[]): { sel: Selection; dropped: boolean } {
  if (!sel.artist || sel.artist === "any" || eligibleIds.includes(sel.artist)) return { sel, dropped: false };
  return { sel: { ...sel, artist: null, slotStart: null }, dropped: true };
}

// ── Contact form ─────────────────────────────────────────────────────────────────

export const COUNTRY_CODES = [
  { code: "+57", label: "CO +57", nationalLength: 10 },
  { code: "+1", label: "US +1", nationalLength: 10 },
  { code: "+52", label: "MX +52", nationalLength: 10 },
  { code: "+34", label: "ES +34", nationalLength: 9 },
] as const;

export interface ContactDraft {
  name: string;
  cc: string;
  phone: string;
  email: string;
  consent: boolean;
}

export interface ContactErrors {
  name: string;
  phone: string;
  email: string;
  consent: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function contactErrors(f: ContactDraft, siteName: string): ContactErrors {
  const digits = f.phone.replace(/\D/g, "");
  const country = COUNTRY_CODES.find((c) => c.code === f.cc) ?? COUNTRY_CODES[0];
  const typedInternational = f.phone.trim().startsWith("+");
  let phone = "";
  if (!digits) phone = "Escribe tu celular para poder contactarte sobre la cita.";
  else if (typedInternational) phone = digits.length < 8 || digits.length > 15 ? "Revisa el número: parece incompleto." : "";
  else if (country.code === "+57" && (digits.length !== 10 || digits[0] !== "3")) phone = "Revisa el número: un celular de Colombia tiene 10 dígitos y empieza por 3.";
  else if (digits.length !== country.nationalLength) phone = `Revisa el número: debe tener ${country.nationalLength} dígitos.`;
  return {
    name: f.name.trim().length < 2 ? `Escribe tu nombre para que ${siteName} sepa a quién espera.` : "",
    phone,
    email: f.email.trim() && !EMAIL_RE.test(f.email.trim()) ? "Revisa el email; debe verse como nombre@correo.com." : "",
    consent: f.consent ? "" : "Para confirmar, acepta el tratamiento de tus datos.",
  };
}

/** The number the server receives. The server still normalizes it (site region aware). */
export function fullPhone(f: Pick<ContactDraft, "cc" | "phone">): string {
  const t = f.phone.trim();
  return t.startsWith("+") ? t : `${f.cc} ${t.replace(/\D/g, "")}`;
}

// ── Price shown (the charged price is the server's snapshot) ────────────────────

export function priceShown(input: {
  servicePrice: string | null;
  artist: ArtistChoice;
  staff: ReadonlyArray<{ id: string; price: string | null }>;
}): { label: string | null; from: boolean } {
  const chosen = input.artist && input.artist !== "any" ? input.staff.find((s) => s.id === input.artist) : null;
  if (chosen) return { label: priceLabelCOP(chosen.price), from: false };
  const prices = input.staff.map((s) => s.price).filter((p): p is string => p != null).map(Number).filter(Number.isFinite);
  if (input.artist === "any" && prices.length > 1 && new Set(prices).size > 1) {
    return { label: priceLabelCOP(Math.min(...prices)), from: true };
  }
  return { label: priceLabelCOP(input.servicePrice), from: false };
}

/**
 * The EXACT price the visitor is being shown, for the server's price guard (the booking
 * POST's `expected_price`): the chosen artist's price, or — for "Sin preferencia" — the
 * one price every available artist shares. `undefined` when the page shows a range
 * ("Desde …") or the artists are not loaded: then nothing is compared. The server still
 * decides the price; this only lets it refuse a silent change.
 */
export function expectedPriceOf(input: { artist: ArtistChoice; staff: ReadonlyArray<{ id: string; price: string | null }> }): string | null | undefined {
  const chosen = input.artist && input.artist !== "any" ? input.staff.find((s) => s.id === input.artist) : null;
  if (chosen) return chosen.price;
  if (input.artist !== "any" || input.staff.length === 0) return undefined;
  const distinct = new Set(input.staff.map((s) => (s.price == null ? "none" : String(Number(s.price)))));
  return distinct.size === 1 ? input.staff[0].price : undefined;
}

export function priceText(p: { label: string | null; from: boolean }, withCurrency = false): string {
  if (!p.label) return "Precio a consultar";
  return `${p.from ? "Desde " : ""}${p.label}${withCurrency ? " COP" : ""}`;
}

// ── Artists ──────────────────────────────────────────────────────────────────────

/** "Federico" → "Fe"; "Ana Ruiz" → "AR". */
export function artistInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) {
    const w = words[0];
    return (w.charAt(0).toLocaleUpperCase("es") + (w.charAt(1) ?? "").toLocaleLowerCase("es")).trim();
  }
  return (words[0].charAt(0) + words[1].charAt(0)).toLocaleUpperCase("es");
}

/** A discreet pastel per professional, stable by id (decoration only). */
const ARTIST_TONES = ["#EAF0FB", "#F0ECF9", "#E2EADF", "#F3E2DD", "#E8F1F7"] as const;
export function artistTone(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return ARTIST_TONES[h % ARTIST_TONES.length];
}

/** A service description long enough to need "Ver más" in a two-line card. */
export function needsMore(description: string | null | undefined): boolean {
  const d = (description ?? "").trim();
  return d.length > 90 || d.includes("\n");
}

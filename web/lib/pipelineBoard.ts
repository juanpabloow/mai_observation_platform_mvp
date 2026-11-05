import type { BoardOpportunityRow, LostReason, OpportunityStage, OpportunityStatus } from "@worker/db/repositories/pipeline.js";

export type { LostReason, OpportunityStage, OpportunityStatus };
import { originColumnAdName, originColumnChip, originColumnDetail } from "./originDisplay";
import { displayContactName, isMeaningfulName, maskPhone } from "./contactName";
import { dayShort, fmtTime, siteDayKey, todayAtSite } from "./siteCalendar";
import { relativeAgeShort } from "./format";

/**
 * JP-7 STALE thresholds — a calm "this has waited too long" state, never error red. Reported here
 * so they're one place to tune. A sale is stale when:
 *   - Lead:       the CUSTOMER spoke last and it has been > 15 min with no reply;
 *   - Calificado: it has sat qualified > 24 h without a booking;
 *   - Reservó:    its appointment has already passed and it was never completed.
 */
export const STALE_LEAD_MINUTES = 15;
export const STALE_QUALIFIED_HOURS = 24;

/**
 * PURE view-model for the sales pipeline board (PL-2). No React, no I/O — so the column order,
 * grouping and card shape are unit-testable and the board + queue can't drift from the origin
 * vocabulary (it reuses originColumnChip/originColumnDetail, the same words the contacts Origen
 * column and the inbox chip use).
 */

/** The board columns, in funnel order. (JP-6: `paid` is a real column now that payments ship.) */
export const BOARD_STAGES: Array<{ key: OpportunityStage; label: string; disabled?: boolean }> = [
  { key: "lead", label: "Lead" },
  { key: "qualified", label: "Calificado" },
  { key: "booked", label: "Reservó" },
  { key: "attended", label: "Asistió" },
  { key: "paid", label: "Pagó" },
];

export const STAGE_LABEL: Record<OpportunityStage, string> = {
  lead: "Lead",
  qualified: "Calificado",
  booked: "Reservó",
  attended: "Asistió",
  paid: "Pagó",
};

export const STATUS_LABEL: Record<OpportunityStatus, string> = { open: "Abierta", won: "Ganada", lost: "Perdida" };

export const LOST_REASON_LABEL: Record<LostReason, string> = {
  precio: "Precio",
  horario: "Horario",
  no_respondio: "No respondió",
  no_asistio: "No asistió",
  otro: "Otro",
};
export const LOST_REASONS: LostReason[] = ["precio", "horario", "no_respondio", "no_asistio", "otro"];

/** A serializable board card (the server builds these; the client component renders them). */
export interface BoardCard {
  id: string;
  contactId: string;
  conversationId: string | null;
  stage: OpportunityStage;
  status: OpportunityStatus;
  name: string;
  originChip: { label: string; tone: string };
  originDetail: string | null;
  /** Just the ad name (no campaign) — the card's one-line origin shows "Anuncio · <adName>". */
  adName: string | null;
  isTestAd: boolean;
  stageSince: string | null;
  lastMessageAt: string | null;
  /** 'business' | 'customer' | null — who sent the conversation's last message. */
  spokeLast: "business" | "customer" | null;
  lostReason: LostReason | null;
  lostNote: string | null;
  /** JP-6 (paid cards only, and only for a viewer with payments.view): the recorded amount and the
   *  method label. `paidMethod` is null when more than one payment backs the sale. Never commission. */
  paidAmount: string | null;
  paidMethod: string | null;
  // ── JP-7 "the next thing to know" ──
  /** Lead: a one-line preview of the customer's last message. */
  lastMessageText: string | null;
  /** Calificado: the qualification evidence + who qualified it ("Bot" / a person's name / null). */
  qualService: string | null;
  qualTimeframe: string | null;
  qualifiedBy: string | null;
  /** Reservó / Asistió: the sale's appointment (ISO, status, its site tz, and the list price). */
  apptStartAt: string | null;
  apptStatus: string | null;
  apptTz: string | null;
  /** The appointment's list price — only for a viewer with payments.view (same gate as paidAmount). */
  apptListAmount: string | null;
  /** The contact's assigned owner, when one is set (for the avatar/initials). */
  owner: { userId: string; name: string | null } | null;
  /** A calm "waited too long" state with a short reason, or null. */
  stale: { reason: string } | null;
  // ── JP-9 ──
  /** The contact avatar glyph: initials for a real name, "#" for a masked-phone contact, "?" for a
   *  nameless one. */
  avatar: string;
  /** True when the display name is the neutral "Sin nombre" (render it muted + italic). */
  nameMuted: boolean;
  /** The sale's appointment: id (Confirmar/Cobrar target), service name, and the artist's name. */
  apptId: string | null;
  apptService: string | null;
  apptStaffName: string | null;
  /** Whether the sale has ANY recorded payment — UNGATED (drives "unpaid" urgency regardless of the
   *  viewer's payments.view; the amount itself stays gated via paidAmount/apptListAmount). */
  hasPayment: boolean;
}

/** "Bot" for the assistant, a person's first name for a user, null for system/implicit/none. */
function qualifiedByLabel(raw: string | null, name: string | null): string | null {
  if (raw === "bot") return "Bot";
  if (name && name.trim()) return name.trim().split(/\s+/)[0];
  return null;
}

/** The calm stale state for a card, or null. `nowMs` is the clock it is compared against. */
function computeStale(row: BoardOpportunityRow, nowMs: number): { reason: string } | null {
  const since = (d: Date | null) => (d ? nowMs - d.getTime() : null);
  if (row.stage === "lead" && row.last_sender === "user") {
    const age = since(row.last_message_at);
    if (age !== null && age > STALE_LEAD_MINUTES * 60_000) return { reason: `El cliente escribió hace más de ${STALE_LEAD_MINUTES} min y sigue sin respuesta.` };
  }
  if (row.stage === "qualified") {
    const age = since(row.stage_since);
    if (age !== null && age > STALE_QUALIFIED_HOURS * 3_600_000) return { reason: `Calificada hace más de ${STALE_QUALIFIED_HOURS} h sin reservar.` };
  }
  if (row.stage === "booked" && row.appt_start_at && (row.appt_status === "scheduled" || row.appt_status === "confirmed")) {
    if (row.appt_start_at.getTime() < nowMs) return { reason: "La cita ya pasó y no se marcó asistencia." };
  }
  return null;
}

export function whoSpokeLast(sender: string | null): "business" | "customer" | null {
  if (sender === "user") return "customer";
  if (sender === "bot" || sender === "human_agent") return "business";
  return null;
}

/** `showAmounts` is the viewer's payments.view — when false, a card shows no money. `nowMs` is the
 *  clock the stale thresholds are measured against (the server passes its clock at render). */
/** The avatar glyph for a contact: initials from a real name (skipping leading symbols), "#" for a
 *  masked-phone contact, "?" for a nameless one. */
export function contactAvatar(name: string | null, phoneE164: string | null, channelUserId: string | null): { avatar: string; nameMuted: boolean } {
  if (isMeaningfulName(name)) {
    const words = name!.trim().split(/\s+/).map((w) => w.match(/[\p{L}\p{N}]/u)?.[0] ?? "").filter(Boolean);
    const initials = (words[0] ?? "") + (words.length > 1 ? words[words.length - 1] : "");
    return { avatar: (initials || "·").toLocaleUpperCase("es").slice(0, 2), nameMuted: false };
  }
  if (maskPhone(phoneE164) ?? maskPhone(channelUserId)) return { avatar: "#", nameMuted: false };
  return { avatar: "?", nameMuted: true };
}

export function toBoardCard(row: BoardOpportunityRow, showAmounts = true, nowMs = Date.now()): BoardCard {
  const originSource = {
    originKind: row.origin_kind,
    adName: row.ad_name,
    adHeadline: row.ad_headline,
    adIsTest: row.ad_is_test,
    campaignName: row.campaign_name,
  };
  const av = contactAvatar(row.contact_name, row.contact_phone_e164, row.contact_channel_user_id);
  return {
    id: row.id,
    contactId: row.contact_id,
    conversationId: row.conversation_id,
    stage: row.stage,
    status: row.status,
    name: displayContactName({ name: row.contact_name, phoneE164: row.contact_phone_e164, channelUserId: row.contact_channel_user_id }),
    originChip: originColumnChip(row.origin_kind),
    originDetail: originColumnDetail(originSource),
    adName: originColumnAdName(originSource),
    isTestAd: row.ad_is_test === true,
    stageSince: row.stage_since ? row.stage_since.toISOString() : null,
    lastMessageAt: row.last_message_at ? row.last_message_at.toISOString() : null,
    spokeLast: whoSpokeLast(row.last_sender),
    lostReason: row.lost_reason,
    lostNote: row.lost_note,
    paidAmount: showAmounts ? row.paid_total : null,
    paidMethod: showAmounts ? row.paid_method : null,
    lastMessageText: row.last_message_text,
    qualService: row.qualification_service,
    qualTimeframe: row.qualification_timeframe,
    qualifiedBy: qualifiedByLabel(row.qualified_by, row.qualified_by_name),
    apptStartAt: row.appt_start_at ? row.appt_start_at.toISOString() : null,
    apptStatus: row.appt_status,
    apptTz: row.appt_tz,
    apptListAmount: showAmounts ? row.appt_list_price : null,
    owner: row.owner_user_id ? { userId: row.owner_user_id, name: row.owner_name } : null,
    stale: computeStale(row, nowMs),
    avatar: av.avatar,
    nameMuted: av.nameMuted,
    apptId: row.appt_id,
    apptService: row.appt_service,
    apptStaffName: row.appt_staff_name,
    hasPayment: row.paid_total != null,
  };
}

// ── JP-7 card-line + aggregate helpers (pure; unit-tested) ──────────────────────────────────

/** The Calificado evidence line: "Corte con barba · el sábado", with a trailing "· Bot/Ana". */
export function qualificationLineOf(card: BoardCard): string | null {
  const svc = card.qualService?.trim();
  const when = card.qualTimeframe?.trim();
  const base = svc && when ? `${svc} · ${when}` : svc || when || null;
  if (!base) return null;
  return card.qualifiedBy ? `${base} · ${card.qualifiedBy}` : base;
}

/** The Reservó/Asistió appointment line: "Hoy · 2:30 p. m. · Confirmada" / "Sáb 31 oct · …". */
export function apptLineOf(card: BoardCard): string | null {
  if (!card.apptStartAt || !card.apptTz) return null;
  const tz = card.apptTz;
  const day = siteDayKey(card.apptStartAt, tz);
  const today = todayAtSite(tz);
  const dayLabel = day === today ? "Hoy" : day === nextDay(today) ? "Mañana" : dayShort(day);
  const time = fmtTime(card.apptStartAt, tz, "12");
  const state = card.apptStatus === "confirmed" ? " · Confirmada" : card.apptStatus === "scheduled" ? " · Sin confirmar" : "";
  return `${dayLabel} · ${time}${state}`;
}
function nextDay(dayKey: string): string {
  const [y, m, d] = dayKey.split("-").map(Number);
  const n = new Date(Date.UTC(y, m - 1, d + 1));
  return `${n.getUTCFullYear()}-${String(n.getUTCMonth() + 1).padStart(2, "0")}-${String(n.getUTCDate()).padStart(2, "0")}`;
}

/** JP-9 Reservó/Asistió line: "Hoy · 11:30 · Corte" / "Mañana · 10:30 · Corte" / "sáb 8 nov · 17:00 ·
 *  Corte" — day · 24h time · service name. (The status is a SEPARATE line, see the card.) */
export function apptWhenLine(card: BoardCard, now: Date = new Date()): string | null {
  if (!card.apptStartAt || !card.apptTz) return null;
  const tz = card.apptTz;
  const day = siteDayKey(card.apptStartAt, tz);
  const today = todayAtSite(tz, now);
  const dayLabel = day === today ? "Hoy" : day === nextDay(today) ? "Mañana" : dayShort(day);
  const time = fmtTime(card.apptStartAt, tz, "24");
  const service = card.apptService?.trim() || "Cita";
  return `${dayLabel} · ${time} · ${service}`;
}

/** Whether the sale's appointment is TODAY at its site (drives the Reservó "sin confirmar" urgency). */
export function apptIsToday(card: BoardCard, now: Date = new Date()): boolean {
  if (!card.apptStartAt || !card.apptTz) return false;
  return siteDayKey(card.apptStartAt, card.apptTz) === todayAtSite(card.apptTz, now);
}

/** "Hoy" / "Mañana" / "sáb 8 nov" for the sale's appointment day (future-oriented, for Reservó). */
export function apptDayLabel(card: BoardCard, now: Date = new Date()): string | null {
  if (!card.apptStartAt || !card.apptTz) return null;
  const day = siteDayKey(card.apptStartAt, card.apptTz);
  const today = todayAtSite(card.apptTz, now);
  return day === today ? "Hoy" : day === nextDay(today) ? "Mañana" : dayShort(day);
}

/** "hoy" / "ayer" / "23 oct" for a PAST appointment day (for the Asistió line). */
export function apptDatePhrase(card: BoardCard, now: Date = new Date()): string | null {
  if (!card.apptStartAt || !card.apptTz) return null;
  const day = siteDayKey(card.apptStartAt, card.apptTz);
  const today = todayAtSite(card.apptTz, now);
  if (day === today) return "hoy";
  if (nextDay(day) === today) return "ayer";
  const [, m, d] = day.split("-").map(Number);
  return `${d} ${MES_ABBR[m - 1]}`;
}

/** "hace 28 m" → "28 m" (drop the "hace" for inline "· 28 m" lines). Reuses the app's single
 *  relative-age helper so the wording stays identical everywhere. */
export function agoShort(from: string | Date, now: Date = new Date()): string {
  return relativeAgeShort(from, now).replace(/^hace /, "");
}
/** "hace 28 m" → "28m" (compact, for the card's top-right time). */
export function agoCompact(from: string | Date, now: Date = new Date()): string {
  return agoShort(from, now).replace(/\s+/g, "");
}

/** JP-9 "Recordar": the reminder MESSAGE pre-typed into the Inbox composer (never auto-sent). */
export function reminderText(card: BoardCard, now: Date = new Date()): string {
  const greeting = card.nameMuted ? "Hola" : `Hola ${card.name}`;
  const service = (card.apptService?.trim() || "cita").toLocaleLowerCase("es");
  const day = (apptDayLabel(card, now) ?? "").toLocaleLowerCase("es");
  const time = card.apptStartAt && card.apptTz ? fmtTime(card.apptStartAt, card.apptTz, "24") : "";
  const withStaff = card.apptStaffName ? ` con ${card.apptStaffName}` : "";
  return `${greeting}, te recordamos tu cita de ${service} ${day} a las ${time}${withStaff}.`;
}

export type UrgencyKind = "lead_waiting" | "reservo_today_unconfirmed" | "asistio_overdue" | null;

/** JP-9 urgency (one meaning per colour): a customer waiting on a Lead, a Reservó appointment TODAY
 *  not yet confirmed, or an Asistió sale unpaid for MORE than a day. Only these are "urgent". */
export function cardUrgency(card: BoardCard, now: Date = new Date()): UrgencyKind {
  const nowMs = now.getTime();
  if (card.stage === "lead" && card.spokeLast === "customer") return "lead_waiting";
  if (card.stage === "booked" && apptIsToday(card, now) && card.apptStatus !== "confirmed") return "reservo_today_unconfirmed";
  if (card.stage === "attended" && !card.hasPayment) {
    const since = card.stageSince ? nowMs - new Date(card.stageSince).getTime() : 0;
    if (since > 86_400_000) return "asistio_overdue";
  }
  return null;
}

export interface StageTotals {
  /** Reservó: expected list value (SUM of the upcoming appointment list prices). */
  bookedExpected: number;
  /** Asistió: pending to collect (SUM of the attended appointment list prices). */
  attendedPending: number;
  /** Pagó: collected (SUM of recorded payment totals). */
  paidCollected: number;
}

/** Per-stage money, summed from the loaded cards. The CALLER decides whether to expose it (revenue
 *  roles only) — a Setter's payload must never carry these. Cards without payments.view have null
 *  amounts, so this returns 0 for them (the caller gates earlier anyway). */
export function stageTotals(cards: BoardCard[]): StageTotals {
  const num = (s: string | null) => (s ? Number(s) : 0);
  let bookedExpected = 0, attendedPending = 0, paidCollected = 0;
  for (const c of cards) {
    if (c.stage === "booked") bookedExpected += num(c.apptListAmount);
    else if (c.stage === "attended") attendedPending += num(c.apptListAmount);
    else if (c.stage === "paid") paidCollected += num(c.paidAmount);
  }
  return { bookedExpected, attendedPending, paidCollected };
}

export interface FunnelStep {
  stage: OpportunityStage;
  label: string;
  count: number;
  /** Conversion from the previous step (0–100), null for the first step. */
  convPct: number | null;
}

/** Lead → … → Pagó with each count and the conversion % from the previous step. */
export function funnelSteps(cards: BoardCard[]): FunnelStep[] {
  const by = groupByStage(cards);
  const order: OpportunityStage[] = ["lead", "qualified", "booked", "attended", "paid"];
  let prev: number | null = null;
  return order.map((stage) => {
    const count = by[stage].length;
    const convPct = prev !== null && prev > 0 ? Math.round((count / prev) * 100) : null;
    prev = count;
    return { stage, label: STAGE_LABEL[stage], count, convPct };
  });
}

// ── JP-7b §1: the COHORT funnel (one group of leads followed over time) ──────────────────────

/**
 * How recent a cohort can be before its conversions are still "settling" — leads opened within this
 * many days can still advance, so the percentages will rise. Any period whose end reaches into this
 * window is marked "En curso". One place to tune; reported in the JP-7b notes.
 */
export const COHORT_SETTLING_DAYS = 14;

const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const MES_ABBR = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;
const iso = (d: Date) => d.toISOString();
const utcMidnight = (y: number, m0: number, d: number) => new Date(Date.UTC(y, m0, d));
const pad2 = (n: number) => String(n).padStart(2, "0");
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const monthKey = (y: number, m0: number) => `${y}-${pad2(m0 + 1)}`;

/**
 * JP-9: the cohort period is a CALENDAR MONTH ("2026-10") or a CUSTOM day range ("custom" + ff/ft).
 * Default = the last CLOSED month. A period reaching the last COHORT_SETTLING_DAYS is "en curso".
 */
export interface CohortPeriod {
  /** 'YYYY-MM' for a month, or 'custom'. */
  key: string;
  fromIso: string;
  toIso: string;
  /** "Leads de octubre" / "Leads del 15 oct al 10 nov". */
  label: string;
  /** The period reaches into the last COHORT_SETTLING_DAYS → its %s can still rise. */
  inProgress: boolean;
  /** Echoed back for the custom date inputs (YYYY-MM-DD) or "". */
  customFrom: string;
  customTo: string;
}

/** PURE period math (testable): a month key / custom range + the clock → the cohort window + label. */
export function cohortPeriodRange(key: string, now: Date, customFrom?: string, customTo?: string): CohortPeriod {
  const nowMs = now.getTime();
  let from: Date;
  let to: Date;
  let label: string;
  let resolvedKey = key;
  let cf = "";
  let ct = "";
  if (key === "custom" && customFrom && customTo && DAY_RE.test(customFrom) && DAY_RE.test(customTo) && customFrom <= customTo) {
    const [fy, fm, fd] = customFrom.split("-").map(Number);
    const [ty, tm, td] = customTo.split("-").map(Number);
    from = utcMidnight(fy, fm - 1, fd);
    to = utcMidnight(ty, tm - 1, td + 1); // inclusive end day
    label = `Leads del ${fd} ${MES_ABBR[fm - 1]} al ${td} ${MES_ABBR[tm - 1]}`;
    cf = customFrom;
    ct = customTo;
  } else if (MONTH_RE.test(key)) {
    const [y, m] = key.split("-").map(Number);
    from = utcMidnight(y, m - 1, 1);
    to = utcMidnight(y, m, 1);
    label = `Leads de ${MESES[m - 1]}`;
  } else {
    // Default: the last CLOSED calendar month.
    const y = now.getUTCFullYear();
    const m0 = now.getUTCMonth();
    from = utcMidnight(y, m0 - 1, 1);
    to = utcMidnight(y, m0, 1);
    resolvedKey = monthKey(from.getUTCFullYear(), from.getUTCMonth());
    label = `Leads de ${MESES[from.getUTCMonth()]}`;
  }
  const inProgress = to.getTime() > nowMs - COHORT_SETTLING_DAYS * 86_400_000;
  return { key: resolvedKey, fromIso: iso(from), toIso: iso(to), label, inProgress, customFrom: cf, customTo: ct };
}

/** Resolve the cohort period from URL params (reads the clock here, so the page/component body does
 *  not — keeps the react-compiler "no impure call in render" rule satisfied). */
export function resolveCohortPeriod(keyParam: string | undefined, customFrom?: string, customTo?: string): CohortPeriod {
  return cohortPeriodRange(keyParam ?? "", new Date(), customFrom, customTo);
}

export interface CohortMonthOption {
  key: string; // 'YYYY-MM'
  label: string; // "Noviembre (en curso)" / "Octubre"
  inProgress: boolean;
}

/** The month menu for the cohort selector: the current month (marked "en curso") back to the first
 *  month with data — never stopping short of the last closed month — most recent first, capped. */
export function cohortMonths(earliest: Date | null, now: Date): CohortMonthOption[] {
  const curY = now.getUTCFullYear();
  const curM0 = now.getUTCMonth();
  const floor = utcMidnight(curY, curM0 - 1, 1); // last month — always offered (it is the default)
  const floorKey = monthKey(floor.getUTCFullYear(), floor.getUTCMonth());
  const earliestKey = earliest ? monthKey(earliest.getUTCFullYear(), earliest.getUTCMonth()) : floorKey;
  const stopKey = earliestKey < floorKey ? earliestKey : floorKey;
  const out: CohortMonthOption[] = [];
  let y = curY;
  let m0 = curM0;
  for (let i = 0; i < 48; i++) {
    const key = monthKey(y, m0);
    const isCurrent = y === curY && m0 === curM0;
    out.push({ key, label: cap(MESES[m0]) + (isCurrent ? " (en curso)" : ""), inProgress: isCurrent });
    if (key <= stopKey) break;
    m0 -= 1;
    if (m0 < 0) {
      m0 = 11;
      y -= 1;
    }
  }
  return out;
}

export interface CohortRaw {
  cohort: number;
  reached_qualified: number;
  reached_booked: number;
  reached_attended: number;
  reached_paid: number;
  lost: number;
  lost_precio: number;
  lost_horario: number;
  lost_no_respondio: number;
  lost_no_asistio: number;
  lost_otro: number;
}

export interface CohortStep {
  stage: OpportunityStage;
  label: string;
  /** How many of the cohort reached this stage (monotonic, ≤ cohort). */
  reached: number;
  /** Conversion from the previous step (0–100, never above 100), null for the first. */
  convPct: number | null;
}

/** The cohort funnel steps: monotonic reached-counts + conversion from the previous step. */
export function cohortFunnelSteps(raw: CohortRaw): CohortStep[] {
  const reached: Record<OpportunityStage, number> = {
    lead: raw.cohort,
    qualified: raw.reached_qualified,
    booked: raw.reached_booked,
    attended: raw.reached_attended,
    paid: raw.reached_paid,
  };
  const order: OpportunityStage[] = ["lead", "qualified", "booked", "attended", "paid"];
  let prev: number | null = null;
  return order.map((stage) => {
    const r = reached[stage];
    const convPct = prev !== null && prev > 0 ? Math.min(100, Math.round((r / prev) * 100)) : null;
    prev = r;
    return { stage, label: STAGE_LABEL[stage], reached: r, convPct };
  });
}

/** The cohort's most common loss reason (for "N perdidas · sobre todo <motivo>"), or null. */
export function cohortTopLoss(raw: CohortRaw): { reason: LostReason; count: number } | null {
  const all: Array<{ reason: LostReason; count: number }> = [
    { reason: "precio", count: raw.lost_precio },
    { reason: "horario", count: raw.lost_horario },
    { reason: "no_respondio", count: raw.lost_no_respondio },
    { reason: "no_asistio", count: raw.lost_no_asistio },
    { reason: "otro", count: raw.lost_otro },
  ];
  const byReason = all.filter((x) => x.count > 0);
  if (byReason.length === 0) return null;
  byReason.sort((a, b) => b.count - a.count || LOST_REASONS.indexOf(a.reason) - LOST_REASONS.indexOf(b.reason));
  return byReason[0];
}

/** Lost opportunities grouped by reason (for the Perdidos header filter). */
export function lossReasonCounts(lostCards: BoardCard[]): Array<{ reason: LostReason; count: number }> {
  const counts = new Map<LostReason, number>();
  for (const c of lostCards) if (c.lostReason) counts.set(c.lostReason, (counts.get(c.lostReason) ?? 0) + 1);
  return LOST_REASONS.filter((r) => counts.has(r)).map((reason) => ({ reason, count: counts.get(reason)! }));
}

/** Up to two initials for an owner avatar, from the owner's name (else "?"). */
export function ownerInitials(name: string | null): string {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  return (words[0][0] + (words.length > 1 ? words[words.length - 1][0] : "")).toLocaleUpperCase("es");
}

/** Group cards by stage (every stage key present, even when empty), preserving input order. */
export function groupByStage(cards: BoardCard[]): Record<OpportunityStage, BoardCard[]> {
  const out: Record<OpportunityStage, BoardCard[]> = { lead: [], qualified: [], booked: [], attended: [], paid: [] };
  for (const c of cards) out[c.stage].push(c);
  return out;
}

/**
 * The card's ONE-LINE origin: the chip label, plus " · <ad name>" for ads (the campaign is dropped
 * — it is already a board filter and lives in the tooltip). "Orgánico" / "Página de reservas" /
 * "Desconocido" / "Asignado manualmente" show just the label. Reuses the origin vocabulary so the
 * words match the contacts column and the inbox chip.
 */
export function originLineOf(card: BoardCard): string {
  return card.adName ? `${card.originChip.label} · ${card.adName}` : card.originChip.label;
}

/** The fuller origin for the card's tooltip (includes the campaign via originDetail). */
export function originTitleOf(card: BoardCard): string {
  return card.originDetail ? `${card.originChip.label} · ${card.originDetail}` : card.originChip.label;
}

/** The "who spoke last" line: Cliente (needs a reply → emphasized) vs Negocio; null when unknown. */
export function spokeLastDisplay(spokeLast: BoardCard["spokeLast"]): { label: string; emphasize: boolean } | null {
  if (spokeLast === "customer") return { label: "Cliente", emphasize: true };
  if (spokeLast === "business") return { label: "Negocio", emphasize: false };
  return null;
}

/**
 * Within a column, MOST RECENT ACTIVITY first: the conversation's last message, falling back to
 * when the opportunity entered its current stage; ties broken by id so renders are stable. (ISO
 * timestamp strings compare lexicographically, so no Date parsing is needed.)
 */
export function sortByActivityDesc(cards: BoardCard[]): BoardCard[] {
  const activity = (c: BoardCard) => c.lastMessageAt ?? c.stageSince ?? "";
  return [...cards].sort((a, b) => {
    const av = activity(a);
    const bv = activity(b);
    if (av !== bv) return av < bv ? 1 : -1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** JP-9 within-column order: URGENT cards first, then most-recent activity. */
export function sortBoardColumn(cards: BoardCard[], now: Date = new Date()): BoardCard[] {
  const byActivity = sortByActivityDesc(cards);
  const urgent = byActivity.filter((c) => cardUrgency(c, now) !== null);
  const rest = byActivity.filter((c) => cardUrgency(c, now) === null);
  return [...urgent, ...rest];
}

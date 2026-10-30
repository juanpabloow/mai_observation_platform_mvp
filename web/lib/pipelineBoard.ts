import type { BoardOpportunityRow, LostReason, OpportunityStage, OpportunityStatus } from "@worker/db/repositories/pipeline.js";
import { originColumnAdName, originColumnChip, originColumnDetail } from "./originDisplay";
import { displayContactName } from "./contactName";
import { dayShort, fmtTime, siteDayKey, todayAtSite } from "./siteCalendar";

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
export function toBoardCard(row: BoardOpportunityRow, showAmounts = true, nowMs = Date.now()): BoardCard {
  const originSource = {
    originKind: row.origin_kind,
    adName: row.ad_name,
    adHeadline: row.ad_headline,
    adIsTest: row.ad_is_test,
    campaignName: row.campaign_name,
  };
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

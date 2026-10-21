import type { BoardOpportunityRow, LostReason, OpportunityStage, OpportunityStatus } from "@worker/db/repositories/pipeline.js";
import { originColumnAdName, originColumnChip, originColumnDetail } from "./originDisplay";
import { displayContactName } from "./contactName";

/**
 * PURE view-model for the sales pipeline board (PL-2). No React, no I/O — so the column order,
 * grouping and card shape are unit-testable and the board + queue can't drift from the origin
 * vocabulary (it reuses originColumnChip/originColumnDetail, the same words the contacts Origen
 * column and the inbox chip use).
 */

/** The board columns, in funnel order. `paid` is shown DISABLED until the payments phase exists. */
export const BOARD_STAGES: Array<{ key: OpportunityStage; label: string; disabled?: boolean }> = [
  { key: "lead", label: "Lead" },
  { key: "qualified", label: "Calificado" },
  { key: "booked", label: "Reservó" },
  { key: "attended", label: "Asistió" },
  { key: "paid", label: "Pagó", disabled: true },
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
}

export function whoSpokeLast(sender: string | null): "business" | "customer" | null {
  if (sender === "user") return "customer";
  if (sender === "bot" || sender === "human_agent") return "business";
  return null;
}

export function toBoardCard(row: BoardOpportunityRow): BoardCard {
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
  };
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

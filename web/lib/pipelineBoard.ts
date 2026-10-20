import type { BoardOpportunityRow, LostReason, OpportunityStage, OpportunityStatus } from "@worker/db/repositories/pipeline.js";
import { originColumnChip, originColumnDetail } from "./originDisplay";

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

/** A contact's display label — name, else its channel identifier, else a neutral fallback. */
export function contactLabel(name: string | null, channelUserId: string | null): string {
  return (name && name.trim()) || (channelUserId && channelUserId.trim()) || "Contacto sin nombre";
}

export function toBoardCard(row: BoardOpportunityRow): BoardCard {
  return {
    id: row.id,
    contactId: row.contact_id,
    conversationId: row.conversation_id,
    stage: row.stage,
    status: row.status,
    name: contactLabel(row.contact_name, row.contact_channel_user_id),
    originChip: originColumnChip(row.origin_kind),
    originDetail: originColumnDetail({
      originKind: row.origin_kind,
      adName: row.ad_name,
      adHeadline: row.ad_headline,
      adIsTest: row.ad_is_test,
      campaignName: row.campaign_name,
    }),
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

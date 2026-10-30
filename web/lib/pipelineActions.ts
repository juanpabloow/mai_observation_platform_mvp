"use server";

import { revalidatePath } from "next/cache";
import { can, NO_PERMISSION, requireFullAccessForAction } from "./access";
import { resolveClientModuleContext } from "./clientModuleAccess";
import { getClientForTenant } from "./clientWorkflow";
import { isUuid } from "./clientModuleValidation";
import {
  markOpportunityLost,
  qualifyOpportunity,
  reopenOpportunity,
  unqualifyOpportunity,
  type PipelineActor,
} from "@worker/pipeline/engine.js";
import {
  getOpportunityById,
  getOpportunityPaymentSummary,
  getPipelineSettings,
  listOpportunityAppointments,
  listOpportunityStageEvents,
  setPipelineSettings,
  type LostReason,
  type OpportunityStage,
  type OpportunityStatus,
} from "@worker/db/repositories/pipeline.js";
import { listMessages, type MessageSender } from "@worker/db/repositories/handoff.js";
import { listMembersForTenant } from "@worker/db/repositories/tenantMembers.js";

/**
 * SALES PIPELINE actions (PL-2). Every mutation goes through PL-1's engine functions (which lock
 * the row and write the stage event) — no UI-only state, no parallel rules. The actor is the
 * current user, recorded on every transition.
 *
 * Permissions: working the pipeline (qualify / unqualify / mark lost / reopen) is the agency's,
 * the client OWNER's and the SETTER's job — `canReadCampaigns` (= canAccessClient: staff refused),
 * under the client's CRM module. Pipeline SETTINGS are AGENCY ONLY (requireFullAccessForAction).
 */

export type PipelineResult = { ok: true } | { ok: false; error: string };

const UNAVAILABLE = "El pipeline no está disponible para este cliente.";
const NOT_FOUND = "Oportunidad no encontrada.";
const LOST_REASONS: LostReason[] = ["precio", "horario", "no_respondio", "no_asistio", "otro"];

async function requirePipelineActor(
  clientId: string,
): Promise<{ ok: true; tenantId: string; actor: PipelineActor } | { ok: false; error: string }> {
  const res = await resolveClientModuleContext(clientId, "crm", "pipeline.edit");
  if (!res.ok) return { ok: false, error: res.forbidden ? NO_PERMISSION : UNAVAILABLE };
  return { ok: true, tenantId: res.context.scope.tenantId, actor: { kind: "user", userId: res.context.scope.userId } };
}

function revalidatePipeline(clientId: string): void {
  revalidatePath(`/clients/${clientId}/pipeline`);
  revalidatePath(`/clients/${clientId}/contacts`);
}

/** Qualify a lead — service + timeframe (the evidence) are REQUIRED; the message link is optional. */
export async function qualifyOpportunityAction(
  clientId: string,
  opportunityId: string,
  input: { service: string; timeframe: string; messageId?: string | null },
): Promise<PipelineResult> {
  const auth = await requirePipelineActor(clientId);
  if (!auth.ok) return auth;
  if (!isUuid(opportunityId)) return { ok: false, error: NOT_FOUND };
  const service = (input.service ?? "").trim();
  const timeframe = (input.timeframe ?? "").trim();
  if (!service || !timeframe) return { ok: false, error: "Calificar requiere el servicio y el plazo (la evidencia)." };
  const messageId = input.messageId && isUuid(input.messageId) ? input.messageId : null;
  const r = await qualifyOpportunity(auth.tenantId, clientId, opportunityId, { service: service.slice(0, 200), timeframe: timeframe.slice(0, 200), messageId }, auth.actor);
  if (!r) return { ok: false, error: NOT_FOUND };
  if (r.stage !== "qualified") return { ok: false, error: "Solo se puede calificar una oportunidad en Lead." };
  revalidatePipeline(clientId);
  return { ok: true };
}

/** Undo a qualification (qualified → lead), with an optional note recorded on the event. */
export async function unqualifyOpportunityAction(
  clientId: string,
  opportunityId: string,
  input: { note?: string | null } = {},
): Promise<PipelineResult> {
  const auth = await requirePipelineActor(clientId);
  if (!auth.ok) return auth;
  if (!isUuid(opportunityId)) return { ok: false, error: NOT_FOUND };
  const note = ((input.note ?? "").trim() || null)?.slice(0, 1000) ?? null;
  const r = await unqualifyOpportunity(auth.tenantId, clientId, opportunityId, auth.actor, note);
  if (!r) return { ok: false, error: NOT_FOUND };
  if (r.stage !== "lead") return { ok: false, error: "Solo se puede quitar la calificación de una oportunidad Calificada." };
  revalidatePipeline(clientId);
  return { ok: true };
}

/** Mark an open sale lost. Reason is a closed set; the note is REQUIRED for 'otro'. */
export async function markOpportunityLostAction(
  clientId: string,
  opportunityId: string,
  input: { reason: string; note?: string | null },
): Promise<PipelineResult> {
  const auth = await requirePipelineActor(clientId);
  if (!auth.ok) return auth;
  if (!isUuid(opportunityId)) return { ok: false, error: NOT_FOUND };
  if (!LOST_REASONS.includes(input.reason as LostReason)) return { ok: false, error: "Motivo inválido." };
  const reason = input.reason as LostReason;
  const note = (input.note ?? "").trim().slice(0, 1000) || null;
  if (reason === "otro" && !note) return { ok: false, error: "El motivo «Otro» requiere una nota." };
  try {
    const r = await markOpportunityLost(auth.tenantId, clientId, opportunityId, reason, note, auth.actor);
    if (!r) return { ok: false, error: NOT_FOUND };
    if (r.status !== "lost") return { ok: false, error: "Solo se puede marcar perdida una oportunidad abierta." };
    revalidatePipeline(clientId);
    return { ok: true };
  } catch {
    return { ok: false, error: "No se pudo marcar como perdida." };
  }
}

/** Reopen a lost sale — ONLY within the reopen window; outside it, say why. */
export async function reopenOpportunityAction(clientId: string, opportunityId: string): Promise<PipelineResult> {
  const auth = await requirePipelineActor(clientId);
  if (!auth.ok) return auth;
  if (!isUuid(opportunityId)) return { ok: false, error: NOT_FOUND };
  const opp = await getOpportunityById(auth.tenantId, clientId, opportunityId);
  if (!opp) return { ok: false, error: NOT_FOUND };
  if (opp.status !== "lost") return { ok: false, error: "Solo se puede reabrir una oportunidad perdida." };
  const settings = await getPipelineSettings(auth.tenantId, clientId);
  const closedMs = opp.closed_at ? opp.closed_at.getTime() : null;
  if (closedMs === null || Date.now() - closedMs > settings.reopen_window_days * 86_400_000) {
    return {
      ok: false,
      error: `Fuera de la ventana de reapertura (${settings.reopen_window_days} días). Una nueva conversación o reserva abrirá una oportunidad nueva.`,
    };
  }
  const r = await reopenOpportunity(auth.tenantId, clientId, opportunityId, auth.actor);
  if (!r) return { ok: false, error: "No se pudo reabrir." };
  revalidatePipeline(clientId);
  return { ok: true };
}

/** PL-2 §7 — pipeline settings. AGENCY ONLY. Bounds mirror the DB CHECKs (hours 1..2160, days 0..365). */
export async function setPipelineSettingsAction(
  clientId: string,
  input: { autoLostAfterHours?: number; reopenWindowDays?: number },
): Promise<PipelineResult> {
  const { tenantId } = await requireFullAccessForAction();
  const client = await getClientForTenant(clientId);
  if (!client || client.is_default) return { ok: false, error: "Unknown client." };
  const patch: { auto_lost_after_hours?: number; reopen_window_days?: number } = {};
  if (input.autoLostAfterHours !== undefined) {
    const h = Math.trunc(Number(input.autoLostAfterHours));
    if (!Number.isFinite(h) || h < 1 || h > 2160) return { ok: false, error: "Auto-perder debe estar entre 1 y 2160 horas." };
    patch.auto_lost_after_hours = h;
  }
  if (input.reopenWindowDays !== undefined) {
    const d = Math.trunc(Number(input.reopenWindowDays));
    if (!Number.isFinite(d) || d < 0 || d > 365) return { ok: false, error: "La ventana de reapertura debe estar entre 0 y 365 días." };
    patch.reopen_window_days = d;
  }
  await setPipelineSettings(tenantId, clientId, patch);
  revalidatePath(`/clients/${clientId}/campaigns/settings`);
  return { ok: true };
}

// ── JP-7 §4 — the opportunity DRAWER read ───────────────────────────────────────────

/** One stage transition, with the actor resolved to a human label (who did it, in plain words). */
export type DrawerEvent = {
  id: string;
  fromStage: OpportunityStage | null;
  toStage: OpportunityStage | null;
  fromStatus: OpportunityStatus | null;
  toStatus: OpportunityStatus | null;
  reason: string | null;
  actorLabel: string;
  at: string;
};

export type DrawerData = {
  id: string;
  stage: OpportunityStage;
  status: OpportunityStatus;
  conversationId: string | null;
  contactId: string;
  /** ISO timestamps for each stage this sale has reached (null = not reached). */
  stages: { lead: string | null; qualified: string | null; booked: string | null; attended: string | null; paid: string | null };
  qualification: { service: string | null; timeframe: string | null; byLabel: string | null; implicit: boolean } | null;
  lost: { reason: LostReason; note: string | null; atLabel: string | null } | null;
  reopenWindowDays: number;
  appointments: Array<{ id: string; startAt: string; status: string; service: string }>;
  /** Null when the viewer lacks payments.view, OR when no payment is recorded. */
  payment: { total: string; method: string | null } | null;
  /** The last few messages, oldest → newest (ready to render top-to-bottom). */
  messages: Array<{ id: string; sender: MessageSender; text: string | null; at: string }>;
  history: DrawerEvent[];
};

export type DrawerResult = { ok: true; data: DrawerData } | { ok: false; error: string };

/**
 * Load everything the drawer shows for one opportunity, in a handful of batched reads (no N+1): the
 * opportunity, its stage history, its appointments, its recorded payment (gated by payments.view),
 * and the conversation's last few messages. Gate = `pipeline.view` under the client's CRM module —
 * the same audience as the board. The actor on every transition is resolved to a member name.
 */
export async function loadOpportunityDrawerAction(clientId: string, opportunityId: string): Promise<DrawerResult> {
  const res = await resolveClientModuleContext(clientId, "crm", "pipeline.view");
  if (!res.ok) return { ok: false, error: res.forbidden ? NO_PERMISSION : UNAVAILABLE };
  const { scope } = res.context;
  if (!isUuid(opportunityId)) return { ok: false, error: NOT_FOUND };

  const opp = await getOpportunityById(scope.tenantId, clientId, opportunityId);
  if (!opp) return { ok: false, error: NOT_FOUND };

  const canSeeMoney = can(scope, "payments.view", clientId);
  const [events, appts, members, payment, messages, settings] = await Promise.all([
    listOpportunityStageEvents(scope.tenantId, opportunityId),
    listOpportunityAppointments(scope.tenantId, opportunityId),
    listMembersForTenant(scope.tenantId),
    canSeeMoney ? getOpportunityPaymentSummary(scope.tenantId, opportunityId) : Promise.resolve(null),
    opp.conversation_id ? listMessages(scope.tenantId, opp.conversation_id, { limit: 6 }) : Promise.resolve([]),
    getPipelineSettings(scope.tenantId, clientId),
  ]);

  // Resolve an actor token ('system' | 'bot' | a user id) to a human label.
  const nameById = new Map(members.map((m) => [m.user_id, m.name ?? m.email]));
  const actorLabel = (token: string | null): string => {
    if (!token) return "—";
    if (token === "system") return "Sistema";
    if (token === "bot") return "Bot";
    return nameById.get(token) ?? "Usuario";
  };

  return {
    ok: true,
    data: {
      id: opp.id,
      stage: opp.stage,
      status: opp.status,
      conversationId: opp.conversation_id,
      contactId: opp.contact_id,
      stages: {
        lead: opp.lead_at?.toISOString() ?? null,
        qualified: opp.qualified_at?.toISOString() ?? null,
        booked: opp.booked_at?.toISOString() ?? null,
        attended: opp.attended_at?.toISOString() ?? null,
        paid: opp.paid_at?.toISOString() ?? null,
      },
      qualification:
        opp.qualification_service || opp.qualification_timeframe
          ? {
              service: opp.qualification_service,
              timeframe: opp.qualification_timeframe,
              byLabel: opp.qualified_by ? actorLabel(opp.qualified_by) : null,
              implicit: opp.qualified_implicitly,
            }
          : null,
      lost: opp.status === "lost" && opp.lost_reason ? { reason: opp.lost_reason, note: opp.lost_note, atLabel: opp.closed_at?.toISOString() ?? null } : null,
      reopenWindowDays: settings.reopen_window_days,
      appointments: appts.map((a) => ({ id: a.id, startAt: a.start_at.toISOString(), status: a.status, service: a.service_name_snapshot })),
      payment,
      // Oldest → newest for top-to-bottom reading; listMessages returns newest first.
      messages: [...messages].reverse().map((m) => ({ id: m.id, sender: m.sender, text: m.text, at: m.occurred_at.toISOString() })),
      history: events.map((e) => ({
        id: e.id,
        fromStage: e.from_stage,
        toStage: e.to_stage,
        fromStatus: e.from_status,
        toStatus: e.to_status,
        reason: e.reason,
        actorLabel: actorLabel(e.actor),
        at: e.occurred_at.toISOString(),
      })),
    },
  };
}

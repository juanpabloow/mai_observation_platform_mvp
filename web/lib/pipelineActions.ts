"use server";

import { revalidatePath } from "next/cache";
import { NO_PERMISSION, requireFullAccessForAction } from "./access";
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
import { getOpportunityById, getPipelineSettings, setPipelineSettings, type LostReason } from "@worker/db/repositories/pipeline.js";

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

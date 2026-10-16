"use server";

import { revalidatePath } from "next/cache";
import { canManageClient } from "./access";
import { resolveClientModuleContext } from "./clientModuleAccess";
import { isUuid } from "./clientModuleValidation";
import { moderateReview } from "@worker/db/repositories/scheduling/reviews.js";
import { createExternalReviewRequest } from "@worker/db/repositories/scheduling/externalReviews.js";

/**
 * REVIEW MODERATION — the business decides what its booking page shows. Same gate as
 * every scheduling admin action: the module context (tenant + client of the route,
 * non-default, scheduling ON) AND canManageClient (the client's owner or the agency).
 * The repository then only touches a SUBMITTED review of THAT client.
 */
export type ModerationResult = { ok: true } | { ok: false; error: string };

export async function moderateReviewAction(clientId: string, reviewId: string, decision: "approved" | "hidden"): Promise<ModerationResult> {
  if (!isUuid(reviewId) || (decision !== "approved" && decision !== "hidden")) return { ok: false, error: "No disponible." };
  const res = await resolveClientModuleContext(clientId, "scheduling");
  if (!res.ok || !canManageClient(res.context.scope, clientId)) return { ok: false, error: "No disponible." };
  const done = await moderateReview(res.context.scope.tenantId, res.context.client.id, reviewId, decision, res.context.scope.userId);
  if (!done) return { ok: false, error: "Esta reseña ya no está disponible." };
  revalidatePath(`/clients/${res.context.client.id}/scheduling/reviews`);
  return { ok: true };
}

/**
 * An IMPORTED review is not the business's to publish, hide or edit — it can only ASK a
 * platform administrator to review it or withdraw it. Same gate as the moderation above;
 * the repository only accepts a Fresha review of THIS client and one open request per kind.
 */
export async function requestExternalReviewAction(clientId: string, reviewId: string, kind: "review" | "withdraw", note: string): Promise<ModerationResult> {
  if (!isUuid(reviewId) || (kind !== "review" && kind !== "withdraw")) return { ok: false, error: "No disponible." };
  const res = await resolveClientModuleContext(clientId, "scheduling");
  if (!res.ok || !canManageClient(res.context.scope, clientId)) return { ok: false, error: "No disponible." };
  const text = note.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "").trim().slice(0, 500) || null;
  const r = await createExternalReviewRequest({ tenantId: res.context.scope.tenantId, clientId: res.context.client.id, reviewId, kind, note: text, actor: res.context.scope.userId });
  if (!r.ok) return { ok: false, error: r.error === "already_open" ? "Ya hay una solicitud abierta para esta reseña." : "Esta reseña ya no está disponible." };
  revalidatePath(`/clients/${res.context.client.id}/scheduling/reviews`);
  return { ok: true };
}

"use server";

import { revalidatePath } from "next/cache";
import { canManageClient } from "./access";
import { resolveClientModuleContext } from "./clientModuleAccess";
import { isUuid } from "./clientModuleValidation";
import { moderateReview } from "@worker/db/repositories/scheduling/reviews.js";

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

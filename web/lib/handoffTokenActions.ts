"use server";

import { revalidatePath } from "next/cache";
import { requireFullAccessForAction } from "./access";
import { issueToken, revokeToken } from "@worker/db/repositories/handoffTokens.js";

/**
 * Handoff-token server actions. OWNER/ADMIN ONLY — requireFullAccessForAction()
 * throws for a member, so the gate is at the DATA LAYER (a member is denied here,
 * not merely hidden in the UI). Tenant id comes from the session scope, never the
 * client. issueTokenAction returns the RAW token exactly once for the show-once
 * modal; it is never persisted or logged.
 */
export async function issueTokenAction(
  connectionId: string,
): Promise<{ ok: true; rawToken: string; prefix: string } | { ok: false; error: string }> {
  const { tenantId } = await requireFullAccessForAction();
  try {
    const { row, rawToken } = await issueToken(tenantId, connectionId);
    revalidatePath("/settings/connections");
    return { ok: true, rawToken, prefix: row.token_prefix };
  } catch {
    // issueToken throws when the connection isn't this tenant's — surface a generic
    // message (don't distinguish "not found" from "not yours").
    return { ok: false, error: "Could not issue a token for that connection." };
  }
}

export async function revokeTokenAction(
  tokenId: string,
): Promise<{ ok: boolean; error?: string }> {
  const { tenantId } = await requireFullAccessForAction();
  const revoked = await revokeToken(tenantId, tokenId);
  revalidatePath("/settings/connections");
  // revoked=false means it was already revoked or not this tenant's — treat both as
  // "nothing to do" rather than an error the user must act on.
  return { ok: revoked };
}

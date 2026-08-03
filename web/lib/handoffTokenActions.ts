"use server";

import { revalidatePath } from "next/cache";
import { requireFullAccessForAction } from "./access";
import {
  issueToken,
  revokeToken,
  updateTokenCapabilities,
  isCapability,
  type Capability,
} from "@worker/db/repositories/handoffTokens.js";
import { logger } from "@worker/logger.js";

/**
 * Machine-token server actions (C-5). OWNER/ADMIN ONLY — requireFullAccessForAction()
 * throws for a member, so the gate is at the DATA LAYER (a member is denied here, not
 * merely hidden in the UI). Tenant id comes from the session scope, never the client.
 * issueTokenAction returns the RAW token exactly once for the show-once modal; it is
 * never persisted or logged. Capabilities are validated against the vocabulary here.
 */

/** Keep only real, de-duped capability strings — never trust the browser's shape. */
function sanitize(capabilities: string[]): Capability[] {
  return [...new Set(capabilities.filter(isCapability))];
}

export async function issueTokenAction(
  connectionId: string,
  capabilities: string[],
): Promise<{ ok: true; rawToken: string; prefix: string } | { ok: false; error: string }> {
  const { tenantId, userId } = await requireFullAccessForAction();
  const caps = sanitize(capabilities);
  if (caps.length === 0) return { ok: false, error: "Pick at least one capability for the token." };
  try {
    const { row, rawToken } = await issueToken(tenantId, connectionId, caps);
    logger.info({ tenantId, actor: userId, tokenId: row.id, capabilities: caps }, "machine token issued");
    revalidatePath("/settings/connections");
    return { ok: true, rawToken, prefix: row.token_prefix };
  } catch {
    // issueToken throws when the connection isn't this tenant's — surface a generic
    // message (don't distinguish "not found" from "not yours").
    return { ok: false, error: "Could not issue a token for that connection." };
  }
}

/** Edit an existing token's capabilities WITHOUT re-issuing the secret. Narrowing takes
 *  effect on the next request (no cached authority). The change is logged. */
export async function updateTokenCapabilitiesAction(
  tokenId: string,
  capabilities: string[],
): Promise<{ ok: boolean; error?: string }> {
  const { tenantId, userId } = await requireFullAccessForAction();
  const caps = sanitize(capabilities);
  if (caps.length === 0) return { ok: false, error: "A token must keep at least one capability." };
  const row = await updateTokenCapabilities(tenantId, tokenId, caps);
  if (!row) return { ok: false, error: "Could not update that token." };
  logger.info({ tenantId, actor: userId, tokenId, capabilities: caps }, "machine token capabilities updated");
  revalidatePath("/settings/connections");
  return { ok: true };
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

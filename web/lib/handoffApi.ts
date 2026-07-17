import "server-only";
import {
  findActiveByHash,
  hashHandoffToken,
  touchLastUsed,
} from "@worker/db/repositories/handoffTokens.js";
import { workflowBelongsToConnection } from "@worker/db/repositories/workflows.js";
import { getAgentSummary, type ConversationRow } from "@worker/db/repositories/handoff.js";

/**
 * Shared auth + scoping + response helpers for the internet-reachable handoff API
 * (app/api/handoff/v1/*). These routes are MACHINE-only: Bearer token, no session,
 * no cookies, no CORS — completely separate from Better Auth.
 */

export interface HandoffAuth {
  tenantId: string;
  connectionId: string;
  tokenId: string;
}

/** The one error-body shape for every handoff route: { error: { code, message } }. */
export function handoffError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

// A SINGLE 401 body for every auth failure (missing / malformed / unknown /
// revoked) — never reveal which, so probes learn nothing.
const unauthorized = (): Response =>
  handoffError(401, "unauthorized", "Invalid or missing credentials.");

// A SINGLE 404 body for every workflow-scope miss (wrong tenant / wrong connection
// / unknown ref) — never reveal which.
const workflowNotFound = (): Response => handoffError(404, "not_found", "Workflow not found.");

export type AuthResult = { ok: true; auth: HandoffAuth } | { ok: false; response: Response };

/**
 * THE auth chokepoint for the handoff API. Parses "Authorization: Bearer <token>",
 * hashes it (SHA-256), and resolves an ACTIVE (non-revoked) token → its tenant /
 * connection / token ids. Every failure returns the SAME 401 (no distinguishing
 * detail). touchLastUsed runs fire-and-forget on success. Structured so a rate
 * limiter can wrap it later without touching the routes.
 */
export async function authenticateHandoffRequest(req: Request): Promise<AuthResult> {
  const header = (req.headers.get("authorization") ?? "").trim();
  const match = /^Bearer\s+(.+)$/i.exec(header);
  const raw = match?.[1]?.trim();
  if (!raw) return { ok: false, response: unauthorized() };

  const token = await findActiveByHash(hashHandoffToken(raw));
  if (!token) return { ok: false, response: unauthorized() };

  void touchLastUsed(token.id); // fire-and-forget best-effort telemetry
  return {
    ok: true,
    auth: { tenantId: token.tenant_id, connectionId: token.n8n_connection_id, tokenId: token.id },
  };
}

export type ScopeResult = { ok: true } | { ok: false; response: Response };

/**
 * Scope a workflow_ref to the token's connection + tenant (the synced workflows
 * table). The token authorizes ONLY workflows under its own connection — a wrong
 * tenant, wrong connection, or unknown ref all return the SAME 404.
 */
export async function resolveWorkflowOr404(
  auth: HandoffAuth,
  workflowRef: string,
): Promise<ScopeResult> {
  const belongs = await workflowBelongsToConnection(auth.tenantId, auth.connectionId, workflowRef);
  return belongs ? { ok: true } : { ok: false, response: workflowNotFound() };
}

/** The contract's conversation projection: { id, mode, assigned_agent:{id,name}|null }. */
export async function formatConversation(conv: ConversationRow): Promise<{
  id: string;
  mode: ConversationRow["mode"];
  assigned_agent: { id: string; name: string | null } | null;
}> {
  const assigned_agent = conv.assigned_agent_user_id
    ? await getAgentSummary(conv.assigned_agent_user_id)
    : null;
  return { id: conv.id, mode: conv.mode, assigned_agent };
}

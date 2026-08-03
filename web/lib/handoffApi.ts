import "server-only";
import {
  findActiveByHash,
  hashHandoffToken,
  tokenHasCapability,
  touchLastUsed,
  type Capability,
} from "@worker/db/repositories/handoffTokens.js";
import { resolveWorkflowForConnection } from "@worker/db/repositories/workflows.js";
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
 * THE capability-aware auth chokepoint for EVERY machine route (handoff directly;
 * scheduling + CRM via their wrappers, which pass their capability through). Parses
 * "Authorization: Bearer <token>", hashes it (SHA-256), resolves an ACTIVE (non-revoked)
 * token, then checks the route's REQUIRED capability — declared once per route.
 *
 * Deny-by-default: a token lacking the capability is refused with the EXACT SAME 401 as
 * a missing / malformed / unknown / revoked token, so a caller cannot distinguish "bad
 * token" from "valid token without this capability". The capability is checked BEFORE
 * any workflow resolution, so an un-capable token never reaches the 404 workflow-scope
 * path — it always sees this one 401 regardless of the workflow ref it sent. An
 * unknown/removed capability string is treated as absent, never a wildcard.
 * touchLastUsed runs fire-and-forget on success.
 */
export async function authenticateHandoffRequest(req: Request, capability: Capability): Promise<AuthResult> {
  const header = (req.headers.get("authorization") ?? "").trim();
  const match = /^Bearer\s+(.+)$/i.exec(header);
  const raw = match?.[1]?.trim();
  if (!raw) return { ok: false, response: unauthorized() };

  const token = await findActiveByHash(hashHandoffToken(raw));
  if (!token) return { ok: false, response: unauthorized() };

  // Deny-by-default capability gate — same 401 body as a bad token (indistinguishable).
  if (!tokenHasCapability(token.capabilities, capability)) return { ok: false, response: unauthorized() };

  void touchLastUsed(token.id); // fire-and-forget best-effort telemetry
  return {
    ok: true,
    auth: { tenantId: token.tenant_id, connectionId: token.n8n_connection_id, tokenId: token.id },
  };
}

export type ScopeResult =
  | { ok: true; clientId: string; clientIsDefault: boolean }
  | { ok: false; response: Response };

/**
 * Scope a workflow_ref to the token's connection + tenant (the synced workflows
 * table) AND resolve its owning client. The token authorizes ONLY workflows under
 * its own connection — a wrong tenant, wrong connection, or unknown ref all return
 * the SAME 404. The returned clientId is the ONLY trusted client for the request
 * (never a body/query field) — used to gate per-client modules (e.g. inbox).
 */
export async function resolveWorkflowOr404(
  auth: HandoffAuth,
  workflowRef: string,
): Promise<ScopeResult> {
  const wf = await resolveWorkflowForConnection(auth.tenantId, auth.connectionId, workflowRef);
  if (!wf) return { ok: false, response: workflowNotFound() };
  return { ok: true, clientId: wf.client_id, clientIsDefault: wf.client_is_default };
}

/** The standard machine "module_disabled" body — same shape as the scheduling API
 * ({error, module}), 403. Never reveals other clients/tenants. */
export function moduleDisabled(module: string): Response {
  return Response.json({ error: "module_disabled", module }, { status: 403 });
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

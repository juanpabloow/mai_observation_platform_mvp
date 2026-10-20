import "server-only";
import {
  canAccessClient,
  canSeeWorkflowInsights,
  getSessionScope,
  hasFullAccess,
  isClientOwner,
  type AccessScope,
} from "./access";
import { isUuid } from "./clientModuleValidation";
import { getClientById } from "@worker/db/repositories/clients.js";
import { getValueDashboardContext, loadValueDashboard } from "@worker/db/repositories/valueDashboard.js";
import { resolvePeriod, type PeriodInput, type PeriodKey, type ValueDashboardData } from "@worker/analytics/valueDashboardModel.js";

/**
 * VALUE DASHBOARD — access + assembly, SERVER ONLY. Used by the page, the period API and the
 * assumptions actions, so all three apply the same rule.
 *
 * Who: `canSeeWorkflowInsights` (§1 of the spec) — the agency (tenant owner/admin) or the
 * OWNER of this very client. Setters and staff are refused, and so is an owner of another
 * client. The client must belong to the session's tenant. A refusal is a 404 (never reveal
 * that a client exists) and 401 without a session.
 *
 * Roles inside the dashboard: the agency PROPOSES assumptions; only the client owner can
 * CONFIRM them. Both are derived from the session, never from the request.
 */

export type ValueAccess =
  | { ok: true; scope: AccessScope; viewer: "owner" | "agency"; canPropose: boolean; canConfirm: boolean }
  | { ok: false; status: 401 | 404 };

export async function resolveValueAccess(clientId: string): Promise<ValueAccess> {
  const scope = await getSessionScope();
  if (!scope) return { ok: false, status: 401 };
  if (!isUuid(clientId)) return { ok: false, status: 404 };
  if (!canAccessClient(scope, clientId) || !canSeeWorkflowInsights(scope, clientId)) return { ok: false, status: 404 };
  // The agency's scope is "all clients" — of ITS tenant. A client id from another tenant
  // must be refused here, not only by the tenant-filtered queries downstream.
  if (!(await getClientById({ tenantId: scope.tenantId, clientId }))) return { ok: false, status: 404 };
  const agency = hasFullAccess(scope);
  return {
    ok: true,
    scope,
    viewer: agency ? "agency" : "owner",
    canPropose: agency || isClientOwner(scope, clientId),
    canConfirm: isClientOwner(scope, clientId),
  };
}

/** Untrusted query params → a period input (unknown keys fall back to 30 días). */
export function periodInputFrom(params: { periodo?: string | null; desde?: string | null; hasta?: string | null }): PeriodInput {
  const key: PeriodKey = params.periodo === "7" || params.periodo === "custom" ? params.periodo : "30";
  return key === "custom" ? { key, from: params.desde ?? null, to: params.hasta ?? null } : { key };
}

export type ValueResult =
  | { ok: true; data: ValueDashboardData }
  | { ok: false; status: 400 | 401 | 404; error: string };

export async function buildValueDashboard(clientId: string, input: PeriodInput, now = new Date()): Promise<ValueResult> {
  const access = await resolveValueAccess(clientId);
  if (!access.ok) return { ok: false, status: access.status, error: access.status === 401 ? "unauthorized" : "not_found" };
  const ctx = await getValueDashboardContext(access.scope.tenantId, clientId);
  if (!ctx) return { ok: false, status: 404, error: "not_found" };
  const p = resolvePeriod(input, now, ctx.tz);
  if (!p.ok) return { ok: false, status: 400, error: p.error };
  const facts = await loadValueDashboard(ctx, p.period, now);
  return {
    ok: true,
    data: { ...facts, viewer: access.viewer, canPropose: access.canPropose, canConfirm: access.canConfirm },
  };
}

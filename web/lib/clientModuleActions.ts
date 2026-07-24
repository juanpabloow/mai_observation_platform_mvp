"use server";

import { revalidatePath } from "next/cache";
import { requireFullAccessForAction } from "./access";
import { parseSetClientModuleInput } from "./clientModuleValidation";
import { getClientById } from "@worker/db/repositories/clients.js";
import {
  disableInboxIfIdle,
  setClientModuleEnabled,
  type ClientModuleRow,
} from "@worker/db/repositories/clientModules.js";

/**
 * Server action for the per-client Modules page (Phase 2: configuration only —
 * enforcement of these toggles is a later phase). Owner/admin only; authorization
 * and tenant come from ONE validated scope (requireFullAccessForAction), and every
 * input is untrusted: the whole payload is strictly validated (Zod, no coercion —
 * "false"/1/null never pass as booleans, null input never throws) before anything
 * else runs. The default ("Unassigned") client can never have modules. Settings
 * are NOT editable from this UI — the repo preserves existing settings when
 * omitted. Errors returned to the browser are generic (never SQL, internals, or
 * other tenants' data).
 */

/** Browser-safe projection of the updated module row. */
export interface ClientModuleView {
  module_key: string;
  enabled: boolean;
}

export type SetClientModuleResult =
  | { ok: true; module: ClientModuleView }
  | { ok: false; error: string };

export async function setClientModuleAction(input: {
  clientId: string;
  moduleKey: string;
  enabled: boolean;
}): Promise<SetClientModuleResult> {
  // ONE validated scope: authorization (owner/admin, fails closed for members)
  // and the tenant come from the same session-derived object.
  const { tenantId } = await requireFullAccessForAction();

  // Strict runtime validation — never throws, no coercion.
  const parsed = parseSetClientModuleInput(input);
  if (!parsed.ok) return { ok: false, error: "Invalid request." };
  const { clientId, moduleKey, enabled } = parsed.value;

  // Tenant-scoped resolution: a foreign or bogus client is indistinguishable
  // from a missing one (generic error, no existence leak).
  const client = await getClientById({ tenantId, clientId });
  if (!client) return { ok: false, error: "Client not found." };
  if (client.is_default) {
    return { ok: false, error: "The Unassigned client cannot have modules." };
  }

  // DISABLING inbox is special: refuse while ACTIVE human conversations exist
  // (pending/human), transactionally + race-safe against a concurrent escalation.
  // Disabling never deletes conversations/messages/contacts/executions/handoff
  // history — re-enabling restores full access.
  let view: ClientModuleView;
  if (moduleKey === "inbox" && !enabled) {
    const res = await disableInboxIfIdle(tenantId, clientId);
    if (!res.ok) {
      if (res.reason === "active_conversations") {
        return { ok: false, error: "Return or resolve active human conversations before disabling Inbox." };
      }
      return { ok: false, error: "Client not found." };
    }
    view = { module_key: "inbox", enabled: false };
  } else {
    const row: ClientModuleRow | null = await setClientModuleEnabled({
      tenantId,
      clientId,
      moduleKey,
      enabled,
      // settings intentionally omitted: an update preserves existing settings,
      // an insert starts from {} (repo semantics).
    });
    if (!row) return { ok: false, error: "Client not found." };
    view = { module_key: row.module_key, enabled: row.enabled };
  }

  revalidatePath("/clients");
  revalidatePath(`/clients/${clientId}/modules`);
  // The module surfaces themselves — so a toggle immediately reflects on their
  // pages (and the sidebar re-render drops/adds the links).
  revalidatePath(`/clients/${clientId}/contacts`);
  revalidatePath(`/clients/${clientId}/scheduling/agenda`);
  revalidatePath(`/clients/${clientId}/inbox`);
  return { ok: true, module: view };
}

import { resolveInboxAccess } from "@/lib/inboxData";
import { loadContactPanel } from "@/lib/contactPanel";
import { getConversationForClient } from "@worker/db/repositories/handoff.js";
import { isClientModuleEnabled } from "@worker/db/repositories/clientModules.js";
import { isUuid } from "@/lib/clientModuleValidation";

/**
 * GET /api/inbox/[clientId]/conversations/[conversationId]/contact
 *
 * SESSION-authed contact payload for the inbox customer panel (C-4). Resolves the
 * conversation for this client (404 if it isn't this client's — indistinguishable from
 * missing), then loads the compact contact panel for its linked contact_id. Returns
 * `{ contactId: null }` when the conversation has no linked contact OR the linked contact
 * resolves outside this client (loadContactPanel re-scopes by client, so no cross-client
 * leak) — the panel then offers to link/create one.
 */
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ clientId: string; conversationId: string }> },
): Promise<Response> {
  const { clientId, conversationId } = await params;
  const id = decodeURIComponent(conversationId);
  if (!isUuid(id)) return Response.json({ error: "not_found" }, { status: 404 });

  const access = await resolveInboxAccess(clientId);
  if (!access.ok) return Response.json({ error: "forbidden" }, { status: access.status });

  const conversation = await getConversationForClient(access.scope.tenantId, clientId, id);
  if (!conversation) return Response.json({ error: "not_found" }, { status: 404 });

  const schedulingEnabled = await isClientModuleEnabled(access.scope.tenantId, clientId, "scheduling");

  if (!conversation.contact_id) return Response.json({ contactId: null, schedulingEnabled });

  const panel = await loadContactPanel(access.scope.tenantId, clientId, conversation.contact_id);
  if (!panel) return Response.json({ contactId: null, schedulingEnabled }); // linked contact is outside this client
  return Response.json({ contactId: conversation.contact_id, panel, schedulingEnabled });
}

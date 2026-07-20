import { connection } from "next/server";
import { notFound, redirect } from "next/navigation";
import { getAccessScope, canAccessClient } from "@/lib/access";
import { getConversationForClient } from "@worker/db/repositories/handoff.js";
import { isUuid } from "@/lib/inboxData";

/**
 * H-6: the client-level Inbox thread moved into the conversation's WORKFLOW inbox.
 * Resolve the conversation's workflow (tenant + client scoped) and 307-redirect there.
 * RBAC: a member who can't see this client → not-found (no existence disclosure).
 */
export default async function OldClientInboxThreadRedirect({
  params,
}: {
  params: Promise<{ clientId: string; conversationId: string }>;
}) {
  await connection();
  const scope = await getAccessScope();
  const { clientId, conversationId } = await params;
  if (!canAccessClient(scope, clientId)) notFound();

  const id = decodeURIComponent(conversationId);
  if (!isUuid(id)) notFound();
  const conv = await getConversationForClient(scope.tenantId, clientId, id);
  if (!conv) notFound();

  redirect(
    `/clients/${clientId}/workflows/${encodeURIComponent(conv.n8n_workflow_id)}/inbox/${encodeURIComponent(id)}`,
  );
}

import { redirect } from "next/navigation";

/**
 * H-6: old per-workflow conversation thread → the workflow Inbox thread (307).
 */
export default async function ConversationThreadRedirect({
  params,
}: {
  params: Promise<{ clientId: string; workflowId: string; conversationId: string }>;
}) {
  const { clientId, workflowId, conversationId } = await params;
  redirect(
    `/clients/${clientId}/workflows/${encodeURIComponent(workflowId)}/inbox/${encodeURIComponent(conversationId)}`,
  );
}

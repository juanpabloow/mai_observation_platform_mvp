import { redirect } from "next/navigation";

/**
 * H-6: the per-workflow "Conversations" section became the per-workflow "Inbox".
 * 307-redirect old links to the new home. (Settings lives at conversations/settings —
 * a static sibling — and is unaffected.)
 */
export default async function ConversationsRedirect({
  params,
}: {
  params: Promise<{ clientId: string; workflowId: string }>;
}) {
  const { clientId, workflowId } = await params;
  redirect(`/clients/${clientId}/workflows/${encodeURIComponent(workflowId)}/inbox`);
}

import { redirect } from "next/navigation";

/**
 * H-6 → W-2: the per-workflow "Conversations"/"Inbox" section is gone; the client-level
 * inbox is the single inbox. 307-redirect old links to it, scoped to this workflow.
 * (Settings lives at conversations/settings — a static sibling — and is unaffected.)
 */
export default async function ConversationsRedirect({
  params,
}: {
  params: Promise<{ clientId: string; workflowId: string }>;
}) {
  const { clientId, workflowId } = await params;
  redirect(`/clients/${clientId}/inbox?workflow=${encodeURIComponent(workflowId)}`);
}

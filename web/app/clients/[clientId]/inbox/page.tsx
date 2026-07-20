import { redirect } from "next/navigation";

/**
 * H-7: the client-level Attention queue is REMOVED — the per-workflow Inbox (grid) is
 * now the only conversations surface. This route 307-redirects to the client overview.
 * (The thread sub-route /inbox/[conversationId] still redirects into the workflow inbox
 * thread for old links.)
 */
export default async function RemovedClientInboxRedirect({
  params,
}: {
  params: Promise<{ clientId: string }>;
}) {
  const { clientId } = await params;
  redirect(`/clients/${clientId}/workflows/all/analytics`);
}

import { connection } from "next/server";
import { redirect } from "next/navigation";
import { resolveRememberedWorkflow } from "@/lib/clientWorkflow";

type SearchParams = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * `all/inbox` is NOT a real view (the Inbox is per-workflow, H-6). Resolve the
 * remembered workflow (?from for this client, else its first, else /clients) and
 * redirect into that workflow's Inbox — mirroring the old all/conversations behavior.
 */
export default async function AllInboxRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ clientId: string }>;
  searchParams: Promise<SearchParams>;
}) {
  await connection();
  const { clientId } = await params;
  const from = first((await searchParams).from);
  const workflowId = await resolveRememberedWorkflow(clientId, from);
  redirect(
    workflowId
      ? `/clients/${clientId}/workflows/${encodeURIComponent(workflowId)}/inbox`
      : "/clients",
  );
}

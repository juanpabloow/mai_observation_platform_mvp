import { connection } from "next/server";
import { redirect } from "next/navigation";
import { resolveRememberedWorkflow } from "@/lib/clientWorkflow";

type SearchParams = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * `all/conversations` is NOT a real view (conversations are per-workflow). Resolve
 * the remembered workflow (?from for this client, else its first workflow, else
 * /clients) and redirect there.
 */
export default async function AllConversationsRedirect({
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
      ? `/clients/${clientId}/workflows/${encodeURIComponent(workflowId)}/conversations`
      : "/clients",
  );
}

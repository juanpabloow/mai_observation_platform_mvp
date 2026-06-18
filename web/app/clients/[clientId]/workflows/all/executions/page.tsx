import { connection } from "next/server";
import { redirect } from "next/navigation";
import { resolveRememberedWorkflow } from "@/lib/clientWorkflow";

type SearchParams = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * `all/executions` is NOT a real view — executions are per-workflow. We resolve
 * the remembered workflow (?from if it belongs to this client, else the client's
 * first workflow, else /clients) and redirect there. This is how "All workflows"
 * analytics returns the user to the SPECIFIC workflow they came from.
 */
export default async function AllExecutionsRedirect({
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
      ? `/clients/${clientId}/workflows/${encodeURIComponent(workflowId)}/executions`
      : "/clients",
  );
}

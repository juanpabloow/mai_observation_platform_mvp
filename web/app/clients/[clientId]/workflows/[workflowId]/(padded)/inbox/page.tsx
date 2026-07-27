import { redirect } from "next/navigation";

type SearchParams = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * The per-workflow Inbox surface was REMOVED (W-2) — it duplicated the client-level
 * inbox (/clients/[c]/inbox), which is the single inbox now, scoped by the header
 * switcher. This route 307-redirects to that inbox scoped to THIS workflow
 * (?workflow=<w>), preserving an open conversation (?c=) so old bookmarks and the
 * execution-detail "Open in Inbox →" land correctly (and scoped). The client inbox page
 * does the real access/module gating on the target.
 */
export default async function LegacyWorkflowInboxRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ clientId: string; workflowId: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { clientId, workflowId } = await params;
  const c = first((await searchParams).c);
  const base = `/clients/${clientId}/inbox?workflow=${encodeURIComponent(workflowId)}`;
  redirect(c ? `${base}&c=${encodeURIComponent(c)}` : base);
}

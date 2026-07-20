import { connection } from "next/server";
import { redirect } from "next/navigation";

type SearchParams = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * H-6: `all/conversations` → `all/inbox` (which resolves the remembered workflow and
 * redirects into its Inbox). Preserves ?from for the resolution.
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
  const q = from ? `?from=${encodeURIComponent(from)}` : "";
  redirect(`/clients/${clientId}/workflows/all/inbox${q}`);
}

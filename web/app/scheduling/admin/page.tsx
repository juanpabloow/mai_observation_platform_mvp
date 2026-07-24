import { connection } from "next/server";
import { redirect } from "next/navigation";
import { requireFullAccessOrLand } from "@/lib/access";
import { getClientForTenant } from "@/lib/clientWorkflow";

type SearchParams = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * COMPAT: scheduling is now administered PER CLIENT — there is no global admin. This
 * legacy route never renders an administrator; it only redirects:
 *   - `?clientId=<valid non-default client>` → the canonical
 *     /clients/[clientId]/scheduling/admin (validated tenant-scoped; a foreign/bogus
 *     id falls through);
 *   - otherwise → /clients, where the owner/admin picks a client.
 * Owner/admin only (a member is bounced to their landing by requireFullAccessOrLand).
 */
export default async function LegacySchedulingAdminRedirect({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await connection();
  await requireFullAccessOrLand(); // owner/admin only
  const clientId = first((await searchParams).clientId);
  if (clientId) {
    const client = await getClientForTenant(clientId); // tenant-scoped; foreign → null
    if (client && !client.is_default) {
      redirect(`/clients/${client.id}/scheduling/admin`);
    }
  }
  redirect("/clients");
}

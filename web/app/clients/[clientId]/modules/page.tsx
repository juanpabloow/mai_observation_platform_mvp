import { connection } from "next/server";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireFullAccessOrLand } from "@/lib/access";
import { getClientForTenant } from "@/lib/clientWorkflow";
import { isUuid } from "@/lib/clientModuleValidation";
import { listClientModules } from "@worker/db/repositories/clientModules.js";
import { CLIENT_MODULE_KEYS } from "@worker/modules/registry.js";
import { ClientModulesPanel, type ModuleState } from "@/components/ClientModulesPanel";

/**
 * Per-client Modules (CLIENT level, Phase 2: configuration only). Owner/admin
 * only — requireFullAccessOrLand sends a member to their own client. The
 * clientId resolves tenant-scoped via getClientForTenant, so a foreign/bogus
 * client 404s (the URL is never trusted); the default ("Unassigned") client
 * can't have modules, so it 404s too. State is built against EVERY key in the
 * registry — the absence of a client_modules row means DISABLED.
 */
export default async function ClientModulesPage({
  params,
}: {
  params: Promise<{ clientId: string }>;
}) {
  await connection();
  const { tenantId } = await requireFullAccessOrLand(); // owner/admin only
  const { clientId } = await params;
  // Malformed route param → 404 BEFORE any PostgreSQL query (never a 500).
  if (!isUuid(clientId)) notFound();
  const client = await getClientForTenant(clientId); // tenant-scoped; foreign → null
  if (!client) notFound();
  if (client.is_default) notFound(); // the Unassigned client has no modules

  const rows = await listClientModules(tenantId, clientId);
  const byKey = new Map(rows.map((r) => [r.module_key, r]));
  const modules: ModuleState[] = CLIENT_MODULE_KEYS.map((key) => ({
    key,
    enabled: byKey.get(key)?.enabled ?? false, // no row = disabled
  }));

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-6 py-10">
      <header className="space-y-1">
        {/* Back to the client's own workspace (the "all workflows" aggregate —
            valid even when the client has zero workflows: it renders an empty
            state), not the tenant-wide /clients management view. */}
        <Link
          href={`/clients/${client.id}/workflows/all/analytics`}
          className="text-sm text-neutral-500 transition-colors hover:text-foreground"
        >
          &larr; {client.name}
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Modules</h1>
        <p className="text-sm text-muted">
          Choose which product surfaces are configured for {client.name}.
        </p>
      </header>

      <ClientModulesPanel clientId={client.id} initialModules={modules} />
    </main>
  );
}

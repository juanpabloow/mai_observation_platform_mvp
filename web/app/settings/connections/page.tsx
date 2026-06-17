import { connection } from "next/server";
import Link from "next/link";
import { listConnectionsForTenant } from "@worker/db/repositories/n8nConnections.js";
import { requireTenant } from "@/lib/requireAuth";
import { ConnectionsManager } from "@/components/ConnectionsManager";

export default async function ConnectionsSettingsPage() {
  await connection();
  // Tenant-scoped + protected (redirects to /login if not authed).
  const { tenantId } = await requireTenant();
  const connections = await listConnectionsForTenant(tenantId);

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-6 py-12">
      <div className="space-y-1">
        <Link href="/" className="text-sm text-neutral-500 transition-colors hover:text-foreground">
          &larr; Overview
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">n8n connections</h1>
        <p className="text-sm text-neutral-500">
          Connect your n8n instance so we can ingest its executions. Your API key is
          encrypted at rest and never shown again.
        </p>
      </div>

      <ConnectionsManager
        connections={connections.map((c) => ({
          id: c.id,
          name: c.name,
          n8n_base_url: c.n8n_base_url,
          is_active: c.is_active,
        }))}
      />
    </main>
  );
}

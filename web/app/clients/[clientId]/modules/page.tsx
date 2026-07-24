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

  const enabledCount = modules.filter((m) => m.enabled).length;
  const initial = client.name.trim()[0]?.toUpperCase() ?? "?";

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-6 py-10">
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
        <h1 className="text-2xl font-semibold tracking-tight">Client settings</h1>
        <p className="text-sm text-muted">Identity and product capabilities for {client.name}.</p>
      </header>

      {/* Two columns on desktop (identity | capabilities); one column on mobile. */}
      <div className="grid grid-cols-1 gap-6 md:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
        {/* LEFT — the client's real identity (name + logo). No fabricated fields. */}
        <aside className="flex flex-col gap-4">
          <section className="flex flex-col gap-3 rounded-xl border border-line bg-card p-4">
            <div className="flex items-center gap-3">
              {client.logo_url ? (
                // eslint-disable-next-line @next/next/no-img-element -- tiny external logo from R2
                <img
                  src={client.logo_url}
                  alt=""
                  aria-hidden
                  className="size-11 shrink-0 rounded-lg border border-line object-cover"
                />
              ) : (
                <span
                  aria-hidden
                  className="flex size-11 shrink-0 items-center justify-center rounded-lg border border-line bg-subtle text-base font-semibold text-foreground"
                >
                  {initial}
                </span>
              )}
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-foreground">{client.name}</p>
                <p className="text-xs text-faint">Client workspace</p>
              </div>
            </div>
            <p className="text-xs text-muted">
              {enabledCount === 0
                ? "No modules enabled yet."
                : `${enabledCount} module${enabledCount === 1 ? "" : "s"} enabled.`}
            </p>
            <Link
              href={`/clients/${client.id}/workflows/all/analytics`}
              className="inline-flex w-fit items-center rounded-lg border border-black/10 px-3 py-1.5 text-sm text-muted transition-colors hover:bg-black/[0.04] hover:text-foreground dark:border-line-strong dark:hover:bg-subtle"
            >
              Open workspace
            </Link>
          </section>
        </aside>

        {/* RIGHT — capability cards (the real per-client module toggles). */}
        <section className="flex flex-col gap-3">
          <h2 className="text-[11px] font-medium uppercase tracking-wider text-faint">Capabilities</h2>
          <ClientModulesPanel clientId={client.id} initialModules={modules} />
        </section>
      </div>
    </main>
  );
}

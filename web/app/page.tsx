import Link from "next/link";
import { connection } from "next/server";
import {
  countActiveConnectionsForTenant,
  countExecutionsForTenant,
} from "@worker/db/repositories/stats.js";
import { listClientsForTenant } from "@worker/db/repositories/clients.js";
import { listWorkflowsWithClientForTenant } from "@worker/db/repositories/workflows.js";
import { getCurrentTenantId } from "@/lib/tenant";

/**
 * The Hub — the tenant lobby / landing page (the header logo links here). For now
 * a light overview: a few real tenant counts + a placeholder for the richer
 * analytics that CL-5 will build. Soft-gates onboarding when no n8n is connected.
 */
export default async function HubPage() {
  await connection();

  const tenantId = await getCurrentTenantId();
  const [executions, activeConnections, clients, workflows] = await Promise.all([
    countExecutionsForTenant(tenantId),
    countActiveConnectionsForTenant(tenantId),
    listClientsForTenant(tenantId),
    listWorkflowsWithClientForTenant(tenantId),
  ]);

  if (activeConnections === 0) {
    return (
      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-6 px-6 py-20">
        <header className="space-y-3">
          <p className="text-sm font-medium uppercase tracking-widest text-faint">Hub</p>
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            Connect your n8n to start monitoring
          </h1>
          <p className="text-muted">
            Add your n8n instance and API key — we&rsquo;ll begin ingesting its
            executions automatically and reconstruct your conversations here.
          </p>
        </header>
        <div>
          <Link
            href="/settings/connections"
            className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-emerald-500"
          >
            Connect n8n
            <span aria-hidden>&rarr;</span>
          </Link>
        </div>
      </main>
    );
  }

  // "Clients" = the named (non-default) clients the user has created; the default
  // client is the home for unassigned workflows, not a client they manage.
  const clientCount = clients.filter((c) => !c.is_default).length;
  const stats = [
    { label: "Clients", value: clientCount },
    { label: "Workflows", value: workflows.length },
    { label: "Executions ingested", value: executions },
    { label: "Active n8n connections", value: activeConnections },
  ];

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-10 px-6 py-12">
      <header className="space-y-3">
        <p className="text-sm font-medium uppercase tracking-widest text-faint">Hub</p>
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Workspace overview</h1>
        <p className="text-muted">A snapshot of your workspace. Detailed analytics are coming soon.</p>
      </header>

      <section className="grid grid-cols-2 gap-5 lg:grid-cols-4">
        {stats.map((stat) => (
          <div
            key={stat.label}
            className="rounded-2xl border border-line bg-card p-6 shadow-sm"
          >
            <dt className="text-sm font-medium text-muted">{stat.label}</dt>
            <dd className="mt-3 text-4xl font-semibold tabular-nums tracking-tight">
              {stat.value.toLocaleString()}
            </dd>
          </div>
        ))}
      </section>

      <section className="flex flex-col gap-4 rounded-2xl border border-dashed border-line p-8 text-center">
        <p className="text-sm font-medium text-muted">Analytics coming soon</p>
        <p className="mx-auto max-w-md text-sm text-faint">
          Tenant-level charts — executions over time, per-client activity, error
          rates — will live here.
        </p>
        <div>
          <Link
            href="/clients"
            className="inline-flex items-center gap-2 rounded-full border border-line bg-card px-5 py-2.5 text-sm font-medium transition-colors hover:bg-subtle"
          >
            Go to Clients &amp; Workflows
            <span aria-hidden>&rarr;</span>
          </Link>
        </div>
      </section>
    </main>
  );
}

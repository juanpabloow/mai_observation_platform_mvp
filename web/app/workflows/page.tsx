import Link from "next/link";
import { connection } from "next/server";
import { listWorkflowsForTenantWithCounts } from "@worker/db/repositories/workflows.js";
import { countActiveConnectionsForTenant } from "@worker/db/repositories/stats.js";
import { getCurrentTenantId } from "@/lib/tenant";
import { WorkflowPicker } from "@/components/WorkflowPicker";

export default async function WorkflowsPage() {
  await connection();

  const tenantId = await getCurrentTenantId();
  const [workflows, activeConnections] = await Promise.all([
    listWorkflowsForTenantWithCounts(tenantId),
    countActiveConnectionsForTenant(tenantId),
  ]);

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-6 py-12">
      <header className="space-y-2">
        <Link
          href="/"
          className="text-sm text-neutral-500 transition-colors hover:text-neutral-300"
        >
          &larr; Overview
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Workflows</h1>
        <p className="text-sm text-neutral-500">
          {workflows.length} workflow{workflows.length === 1 ? "" : "s"} · pick one to view
          its executions
        </p>
      </header>

      {activeConnections === 0 ? (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-dashed border-black/15 px-5 py-8 dark:border-white/15">
          <p className="text-sm text-neutral-400">
            No n8n connection yet — connect one to start ingesting workflows and
            executions.
          </p>
          <Link
            href="/settings/connections"
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-500"
          >
            Connect n8n
          </Link>
        </div>
      ) : (
        <WorkflowPicker workflows={workflows} />
      )}
    </main>
  );
}

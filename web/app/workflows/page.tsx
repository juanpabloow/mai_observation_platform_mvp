import Link from "next/link";
import { connection } from "next/server";
import { listWorkflowsForTenantWithCounts } from "@worker/db/repositories/workflows.js";
import { getCurrentTenantId } from "@/lib/tenant";
import { WorkflowPicker } from "@/components/WorkflowPicker";

export default async function WorkflowsPage() {
  await connection();

  const tenantId = await getCurrentTenantId();
  const workflows = await listWorkflowsForTenantWithCounts(tenantId);

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

      <WorkflowPicker workflows={workflows} />
    </main>
  );
}

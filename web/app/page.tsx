import Link from "next/link";
import { connection } from "next/server";
import {
  countActiveConnectionsForTenant,
  countExecutionsForTenant,
} from "@worker/db/repositories/stats.js";
import { getCurrentTenantId } from "@/lib/tenant";

export default async function Home() {
  // Force runtime (dynamic) rendering so the counts are read from the live DB
  // on each request rather than at build time.
  await connection();

  const tenantId = await getCurrentTenantId();
  const [executions, activeConnections] = await Promise.all([
    countExecutionsForTenant(tenantId),
    countActiveConnectionsForTenant(tenantId),
  ]);

  // Soft-gate onboarding: a tenant with no connection can use the app but has no
  // data, so prompt them to connect their n8n instead of showing empty stats.
  if (activeConnections === 0) {
    return (
      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-6 px-6 py-20">
        <header className="space-y-3">
          <p className="text-sm font-medium uppercase tracking-widest text-neutral-500">
            Observability Platform
          </p>
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            Connect your n8n to start monitoring
          </h1>
          <p className="text-neutral-500">
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

  const stats = [
    { label: "Executions ingested", value: executions },
    { label: "Active n8n connections", value: activeConnections },
  ];

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col justify-center gap-10 px-6 py-20">
      <header className="space-y-3">
        <p className="text-sm font-medium uppercase tracking-widest text-neutral-500">
          Observability Platform
        </p>
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
          Ingestion overview
        </h1>
        <p className="text-neutral-500">
          Live counts read directly from the Postgres database.
        </p>
      </header>

      <section className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        {stats.map((stat) => (
          <div
            key={stat.label}
            className="rounded-2xl border border-black/10 bg-black/[0.02] p-6 shadow-sm dark:border-white/10 dark:bg-white/[0.03]"
          >
            <dt className="text-sm font-medium text-neutral-500">
              {stat.label}
            </dt>
            <dd className="mt-3 text-5xl font-semibold tabular-nums tracking-tight">
              {stat.value.toLocaleString()}
            </dd>
          </div>
        ))}
      </section>

      <div className="flex flex-wrap gap-3">
        <Link
          href="/clients"
          className="inline-flex items-center gap-2 rounded-full border border-black/10 bg-black/[0.03] px-5 py-2.5 text-sm font-medium transition-colors hover:bg-black/[0.06] dark:border-white/15 dark:bg-white/[0.04] dark:hover:bg-white/[0.08]"
        >
          Browse clients
          <span aria-hidden>&rarr;</span>
        </Link>
        <Link
          href="/settings/connections"
          className="inline-flex items-center gap-2 rounded-full border border-black/10 px-5 py-2.5 text-sm font-medium text-neutral-400 transition-colors hover:bg-black/[0.04] hover:text-neutral-200 dark:border-white/15 dark:hover:bg-white/[0.06]"
        >
          Manage connections
        </Link>
      </div>
    </main>
  );
}

import Link from "next/link";
import { connection } from "next/server";
import { countActiveConnectionsForTenant } from "@worker/db/repositories/stats.js";
import { requireFullAccessOrLand } from "@/lib/access";
import { getServerSession } from "@/lib/session";
import { buildAgencyHome } from "@/lib/agencyHome";
import { AgencyHomeView } from "@/components/home/AgencyHomeView";

/**
 * `/` — the agency's landing (the header logo links here): what needs attention, each business
 * with its doors (Inbox, value dashboard, agenda), and the agency tools with one status line.
 * Owner/admin only: a member is sent to their own business (requireFullAccessOrLand). Without an
 * n8n connection it stays the onboarding prompt — nothing to show yet.
 */
export default async function HomePage() {
  await connection();
  const { tenantId } = await requireFullAccessOrLand();

  if ((await countActiveConnectionsForTenant(tenantId)) === 0) {
    return (
      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-6 px-6 py-20">
        <header className="space-y-3">
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Conecta tu n8n para empezar</h1>
          <p className="text-muted">
            Agrega tu instancia de n8n y su API key: empezaremos a leer sus ejecuciones y a reconstruir aquí las
            conversaciones de tus bots.
          </p>
        </header>
        <div>
          <Link
            href="/settings/connections"
            className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-emerald-500"
          >
            Conectar n8n
            <span aria-hidden>&rarr;</span>
          </Link>
        </div>
      </main>
    );
  }

  const [home, session] = await Promise.all([buildAgencyHome(tenantId), getServerSession()]);
  const firstName = session?.user?.name?.trim().split(/\s+/)[0] ?? null;
  return <AgencyHomeView home={home} firstName={firstName} today={new Date().toISOString()} />;
}

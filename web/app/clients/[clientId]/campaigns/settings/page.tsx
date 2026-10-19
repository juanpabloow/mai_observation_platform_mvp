import { connection } from "next/server";
import { notFound } from "next/navigation";
import Link from "next/link";
import { hasFullAccess } from "@/lib/access";
import { requireClientModulePage } from "@/lib/clientModuleAccess";
import { getAttributionSettings, countPendingAttributions } from "@worker/db/repositories/attribution.js";
import { getAttributionFailureCount } from "@worker/attribution/ingest.js";
import { AttributionSettingsPanel } from "@/components/campaigns/AttributionSettingsPanel";

/**
 * Attribution SETTINGS (AT-2 §3) — AGENCY ONLY. Gating: requireClientModulePage(campaigns) then
 * hasFullAccess (a Client Owner, Setter or Staff is 404'd — stricter than the Campañas section
 * itself, which a Setter may read). Holds the per-client tracking start, the AT-3 brief window,
 * and the AT-1 attribution health counters. The server actions re-enforce the agency tier.
 */
export default async function AttributionSettingsPage({
  params,
}: {
  params: Promise<{ clientId: string }>;
}) {
  await connection();
  const { clientId } = await params;
  const { scope, client } = await requireClientModulePage(clientId, "campaigns");
  if (!hasFullAccess(scope)) notFound(); // agency only

  const [settings, pending] = await Promise.all([
    getAttributionSettings(scope.tenantId, client.id),
    countPendingAttributions(scope.tenantId),
  ]);
  // In-memory per-process counter (resets on deploy): the web process accumulates live-ingestion
  // failures from the /messages route. A rough health signal, labelled as such.
  const failed = getAttributionFailureCount();

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-[var(--content-pad)] px-4 py-6 sm:px-6">
      <Link
        href={`/clients/${client.id}/campaigns`}
        className="u-th inline-flex w-fit items-center gap-1.5 rounded-md py-1 transition-colors hover:text-foreground"
      >
        ← Campañas
      </Link>
      <AttributionSettingsPanel
        clientId={client.id}
        clientName={client.name}
        trackingStartedAt={settings.tracking_started_at ? settings.tracking_started_at.toISOString().slice(0, 10) : ""}
        briefWindowDays={settings.brief_window_days}
        failedAttributions={failed}
        pendingAttributions={pending}
      />
    </main>
  );
}

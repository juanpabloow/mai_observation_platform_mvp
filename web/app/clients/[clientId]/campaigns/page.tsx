import { connection } from "next/server";
import { notFound } from "next/navigation";
import { canManageCampaigns, canReadCampaigns } from "@/lib/access";
import { requireClientModulePage } from "@/lib/clientModuleAccess";
import { listAdsWithStats, listCampaignsWithStats } from "@worker/db/repositories/attribution.js";
import { listServices } from "@worker/db/repositories/scheduling/services.js";
import { listPromotions } from "@worker/db/repositories/scheduling/promotions.js";
import { CampaignsPanel } from "@/components/campaigns/CampaignsPanel";

/**
 * Per-CLIENT Campañas section (AT-2). Gating, in order:
 *   1. requireClientModulePage(clientId, "campaigns") — URL clientId validated against the
 *      session tenant + scope, client exists, non-default, campaigns module ENABLED; any
 *      failure is an indistinguishable 404. Because campaigns ≠ scheduling, Staff is 404'd here.
 *   2. canReadCampaigns — the agency, this client's OWNER, or a SETTER. (Belt to the gate.)
 * canManage (agency/owner) decides whether write controls render; the server actions re-enforce
 * every tier, so a Setter gets a read-only view. All data loads with the VALIDATED client id.
 */
export default async function ClientCampaignsPage({
  params,
}: {
  params: Promise<{ clientId: string }>;
}) {
  await connection();
  const { clientId } = await params;
  const { scope, client } = await requireClientModulePage(clientId, "campaigns");
  if (!canReadCampaigns(scope, clientId)) notFound();

  const [ads, campaigns, services, promotions] = await Promise.all([
    listAdsWithStats(scope.tenantId, client.id, { includeTest: true }),
    listCampaignsWithStats(scope.tenantId, client.id),
    listServices(scope.tenantId, client.id),
    listPromotions(scope.tenantId, client.id),
  ]);

  const canManage = canManageCampaigns(scope, clientId);

  return (
    <CampaignsPanel
      clientId={client.id}
      clientName={client.name}
      canManage={canManage}
      ads={ads.map((a) => ({
        id: a.id,
        external_id: a.external_id,
        source_type: a.source_type,
        headline: a.headline,
        body: a.body,
        media_type: a.media_type,
        source_url: a.source_url,
        is_test: a.is_test,
        campaign_id: a.campaign_id,
        campaign_name: a.campaign_name,
        leads: a.leads,
        touches: a.touches,
        first_seen_at: a.first_seen_at.toISOString(),
        last_seen_at: a.last_seen_at.toISOString(),
      }))}
      campaigns={campaigns.map((c) => ({
        id: c.id,
        name: c.name,
        status: c.status,
        start_date: c.start_date,
        end_date: c.end_date,
        external_campaign_id: c.external_campaign_id,
        target_service_id: c.target_service_id,
        promotion_id: c.promotion_id,
        bot_brief: c.bot_brief,
        ad_count: c.ad_count,
      }))}
      services={services.map((s) => ({ id: s.id, name: s.name }))}
      promotions={promotions.map((p) => ({ id: p.id, name: p.name }))}
    />
  );
}

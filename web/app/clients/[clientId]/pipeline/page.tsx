import { connection } from "next/server";
import { notFound } from "next/navigation";
import { requireClientModulePage } from "@/lib/clientModuleAccess";
import {
  listAwaitingBusinessReply,
  listBoardOpportunities,
  type BoardFilters,
  type OpportunityStatus,
} from "@worker/db/repositories/pipeline.js";
import { listAdsWithStats, listCampaignsWithStats } from "@worker/db/repositories/attribution.js";
import { isOriginGroupKey, kindsForGroup } from "@/lib/originDisplay";
import { displayContactName } from "@/lib/contactName";
import { toBoardCard } from "@/lib/pipelineBoard";
import { PipelinePanel } from "@/components/pipeline/PipelinePanel";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const STATUSES = new Set<OpportunityStatus>(["open", "won", "lost"]);

/**
 * SALES PIPELINE board (PL-2), inside the CRM module. Gating: `requireClientModulePage(clientId,
 * "crm")` (staff 404'd) + belt `canReadCampaigns` (agency/owner/setter) — the same audience as the
 * contact's Origen card. Every write is a server action that re-enforces the gate.
 */
export default async function PipelinePage({
  params,
  searchParams,
}: {
  params: Promise<{ clientId: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await connection();
  const { clientId } = await params;
  const { scope, client } = await requireClientModulePage(clientId, "crm", "pipeline.view");
  const sp = await searchParams;

  const [campaigns, ads] = await Promise.all([
    listCampaignsWithStats(scope.tenantId, client.id),
    listAdsWithStats(scope.tenantId, client.id), // non-test by default
  ]);

  // Validate every facet (unknown → no filter), mirroring the contacts list.
  const originGroup = isOriginGroupKey(sp.origin) ? sp.origin : undefined;
  const originKinds = originGroup ? kindsForGroup(originGroup) : undefined;
  const campaignId = sp.campaign && campaigns.some((c) => c.id === sp.campaign) ? sp.campaign : undefined;
  const adId = sp.ad && ads.some((a) => a.id === sp.ad) ? sp.ad : undefined;
  const openedFrom = sp.from && DAY.test(sp.from) ? `${sp.from}T00:00:00.000Z` : undefined;
  const openedTo = sp.to && DAY.test(sp.to) ? `${sp.to}T23:59:59.999Z` : undefined;
  const statusFilter = sp.status && STATUSES.has(sp.status as OpportunityStatus) ? (sp.status as OpportunityStatus) : undefined;

  const filters: BoardFilters = { originKinds, campaignId, adId, openedFrom, openedTo };
  const [boardRows, lostRows, queueRows] = await Promise.all([
    // The board columns = everything NOT lost (the status filter narrows further if set).
    listBoardOpportunities(scope.tenantId, client.id, { ...filters, status: statusFilter }),
    listBoardOpportunities(scope.tenantId, client.id, { ...filters, status: "lost" }),
    listAwaitingBusinessReply(scope.tenantId, client.id),
  ]);

  const queue = queueRows.map((q) => ({
    id: q.id,
    contactId: q.contact_id,
    conversationId: q.conversation_id,
    name: displayContactName({ name: q.contact_name, phoneE164: q.contact_phone_e164, channelUserId: q.contact_channel_user_id }),
    stage: q.stage,
    lastMessageAt: q.last_message_at.toISOString(),
  }));

  return (
    <PipelinePanel
      clientId={client.id}
      clientName={client.name}
      cards={boardRows.map(toBoardCard)}
      lostCards={lostRows.map(toBoardCard)}
      queue={queue}
      campaigns={campaigns.map((c) => ({ id: c.id, name: c.name }))}
      ads={ads.map((a) => ({ id: a.id, label: a.name || a.headline || a.external_id }))}
      filters={{
        origin: originGroup ?? "",
        campaign: campaignId ?? "",
        ad: adId ?? "",
        from: sp.from && DAY.test(sp.from) ? sp.from : "",
        to: sp.to && DAY.test(sp.to) ? sp.to : "",
        status: statusFilter ?? "",
      }}
    />
  );
}

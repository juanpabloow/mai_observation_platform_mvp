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
import { can } from "@/lib/access";
import { stageTotals, toBoardCard } from "@/lib/pipelineBoard";
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
  // JP-6: only a viewer with payments.view sees per-card amounts (the paid amount + the list price).
  const canViewPayments = can(scope, "payments.view", client.id);
  // JP-7: the column/funnel MONEY TOTALS are a revenue view — Client Owner + agency, NEVER a Setter
  // (analytics.view; the Setter is explicitly "No ve resultados"). Enforced server-side: a Setter's
  // payload carries no totals at all (see `moneyTotals` below).
  const canViewRevenue = can(scope, "analytics.view", client.id);

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

  // `toBoardCard` reads its own clock for the stale thresholds (a lib call, not render state).
  const cards = boardRows.map((r) => toBoardCard(r, canViewPayments));
  const lostCardsVm = lostRows.map((r) => toBoardCard(r, canViewPayments));
  // Server-gated money totals: computed only for a revenue viewer, so a Setter's payload has none.
  const moneyTotals = canViewRevenue ? stageTotals(cards) : null;

  return (
    <PipelinePanel
      clientId={client.id}
      clientName={client.name}
      cards={cards}
      lostCards={lostCardsVm}
      moneyTotals={moneyTotals}
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

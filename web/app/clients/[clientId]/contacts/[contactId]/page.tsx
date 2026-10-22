import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { requireClientModulePage } from "@/lib/clientModuleAccess";
import { can } from "@/lib/access";
import { isUuid } from "@/lib/clientModuleValidation";
import { getContactById, listContactConversations } from "@worker/db/repositories/contacts.js";
import { getContactOriginDetail, listCampaignsWithStats } from "@worker/db/repositories/attribution.js";
import { listContactOpportunities, listOpportunityAppointments, listOpportunityStageEvents } from "@worker/db/repositories/pipeline.js";
import { listIdentitiesForContact, listCandidatesForContact } from "@worker/db/repositories/contactIdentities.js";
import { listFieldDefinitions } from "@worker/db/repositories/clientFieldDefinitions.js";
import { listMembersForTenant } from "@worker/db/repositories/tenantMembers.js";
import { getContactTimeline } from "@worker/db/repositories/contactTimeline.js";
import { listTasksForContact } from "@worker/db/repositories/crmTasks.js";
import { listTagsForContact, listTags } from "@worker/db/repositories/contactTags.js";
import {
  getContactValueProfile,
  listAppointmentsForContact,
} from "@worker/db/repositories/scheduling/appointments.js";
import { isClientModuleEnabled } from "@worker/db/repositories/clientModules.js";
import { loadContactEditPayload, summarizeAppointments, toTaskView } from "@/lib/contactPanel";
import { contactDisplayName, type IdentityView } from "@/lib/contactShared";
import { ContactRecord } from "@/components/contacts/ContactRecord";

/**
 * Client-scoped contact RECORD (C-4). Replaces the C-3 scaffolding (edit form + tabs)
 * with the unified three-region record (identity/properties · timeline · associations).
 * Gated by the `crm` module resolver (404 for foreign/default/disabled). Every read
 * below is a single bounded query (Promise.all) — no per-row lookups; derived customer
 * status + visit/no-show counts + the appointment split are computed once from the
 * contact's appointments (they are not stored).
 */
export default async function ClientContactDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ clientId: string; contactId: string }>;
  searchParams: Promise<{ from?: string }>;
}) {
  await connection();
  const { clientId, contactId } = await params;
  if (!isUuid(contactId)) notFound();
  const { scope, client } = await requireClientModulePage(clientId, "crm", "contacts.view");
  const { from } = await searchParams;
  const tenantId = scope.tenantId;
  // What this viewer may do here — from its permissions, never its role's name. The
  // actions re-check every one of them on the server.
  const manageOthers = can(scope, "contacts.manage_others", client.id);
  const canDeleteContacts = can(scope, "contacts.delete", client.id);
  const canTags = can(scope, "contacts.tags", client.id);
  const canFields = can(scope, "contacts.fields", client.id);

  const contact = await getContactById(tenantId, contactId, client.id);
  if (!contact) notFound();

  const [identities, fieldDefs, members, timeline, openTasks, attachedTags, tagCatalogue, appts, conversations, schedulingEnabled, candidates, editPayload, valueProfile, originDetail, campaigns, opportunities] =
    await Promise.all([
      listIdentitiesForContact(tenantId, client.id, contactId),
      listFieldDefinitions(tenantId, client.id, { enabledOnly: true }),
      listMembersForTenant(tenantId),
      getContactTimeline(tenantId, client.id, contactId, {}),
      listTasksForContact(tenantId, client.id, contactId, { status: "open" }),
      listTagsForContact(tenantId, client.id, contactId),
      listTags(tenantId, client.id),
      listAppointmentsForContact(tenantId, contactId, client.id),
      listContactConversations(tenantId, contactId, client.id),
      isClientModuleEnabled(tenantId, client.id, "scheduling"),
      // The duplicate banner + merge/dismiss are owner/admin only — only they need the query.
      canDeleteContacts ? listCandidatesForContact(tenantId, client.id, contactId) : Promise.resolve([]),
      // The whole-contact edit payload, from the SAME loader the list's customer panel
      // uses — one shape, so the two doors into editing cannot drift apart.
      // No contacts.edit → no Edit button at all (the action would refuse it).
      can(scope, "contacts.edit", client.id)
        ? loadContactEditPayload(tenantId, client.id, contactId, { userId: scope.userId, canAssignOthers: manageOthers, canDelete: canDeleteContacts, canManageTagCatalog: canTags })
        : Promise.resolve(null),
      // The record's "Valor del cliente" + "Preferencias" cards. Null for a contact who
      // has never completed a visit, which those cards render as their empty state — the
      // alternative would be printing "$0" at somebody who simply has not come in yet.
      getContactValueProfile(tenantId, client.id, contactId),
      // AT-2 lead origin (facts + touches) for the "Origen" card, and this client's campaigns
      // for the manual-origin picker. Origin is a CRM-level fact (captured regardless of the
      // campaigns module), so it's shown here on the crm-gated record.
      getContactOriginDetail(tenantId, client.id, contactId),
      listCampaignsWithStats(tenantId, client.id),
      // PL-2 §3 — the contact's sales opportunities (current + past). CRM-gated like origin.
      listContactOpportunities(tenantId, client.id, contactId),
    ]);

  // The "current" sale is the open one if any, else the most recent; its stage history + linked
  // appointments are a small dependent read (two bounded queries, only when a sale exists).
  const currentOpp = opportunities.find((o) => o.status === "open") ?? opportunities[0] ?? null;
  const [oppEvents, oppAppointments] = currentOpp
    ? await Promise.all([listOpportunityStageEvents(tenantId, currentOpp.id), listOpportunityAppointments(tenantId, currentOpp.id)])
    : [[], []];

  const identityViews: IdentityView[] = identities.map((i) => ({ kind: i.kind, value: i.value, label: i.label }));
  const appointments = summarizeAppointments(appts);
  const displayName = contactDisplayName(contact.name, identityViews, contact.channel_user_id);

  // Owner/admin may assign to any user with client access; a member only to themselves.
  const assignableMembers = members
    .filter((m) => (manageOthers ? m.member_client_id === null || m.member_client_id === client.id : m.user_id === scope.userId))
    .map((m) => ({ userId: m.user_id, email: m.email, name: m.name }));
  const ownerName = contact.assigned_to
    ? members.find((m) => m.user_id === contact.assigned_to)?.name ?? members.find((m) => m.user_id === contact.assigned_to)?.email ?? null
    : null;

  const fromQS = from ? `?from=${encodeURIComponent(from)}` : "";

  // PL-2 §3 — serializable opportunity view. Actor ids resolve to member names (system/bot stay literal).
  const membersById = new Map(members.map((m) => [m.user_id, m.name ?? m.email]));
  const actorLabel = (actor: string) => (actor === "system" ? "Sistema" : actor === "bot" ? "Asistente" : membersById.get(actor) ?? "Usuario");
  const mapOpp = (o: (typeof opportunities)[number]) => ({
    id: o.id,
    stage: o.stage,
    status: o.status,
    createdAt: o.created_at.toISOString(),
    leadAt: o.lead_at?.toISOString() ?? null,
    qualifiedAt: o.qualified_at?.toISOString() ?? null,
    bookedAt: o.booked_at?.toISOString() ?? null,
    attendedAt: o.attended_at?.toISOString() ?? null,
    paidAt: o.paid_at?.toISOString() ?? null,
    closedAt: o.closed_at?.toISOString() ?? null,
    qualificationService: o.qualification_service,
    qualificationTimeframe: o.qualification_timeframe,
    qualificationMessageId: o.qualification_message_id,
    qualifiedBy: o.qualified_by ? actorLabel(o.qualified_by) : null,
    qualifiedImplicitly: o.qualified_implicitly,
    lostReason: o.lost_reason,
    lostNote: o.lost_note,
  });
  const pipeline = {
    current: currentOpp ? mapOpp(currentOpp) : null,
    past: opportunities.filter((o) => o.id !== currentOpp?.id).map(mapOpp),
    events: oppEvents.map((e) => ({
      fromStage: e.from_stage,
      toStage: e.to_stage,
      fromStatus: e.from_status,
      toStatus: e.to_status,
      actor: actorLabel(e.actor),
      reason: e.reason,
      at: e.occurred_at.toISOString(),
    })),
    appointments: oppAppointments.map((a) => ({ id: a.id, at: a.start_at.toISOString(), status: a.status, service: a.service_name_snapshot })),
  };

  return (
    // `relative` makes this the record's PANEL REGION: the edit drawer anchors to the
    // content column, exactly as it does to the panel column on the list, instead of
    // to the window. Same frame, same width, on both pages.
    <main className="relative flex w-full flex-1 flex-col gap-[var(--content-pad)]">
      {/* Back to the list, carrying `from` (the origin workflow) unchanged. */}
      <Link
        href={`/clients/${client.id}/contacts${fromQS}`}
        className="u-th inline-flex w-fit items-center gap-1.5 rounded-md py-1 transition-colors hover:text-foreground max-sm:min-h-[44px] max-sm:min-w-[44px]"
      >
        ← Contactos
      </Link>

      <ContactRecord
        clientId={client.id}
        contactId={contact.id}
        summary={{
          id: contact.id,
          displayName,
          stage: contact.stage,
          isCustomer: appointments.isCustomer,
          consent: contact.messaging_consent,
          visitCount: appointments.visitCount,
          noShowCount: appointments.noShowCount,
          preferredChannel: contact.preferred_channel,
        }}
        // Derived commercial facts (SUM/AVG/mode over completed appointments) — see
        // getContactValueProfile. Null for a contact who has never completed a visit.
        valueProfile={
          valueProfile
            ? {
                lifetimeValue: valueProfile.lifetime_value,
                completedCount: valueProfile.completed_count,
                averageTicket: valueProfile.average_ticket,
                valuePercentile: valueProfile.value_percentile,
                usualStaffName: valueProfile.usual_staff_name,
                usualServiceName: valueProfile.usual_service_name,
                avgDaysBetweenVisits: valueProfile.avg_days_between_visits,
              }
            : null
        }
        // The last COMPLETED visit — not last_contact_at, which a message also bumps. The
        // header says "última hace 4 d" about the chair, not about the chat.
        lastVisitAt={
          appointments.past.reduce<string | null>(
            (latest, a) => (latest === null || a.startAt > latest ? a.startAt : latest),
            null,
          )
        }
        identities={identityViews}
        candidates={candidates.map((c) => ({
          id: c.id,
          contactIdKeep: c.contact_id_keep,
          keepName: c.keep_name,
          keepRef: c.keep_ref,
          contactIdDuplicate: c.contact_id_duplicate,
          dupName: c.dup_name,
          dupRef: c.dup_ref,
        }))}
        canManageDuplicates={canDeleteContacts}
        canEditFieldDefs={canFields}
        canManageTags={canTags}
        // READ values come from the SAME payload the drawer edits, so the two modes
        // cannot show different facts about the same contact.
        properties={{
          name: contact.name,
          phones: editPayload?.initial.phones ?? [],
          emails: editPayload?.initial.emails ?? [],
          ownerLabel: ownerName,
          stage: contact.stage,
          preferredChannel: contact.preferred_channel,
          doNotContact: contact.do_not_contact,
          consent: contact.messaging_consent,
          consentUpdatedAt: contact.consent_updated_at?.toISOString() ?? null,
          consentSource: contact.consent_source,
          customFields: (contact.custom_fields ?? {}) as Record<string, unknown>,
          tags: attachedTags.map((t) => ({ id: t.id, name: t.name, color: t.color })),
        }}
        source={contact.channel}
        createdAt={contact.created_at.toISOString()}
        members={assignableMembers}
        ownerName={ownerName}
        fieldDefs={fieldDefs.map((d) => ({ id: d.id, key: d.key, label: d.label, type: d.type, options: d.options }))}
        timelineItems={timeline.items.map((it) => ({
          id: it.id, kind: it.kind, occurred_at: it.occurred_at, actor: it.actor, summary: it.summary, ref: it.ref, meta: it.meta,
        }))}
        timelineCursor={timeline.nextCursor}
        appointments={appointments}
        openTasks={openTasks.map(toTaskView)}
        tags={attachedTags.map((t) => ({ id: t.id, name: t.name, color: t.color }))}
        tagCatalogue={tagCatalogue.map((t) => ({ id: t.id, name: t.name, color: t.color }))}
        viewerUserId={scope.userId}
        viewerIsFullAccess={manageOthers}
        mostRecentConversationId={conversations[0]?.id ?? null}
        schedulingEnabled={schedulingEnabled}
        edit={editPayload}
        originDetail={
          originDetail
            ? {
                originKind: originDetail.originKind,
                originSetAt: originDetail.originSetAt?.toISOString() ?? null,
                originSetBy: originDetail.originSetBy,
                ad: originDetail.ad
                  ? { externalId: originDetail.ad.externalId, sourceType: originDetail.ad.sourceType, headline: originDetail.ad.headline }
                  : null,
                campaign: originDetail.campaign,
                touches: originDetail.touches.map((t) => ({
                  occurredAt: t.occurredAt.toISOString(),
                  adExternalId: t.adExternalId,
                  adHeadline: t.adHeadline,
                  sourceType: t.sourceType,
                })),
              }
            : null
        }
        canManageOrigin={can(scope, "campaigns.manage", client.id)}
        originCampaigns={campaigns.map((c) => ({ id: c.id, name: c.name }))}
        pipeline={pipeline}
      />
    </main>
  );
}

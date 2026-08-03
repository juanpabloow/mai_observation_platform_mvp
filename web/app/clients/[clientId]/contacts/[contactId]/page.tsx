import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { requireClientModulePage } from "@/lib/clientModuleAccess";
import { hasFullAccess } from "@/lib/access";
import { isUuid } from "@/lib/clientModuleValidation";
import { getContactById, listContactConversations } from "@worker/db/repositories/contacts.js";
import { listIdentitiesForContact, listCandidatesForContact } from "@worker/db/repositories/contactIdentities.js";
import { listFieldDefinitions } from "@worker/db/repositories/clientFieldDefinitions.js";
import { listMembersForTenant } from "@worker/db/repositories/tenantMembers.js";
import { getContactTimeline } from "@worker/db/repositories/contactTimeline.js";
import { listTasksForContact } from "@worker/db/repositories/crmTasks.js";
import { listTagsForContact, listTags } from "@worker/db/repositories/contactTags.js";
import { listAppointmentsForContact } from "@worker/db/repositories/scheduling/appointments.js";
import { isClientModuleEnabled } from "@worker/db/repositories/clientModules.js";
import { summarizeAppointments, toTaskView } from "@/lib/contactPanel";
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
  const { scope, client } = await requireClientModulePage(clientId, "crm");
  const { from } = await searchParams;
  const tenantId = scope.tenantId;
  const fullAccess = hasFullAccess(scope);

  const contact = await getContactById(tenantId, contactId, client.id);
  if (!contact) notFound();

  const [identities, fieldDefs, members, timeline, openTasks, attachedTags, tagCatalogue, appts, conversations, schedulingEnabled, candidates] =
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
      fullAccess ? listCandidatesForContact(tenantId, client.id, contactId) : Promise.resolve([]),
    ]);

  const identityViews: IdentityView[] = identities.map((i) => ({ kind: i.kind, value: i.value, label: i.label }));
  const appointments = summarizeAppointments(appts);
  const displayName = contactDisplayName(contact.name, identityViews, contact.channel_user_id);

  // Owner/admin may assign to any user with client access; a member only to themselves.
  const assignableMembers = members
    .filter((m) => (fullAccess ? m.member_client_id === null || m.member_client_id === client.id : m.user_id === scope.userId))
    .map((m) => ({ userId: m.user_id, email: m.email, name: m.name }));
  const ownerName = contact.assigned_to
    ? members.find((m) => m.user_id === contact.assigned_to)?.name ?? members.find((m) => m.user_id === contact.assigned_to)?.email ?? null
    : null;

  const fromQS = from ? `?from=${encodeURIComponent(from)}` : "";

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-5 px-6 py-6">
      <Link href={`/clients/${client.id}/contacts${fromQS}`} className="text-sm text-muted hover:text-foreground">
        ← Contacts
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
        }}
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
        canManageDuplicates={fullAccess}
        canEditFieldDefs={fullAccess}
        canManageTags={fullAccess}
        properties={{
          name: contact.name,
          stage: contact.stage,
          assignedTo: contact.assigned_to,
          consent: contact.messaging_consent,
          consentSource: contact.consent_source,
          source: contact.channel,
          createdAt: contact.created_at.toISOString(),
          customFields: contact.custom_fields ?? {},
        }}
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
        viewerIsFullAccess={fullAccess}
        mostRecentConversationId={conversations[0]?.id ?? null}
        schedulingEnabled={schedulingEnabled}
      />
    </main>
  );
}

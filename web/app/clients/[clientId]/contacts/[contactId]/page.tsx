import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { requireClientModulePage } from "@/lib/clientModuleAccess";
import { hasFullAccess } from "@/lib/access";
import { isUuid } from "@/lib/clientModuleValidation";
import { getContactById } from "@worker/db/repositories/contacts.js";
import { listIdentitiesForContact } from "@worker/db/repositories/contactIdentities.js";
import { listFieldDefinitions } from "@worker/db/repositories/clientFieldDefinitions.js";
import { listMembersForTenant } from "@worker/db/repositories/tenantMembers.js";
import { getContactTimeline } from "@worker/db/repositories/contactTimeline.js";
import { listTasksForContact } from "@worker/db/repositories/crmTasks.js";
import { listTagsForContact, listTags } from "@worker/db/repositories/contactTags.js";
import { ContactDetail } from "@/components/contacts/ContactDetail";
import { ContactActivity } from "@/components/contacts/ContactActivity";

/**
 * Client-scoped contact detail. C-3 replaced the old read-only tabs with the edit form
 * (<ContactDetail/>) + a unified <ContactActivity/> (timeline + notes + tasks + tags).
 * This whole record UI is TEMPORARY C-3 scaffolding — C-4 redesigns it against an
 * approved mockup. Gated by the `crm` module resolver (404 for foreign/default/disabled).
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

  const [identities, fieldDefs, members, timeline, openTasks, attachedTags, tagCatalogue] = await Promise.all([
    listIdentitiesForContact(tenantId, contactId, client.id),
    listFieldDefinitions(tenantId, client.id, { enabledOnly: true }),
    listMembersForTenant(tenantId),
    getContactTimeline(tenantId, client.id, contactId, {}),
    listTasksForContact(tenantId, client.id, contactId, { status: "open" }),
    listTagsForContact(tenantId, client.id, contactId),
    listTags(tenantId, client.id),
  ]);

  // Owner/admin may assign to any user with client access; a member only to themselves.
  const assignableMembers = members
    .filter((m) => (fullAccess ? m.member_client_id === null || m.member_client_id === client.id : m.user_id === scope.userId))
    .map((m) => ({ user_id: m.user_id, email: m.email, name: m.name }));

  const fromQS = from ? `?from=${encodeURIComponent(from)}` : "";

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-6 py-6">
      <Link href={`/clients/${client.id}/contacts${fromQS}`} className="text-sm text-muted hover:text-foreground">
        ← Contacts
      </Link>

      <ContactDetail
        clientId={client.id}
        contact={{
          id: contact.id,
          name: contact.name,
          channel: contact.channel,
          channel_user_id: contact.channel_user_id,
          phone_e164: contact.phone_e164,
          email: contact.email,
          stage: contact.stage,
          bot_human_mode: contact.bot_human_mode,
          message_count: contact.message_count,
          is_customer: contact.stage === "customer",
          messaging_consent: contact.messaging_consent,
          consent_source: contact.consent_source,
          assigned_to: contact.assigned_to,
          custom_fields: contact.custom_fields ?? {},
        }}
        identities={identities.map((i) => ({ kind: i.kind, value: i.value, label: i.label }))}
        assignableMembers={assignableMembers}
        fieldDefs={fieldDefs.map((d) => ({ id: d.id, key: d.key, label: d.label, type: d.type, options: d.options }))}
      />

      <ContactActivity
        clientId={client.id}
        contactId={contact.id}
        canManageTags={fullAccess}
        assignableMembers={assignableMembers}
        initialItems={timeline.items.map((it) => ({
          id: it.id, kind: it.kind, occurred_at: it.occurred_at, actor: it.actor, summary: it.summary, ref: it.ref, meta: it.meta,
        }))}
        initialCursor={timeline.nextCursor}
        openTasks={openTasks.map((t) => ({
          id: t.id, title: t.title, status: t.status, due_at: t.due_at ? t.due_at.toISOString() : null, assignee_name: t.assignee_name,
        }))}
        attachedTags={attachedTags.map((t) => ({ id: t.id, name: t.name, color: t.color }))}
        tagCatalogue={tagCatalogue.map((t) => ({ id: t.id, name: t.name, color: t.color }))}
      />
    </main>
  );
}

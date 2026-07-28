import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { requireClientModulePage } from "@/lib/clientModuleAccess";
import { isUuid } from "@/lib/clientModuleValidation";
import { hasFullAccess } from "@/lib/access";
import { canEditNote, canManageTask } from "@/lib/crmPermissions";
import { getContactById, listContactConversations } from "@worker/db/repositories/contacts.js";
import { listAppointmentsForContact } from "@worker/db/repositories/scheduling/appointments.js";
import { isClientModuleEnabled } from "@worker/db/repositories/clientModules.js";
import { listMembersForTenant } from "@worker/db/repositories/tenantMembers.js";
import { listNotesForContact } from "@worker/db/repositories/contactNotes.js";
import { listTasksForContact } from "@worker/db/repositories/crmTasks.js";
import { listTags, listTagsForContact } from "@worker/db/repositories/contactTags.js";
import { getContactTimeline } from "@worker/db/repositories/contactTimeline.js";
import { ContactDetail } from "@/components/contacts/ContactDetail";
import type { ContactTab } from "@/components/crm/types";

/**
 * Client-scoped contact detail (operational CRM). Gated by the central `crm`
 * resolver (404 for foreign/default/disabled/missing); contactId is UUID-validated
 * BEFORE any query, and every child read carries the VALIDATED client.id (read-side
 * defense — a mislinked cross-client conversation/appointment/note never surfaces).
 * The 5 tabs (Overview/Timeline/Conversations/Appointments/Tasks) preserve `?from=`
 * and `?tab=`. Owner/admin get full edit; a member sees stage/owner read-only and
 * only manages their own notes/tasks — decided HERE on the server and passed down.
 */
const TAB_ALIASES: Record<string, ContactTab> = {
  overview: "overview",
  timeline: "timeline",
  conversations: "conversations",
  appointments: "appointments",
  tasks: "tasks",
  // legacy links from before the CRM redesign
  data: "overview",
  activity: "timeline",
};

export default async function ClientContactDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ clientId: string; contactId: string }>;
  searchParams: Promise<{ from?: string; tab?: string }>;
}) {
  await connection();
  const { clientId, contactId } = await params;
  if (!isUuid(contactId)) notFound();
  const { scope, client } = await requireClientModulePage(clientId, "crm");
  const { from, tab } = await searchParams;
  const tenantId = scope.tenantId;
  const initialTab: ContactTab = TAB_ALIASES[tab ?? ""] ?? "overview";
  const canFullAccess = hasFullAccess(scope);
  const actor = { role: scope.role, userId: scope.userId };

  // ALWAYS client-scoped (also for owner/admin): another client's contact → 404.
  const contact = await getContactById(tenantId, contactId, client.id);
  if (!contact) notFound();

  const [conversations, appointments, schedulingEnabled, notes, tasks, contactTags, tagCatalog, timeline, members] =
    await Promise.all([
      listContactConversations(tenantId, contactId, client.id),
      listAppointmentsForContact(tenantId, contactId, client.id),
      isClientModuleEnabled(tenantId, client.id, "scheduling"),
      listNotesForContact(tenantId, client.id, contactId),
      listTasksForContact(tenantId, client.id, contactId),
      listTagsForContact(tenantId, client.id, contactId),
      listTags(tenantId, client.id),
      getContactTimeline(tenantId, client.id, contactId, {}),
      listMembersForTenant(tenantId),
    ]);

  const isCustomer = appointments.some((a) => a.status === "completed");
  const fromQS = from ? `?from=${encodeURIComponent(from)}` : "";

  // Assignable members: owner/admin (no client scope) + members bound to THIS client.
  const assignable = members
    .filter((m) => m.member_client_id === null || m.member_client_id === client.id)
    .map((m) => ({ userId: m.user_id, name: m.name ?? m.email, role: m.role }));

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-4 px-6 py-6">
      <Link href={`/clients/${client.id}/contacts${fromQS}`} className="text-sm text-muted hover:text-foreground">
        ← Contacts
      </Link>
      <ContactDetail
        clientId={client.id}
        initialTab={initialTab}
        canFullAccess={canFullAccess}
        members={assignable}
        agendaHref={schedulingEnabled ? `/clients/${client.id}/scheduling/agenda${fromQS}` : null}
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
          is_customer: isCustomer,
          assigned_to: contact.assigned_to,
          assignee_name: assignable.find((m) => m.userId === contact.assigned_to)?.name ?? null,
        }}
        tagCatalog={tagCatalog.map((t) => ({ id: t.id, name: t.name, color: t.color }))}
        contactTags={contactTags.map((t) => ({ id: t.id, name: t.name, color: t.color }))}
        notes={notes.map((n) => ({
          id: n.id,
          body: n.body,
          authorName: n.author_name,
          createdAt: n.created_at.toISOString(),
          updatedAt: n.updated_at.toISOString(),
          canManage: canEditNote(actor, n),
        }))}
        tasks={tasks.map((t) => ({
          id: t.id,
          title: t.title,
          description: t.description,
          status: t.status,
          priority: t.priority,
          dueAt: t.due_at ? t.due_at.toISOString() : null,
          assignedTo: t.assigned_to_user_id,
          assigneeName: t.assignee_name,
          canManage: canManageTask(actor, t),
        }))}
        conversations={conversations.map((c) => ({
          id: c.id,
          workflow_ref: c.n8n_workflow_id,
          conversation_ref: c.conversation_ref,
          mode: c.mode,
          last_message_at: c.last_message_at ? new Date(c.last_message_at).toISOString() : null,
        }))}
        appointments={appointments.map((a) => ({
          id: a.id,
          service_name: a.service_name_snapshot,
          staff_name: a.staff_name,
          site_name: a.site_name,
          start_at: a.start_at.toISOString(),
          status: a.status,
          origin: a.origin,
        }))}
        timelineItems={timeline.items.map((i) => ({
          id: i.id,
          type: i.type,
          occurredAt: i.occurredAt.toISOString(),
          title: i.title,
          summary: i.summary,
          actorName: i.actorName,
          sourceId: i.sourceId,
          sourceType: i.sourceType,
        }))}
        timelineCursor={timeline.nextCursor}
      />
    </main>
  );
}

import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { requireFullAccessOrLand } from "@/lib/access";
import { getContactById, listContactConversations } from "@worker/db/repositories/contacts.js";
import { listAppointmentsForContact, listEventsForContact } from "@worker/db/repositories/scheduling/appointments.js";
import { ContactDetail } from "@/components/contacts/ContactDetail";

/**
 * Contact detail (owner/admin, tenant-scoped) with Data / Conversations /
 * Appointments / Activity sections. All data loaded server-side; the ContactDetail
 * client handles tab switching + the edit form.
 */
export default async function ContactDetailPage({
  params,
}: {
  params: Promise<{ contactId: string }>;
}) {
  await connection();
  const { tenantId } = await requireFullAccessOrLand();
  const { contactId } = await params;

  const contact = await getContactById(tenantId, contactId);
  if (!contact) notFound();

  const [conversations, appointments, activity] = await Promise.all([
    listContactConversations(tenantId, contactId),
    listAppointmentsForContact(tenantId, contactId),
    listEventsForContact(tenantId, contactId),
  ]);

  const isCustomer = appointments.some((a) => a.status === "completed");

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-4 px-6 py-6">
      <Link href="/contacts" className="text-sm text-muted hover:text-foreground">← Contacts</Link>
      <ContactDetail
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
        }}
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
        activity={activity.map((e) => ({
          id: e.id,
          event_type: e.event_type,
          actor_type: e.actor_type,
          created_at: e.created_at.toISOString(),
          detail: e.detail,
        }))}
      />
    </main>
  );
}

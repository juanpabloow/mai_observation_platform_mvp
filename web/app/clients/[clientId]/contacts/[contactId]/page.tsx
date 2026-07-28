import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { requireClientModulePage } from "@/lib/clientModuleAccess";
import { isUuid } from "@/lib/clientModuleValidation";
import { getContactById, listContactConversations } from "@worker/db/repositories/contacts.js";
import { listAppointmentsForContact, listEventsForContact } from "@worker/db/repositories/scheduling/appointments.js";
import { isClientModuleEnabled } from "@worker/db/repositories/clientModules.js";
import { ContactDetail } from "@/components/contacts/ContactDetail";

/**
 * Client-scoped contact detail (Phase 3A — the canonical route). Gated by the
 * central `crm` resolver (404 for foreign/default/disabled/missing); contactId
 * is UUID-validated BEFORE any query, and the contact is fetched WITH the
 * validated clientId — a contact belonging to another client 404s. The Agenda
 * link renders only when `scheduling` is also enabled for this client. `from`
 * survives into the back link.
 */
const TABS = ["data", "conversations", "appointments", "activity"] as const;
type Tab = (typeof TABS)[number];

export default async function ClientContactDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ clientId: string; contactId: string }>;
  searchParams: Promise<{ from?: string; tab?: string }>;
}) {
  await connection();
  const { clientId, contactId } = await params;
  // Malformed contactId → 404 before PostgreSQL (the client gate validates its own id).
  if (!isUuid(contactId)) notFound();
  const { scope, client } = await requireClientModulePage(clientId, "crm");
  const { from, tab } = await searchParams;
  const tenantId = scope.tenantId;
  // ?tab= opens the matching section (AgendaView links tab=conversations);
  // anything unknown falls back to "data".
  const initialTab: Tab = (TABS as readonly string[]).includes(tab ?? "") ? (tab as Tab) : "data";

  // ALWAYS client-scoped (also for owner/admin): another client's contact → 404.
  const contact = await getContactById(tenantId, contactId, client.id);
  if (!contact) notFound();

  // Every child read carries client.id too (READ-SIDE DEFENSE): a conversation
  // whose canonical workflow lives in another client, or an appointment/event of
  // another client, never renders here even if it was mislinked to this contact.
  const [conversations, appointments, activity, schedulingEnabled] = await Promise.all([
    listContactConversations(tenantId, contactId, client.id),
    listAppointmentsForContact(tenantId, contactId, client.id),
    listEventsForContact(tenantId, contactId, client.id),
    isClientModuleEnabled(tenantId, client.id, "scheduling"),
  ]);

  const isCustomer = appointments.some((a) => a.status === "completed");
  const fromQS = from ? `?from=${encodeURIComponent(from)}` : "";

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-4 px-6 py-6">
      <Link href={`/clients/${client.id}/contacts${fromQS}`} className="text-sm text-muted hover:text-foreground">
        ← Contacts
      </Link>
      <ContactDetail
        clientId={client.id}
        initialTab={initialTab}
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

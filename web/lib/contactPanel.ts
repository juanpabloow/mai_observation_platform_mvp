import "server-only";
import { getContactById, listContactConversations } from "@worker/db/repositories/contacts.js";
import { listIdentitiesForContact } from "@worker/db/repositories/contactIdentities.js";
import { listAppointmentsForContact, type AppointmentListItem } from "@worker/db/repositories/scheduling/appointments.js";
import { listTasksForContact } from "@worker/db/repositories/crmTasks.js";
import { listNotesForContact } from "@worker/db/repositories/contactNotes.js";
import { listTagsForContact, listTags } from "@worker/db/repositories/contactTags.js";
import { listFieldDefinitions } from "@worker/db/repositories/clientFieldDefinitions.js";
import { listMembersForTenant } from "@worker/db/repositories/tenantMembers.js";
import type { FieldDefView } from "@/components/contacts/ContactProperties";
import {
  contactDisplayName,
  type AppointmentSummary,
  type AppointmentView,
  type ContactEditInitial,
  type ContactSummary,
  type IdentityView,
  type NoteView,
  type TagView,
  type TaskView,
} from "./contactShared";

/**
 * Server-side loaders that assemble the SERIALIZABLE contact-panel payloads shared by
 * the full record and the compact inbox panel (C-4). Every read is scoped by
 * (tenant, client, contact) — getContactById re-scopes by client so a conversation
 * mislinked to another client's contact resolves to null (no cross-client leak).
 *
 * Appointment derivation is done HERE, once, from listAppointmentsForContact: the
 * derived "is a customer" flag + visit/no-show counts + the next/upcoming/past split are
 * NOT stored (getContactById returns a bare row) — they follow from the appointments.
 * All queries are bounded (no per-row lookups).
 */

const RECENT_NOTES = 5;

export function toAppointmentView(a: AppointmentListItem): AppointmentView {
  return {
    id: a.id,
    publicReference: a.public_reference,
    serviceName: a.service_name_snapshot,
    staffName: a.staff_name,
    startAt: a.start_at.toISOString(),
    endAt: a.service_end_at.toISOString(),
    status: a.status,
    siteTimezone: a.site_timezone,
  };
}

/** Partition a contact's appointments (start_at ASC) into next/upcoming/past + counts. */
export function summarizeAppointments(appts: AppointmentListItem[], now: Date = new Date()): AppointmentSummary {
  const nowMs = now.getTime();
  const upcomingRows: AppointmentListItem[] = [];
  const pastRows: AppointmentListItem[] = [];
  for (const a of appts) {
    const live = a.status === "scheduled" || a.status === "confirmed";
    if (live && a.start_at.getTime() >= nowMs) upcomingRows.push(a);
    else pastRows.push(a);
  }
  pastRows.reverse(); // input is ASC → most recent past first
  const visitCount = appts.filter((a) => a.status === "completed").length;
  const noShowCount = appts.filter((a) => a.status === "no_show").length;
  const upcoming = upcomingRows.map(toAppointmentView);
  return {
    next: upcoming[0] ?? null,
    upcoming,
    past: pastRows.map(toAppointmentView),
    visitCount,
    noShowCount,
    isCustomer: visitCount > 0,
  };
}

export function toNoteView(n: {
  id: string;
  body: string;
  author_name: string | null;
  created_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
}): NoteView {
  return {
    id: n.id,
    body: n.body,
    authorName: n.author_name,
    createdByUserId: n.created_by_user_id,
    createdAt: n.created_at.toISOString(),
    edited: n.updated_at.getTime() > n.created_at.getTime(),
  };
}

export function toTaskView(t: {
  id: string;
  title: string;
  due_at: Date | null;
  assignee_name: string | null;
  created_by_user_id: string | null;
  assigned_to_user_id: string | null;
}): TaskView {
  return {
    id: t.id,
    title: t.title,
    dueAt: t.due_at ? t.due_at.toISOString() : null,
    assigneeName: t.assignee_name,
    createdByUserId: t.created_by_user_id,
    assignedToUserId: t.assigned_to_user_id,
  };
}

/** Non-empty, case-insensitively unique, order preserved. */
function dedupeValues(values: Array<string | null>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of values) {
    const t = v?.trim();
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  return out;
}

export interface ContactEditPayload {
  initial: ContactEditInitial;
  owners: Array<{ userId: string; label: string }>;
  fieldDefs: FieldDefView[];
  tags: TagView[];
  tagCatalogue: TagView[];
  notes: NoteView[];
  canDelete: boolean;
  canManageTagCatalog: boolean;
}

/**
 * THE contact-edit payload, built in ONE place for BOTH doors — the record header and
 * the list's customer panel.
 *
 * This function exists because there used to be two editors. The list panel opened a
 * small modal that knew about one email and one phone; the record opened something
 * else. That is how a contact with two addresses ended up with one of them invisible
 * and silently overwritable. One loader means the two entry points cannot disagree
 * about what a contact IS, only about where the button sits.
 *
 * IDENTITIES COME FROM BOTH SURFACES. contact_identities is the canonical spine, but
 * most rows on a real database predate it and carry only the scalar phone_e164 / email
 * (4 of 5 on the dev database). Reading the spine alone told the drawer that a contact
 * with a perfectly good number had no way to be reached at all, which tripped the
 * "at least one" guard and blocked every save. Same merge the panel already does.
 *
 * Returns null for a missing OR cross-client contact (indistinguishable, deliberately).
 */
export async function loadContactEditPayload(
  tenantId: string,
  clientId: string,
  contactId: string,
  viewer: { userId: string; isFullAccess: boolean },
): Promise<ContactEditPayload | null> {
  const contact = await getContactById(tenantId, contactId, clientId);
  if (!contact) return null;

  const [identities, fieldDefs, members, tags, tagCatalogue, notes, appts, conversations] = await Promise.all([
    listIdentitiesForContact(tenantId, clientId, contactId),
    listFieldDefinitions(tenantId, clientId, { enabledOnly: true }),
    listMembersForTenant(tenantId),
    listTagsForContact(tenantId, clientId, contactId),
    listTags(tenantId, clientId),
    listNotesForContact(tenantId, clientId, contactId),
    listAppointmentsForContact(tenantId, contactId, clientId),
    listContactConversations(tenantId, contactId, clientId),
  ]);

  const identityViews: IdentityView[] = identities.map((i) => ({ kind: i.kind, value: i.value, label: i.label }));

  // Owner options: owner/admin may assign anyone with access to this client; a member
  // only themselves. The server action re-checks this — here it only shapes the picker.
  const owners = members
    .filter((m) => (viewer.isFullAccess ? m.member_client_id === null || m.member_client_id === clientId : m.user_id === viewer.userId))
    .map((m) => ({ userId: m.user_id, label: m.name ?? m.email }));

  return {
    initial: {
      contactId: contact.id,
      displayName: contactDisplayName(contact.name, identityViews, contact.channel_user_id),
      name: contact.name,
      stage: contact.stage,
      // Same derivation the record and the panel use — computed once, from the
      // appointments this loader already read.
      isCustomer: appts.some((a) => a.status === 'completed'),
      assignedTo: contact.assigned_to,
      preferredChannel: contact.preferred_channel,
      doNotContact: contact.do_not_contact,
      consent: contact.messaging_consent,
      consentUpdatedAt: contact.consent_updated_at?.toISOString() ?? null,
      consentSource: contact.consent_source,
      customFields: (contact.custom_fields ?? {}) as Record<string, unknown>,
      createdAt: contact.created_at.toISOString(),
      lastContactAt: contact.last_contact_at.toISOString(),
      // Derived from what was just loaded, so the header count and the page can never
      // disagree — a stored counter could.
      activityCount: appts.length + conversations.length + notes.length,
      sourceChannel: contact.channel,
      phones: dedupeValues([...identityViews.filter((i) => i.kind === "phone").map((i) => i.value), contact.phone_e164]),
      emails: dedupeValues([...identityViews.filter((i) => i.kind === "email").map((i) => i.value), contact.email]),
    },
    owners,
    fieldDefs: fieldDefs.map((d) => ({ id: d.id, key: d.key, label: d.label, type: d.type, options: d.options })),
    tags: tags.map((t) => ({ id: t.id, name: t.name, color: t.color })),
    tagCatalogue: tagCatalogue.map((t) => ({ id: t.id, name: t.name, color: t.color })),
    notes: notes.map(toNoteView),
    // Deleting a person and extending the tag catalogue are both owner/admin, matching
    // how merge and the field definitions are already gated.
    canDelete: viewer.isFullAccess,
    canManageTagCatalog: viewer.isFullAccess,
  };
}

export interface ContactPanelData {
  summary: ContactSummary;
  identities: IdentityView[];
  appointments: AppointmentSummary;
  openTasks: TaskView[];
  recentNotes: NoteView[];
  tags: TagView[];
}

/**
 * Compact payload for the inbox customer panel: identity summary, next appointment,
 * open tasks, most-recent notes, tags. Returns null when the contact isn't found under
 * this client (missing OR cross-client — indistinguishable). Bounded queries only.
 */
export async function loadContactPanel(
  tenantId: string,
  clientId: string,
  contactId: string,
): Promise<ContactPanelData | null> {
  const contact = await getContactById(tenantId, contactId, clientId);
  if (!contact) return null;

  const [identities, appts, openTasks, notes, tags] = await Promise.all([
    listIdentitiesForContact(tenantId, clientId, contactId),
    listAppointmentsForContact(tenantId, contactId, clientId),
    listTasksForContact(tenantId, clientId, contactId, { status: "open" }),
    listNotesForContact(tenantId, clientId, contactId),
    listTagsForContact(tenantId, clientId, contactId),
  ]);

  // IDENTITIES + the contact's OWN columns. `contact_identities` is the canonical
  // spine, but `contacts.email` / `contacts.phone_e164` are still written directly
  // (the edit dialog and the CRM API both set them), so a contact can carry an email
  // that has no identity row yet. Reading only the spine made those addresses
  // invisible in the panel while the LIST column showed them — same person, two
  // answers. Merge, de-duplicated by normalised value, spine first.
  const identityViews: IdentityView[] = identities.map((i) => ({ kind: i.kind, value: i.value, label: i.label }));
  const seen = new Set(identityViews.map((i) => i.value.toLowerCase().replace(/[^a-z0-9@.]/g, "")));
  const addColumn = (kind: IdentityView["kind"], value: string | null) => {
    const v = value?.trim();
    if (!v) return;
    const key = v.toLowerCase().replace(/[^a-z0-9@.]/g, "");
    if (seen.has(key)) return;
    seen.add(key);
    identityViews.push({ kind, value: v, label: null });
  };
  addColumn("email", contact.email);
  addColumn("phone", contact.phone_e164);

  const appointments = summarizeAppointments(appts);
  const summary: ContactSummary = {
    id: contact.id,
    displayName: contactDisplayName(contact.name, identityViews, contact.channel_user_id),
    stage: contact.stage,
    isCustomer: appointments.isCustomer,
    consent: contact.messaging_consent,
    visitCount: appointments.visitCount,
    noShowCount: appointments.noShowCount,
    preferredChannel: contact.preferred_channel,
  };

  return {
    summary,
    identities: identityViews,
    appointments,
    openTasks: openTasks.map(toTaskView),
    recentNotes: notes.slice(0, RECENT_NOTES).map(toNoteView),
    tags: tags.map((t) => ({ id: t.id, name: t.name, color: t.color })),
  };
}

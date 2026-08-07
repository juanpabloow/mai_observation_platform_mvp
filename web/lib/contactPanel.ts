import "server-only";
import { getContactById } from "@worker/db/repositories/contacts.js";
import { listIdentitiesForContact } from "@worker/db/repositories/contactIdentities.js";
import { listAppointmentsForContact, type AppointmentListItem } from "@worker/db/repositories/scheduling/appointments.js";
import { listTasksForContact } from "@worker/db/repositories/crmTasks.js";
import { listNotesForContact } from "@worker/db/repositories/contactNotes.js";
import { listTagsForContact } from "@worker/db/repositories/contactTags.js";
import {
  contactDisplayName,
  type AppointmentSummary,
  type AppointmentView,
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

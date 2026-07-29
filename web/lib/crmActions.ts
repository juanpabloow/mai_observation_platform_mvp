"use server";

import { revalidatePath } from "next/cache";
import { resolveClientModuleContext } from "./clientModuleAccess";
import {
  parse,
  CreateNoteInput,
  UpdateNoteInput,
  NoteRefInput,
  CreateTaskInput,
  UpdateTaskInput,
  TaskRefInput,
  CreateTagInput,
  RenameTagInput,
  TagLinkInput,
} from "./crmValidation";
import { canEditNote, canManageTask, canManageTagCatalog, resolveAssignee, type CrmActor } from "./crmPermissions";
import { createNote, getNoteById, updateNote, softDeleteNote } from "@worker/db/repositories/contactNotes.js";
import { createTask, getTaskById, updateTask, completeTask, cancelTask } from "@worker/db/repositories/crmTasks.js";
import { createTag, renameTag, attachTag, detachTag } from "@worker/db/repositories/contactTags.js";
import { getMemberInTenant } from "@worker/db/repositories/tenantMembers.js";
import { getContactTimeline, type TimelineSource, type TimelinePage } from "@worker/db/repositories/contactTimeline.js";
import { isUuid } from "./crmValidation";

/**
 * Operational-CRM write actions (C-3): notes, tasks, tags on a contact. Every action
 * (1) validates strictly via crmValidation (bad input → 422/failure), (2) funnels
 * through the central `crm` module gate (session → canAccessClient → non-default
 * client → crm enabled; deny-by-default), (3) applies the ROLE rules in crmPermissions,
 * and (4) calls a repo that writes the entity + its crm_activity_events audit row in
 * ONE transaction. Everything is tenant + client scoped at the data layer.
 */

export type CrmResult = { ok: true; id?: string } | { ok: false; error: string };

/** Keyset "Load more" for the contact timeline (gated by the crm module + client). */
export async function loadContactTimelineAction(
  clientId: string,
  contactId: string,
  cursor: string | null,
  kinds: TimelineSource[],
): Promise<{ ok: true; page: TimelinePage } | { ok: false }> {
  if (!isUuid(contactId)) return { ok: false };
  const g = await gate(clientId);
  if (!g) return { ok: false };
  const page = await getContactTimeline(g.tenantId, g.clientId, contactId, { cursor: cursor ?? undefined, kinds, limit: 15 });
  return { ok: true, page };
}
const GENERIC = "Not found.";
const INVALID = "Invalid input.";
const DENIED = "Not allowed.";

async function gate(clientId: string): Promise<{ tenantId: string; clientId: string; actor: CrmActor } | null> {
  const resolved = await resolveClientModuleContext(clientId, "crm");
  if (!resolved.ok) return null;
  const { scope, client } = resolved.context;
  return { tenantId: scope.tenantId, clientId: client.id, actor: { role: scope.role, userId: scope.userId } };
}

/** The assignee must be a tenant member with access to THIS client (owner/admin: any;
 * member: only their own) — same rule as C-2 owner assignment. */
async function assigneeHasClientAccess(tenantId: string, clientId: string, userId: string): Promise<boolean> {
  const m = await getMemberInTenant(tenantId, userId);
  return m != null && (m.member_client_id === null || m.member_client_id === clientId);
}

function touch(clientId: string, contactId?: string) {
  revalidatePath(`/clients/${clientId}/contacts`);
  if (contactId) revalidatePath(`/clients/${clientId}/contacts/${contactId}`);
}

// ── Notes ──────────────────────────────────────────────────────────────────────
export async function addNoteAction(clientId: string, contactId: string, body: string): Promise<CrmResult> {
  const v = parse(CreateNoteInput, { clientId, contactId, body });
  if (!v.ok) return { ok: false, error: INVALID };
  const g = await gate(clientId);
  if (!g) return { ok: false, error: GENERIC };
  const row = await createNote({ tenantId: g.tenantId, clientId: g.clientId, contactId, body: v.value.body, createdByUserId: g.actor.userId });
  if (!row) return { ok: false, error: GENERIC };
  touch(g.clientId, contactId);
  return { ok: true, id: row.id };
}

export async function editNoteAction(clientId: string, noteId: string, body: string): Promise<CrmResult> {
  const v = parse(UpdateNoteInput, { clientId, noteId, body });
  if (!v.ok) return { ok: false, error: INVALID };
  const g = await gate(clientId);
  if (!g) return { ok: false, error: GENERIC };
  const note = await getNoteById(g.tenantId, g.clientId, noteId);
  if (!note) return { ok: false, error: GENERIC };
  if (!canEditNote(g.actor, note)) return { ok: false, error: DENIED };
  const row = await updateNote({ tenantId: g.tenantId, clientId: g.clientId, noteId, body: v.value.body, actorUserId: g.actor.userId });
  if (!row) return { ok: false, error: GENERIC };
  touch(g.clientId, note.contact_id);
  return { ok: true };
}

export async function deleteNoteAction(clientId: string, noteId: string): Promise<CrmResult> {
  const v = parse(NoteRefInput, { clientId, noteId });
  if (!v.ok) return { ok: false, error: INVALID };
  const g = await gate(clientId);
  if (!g) return { ok: false, error: GENERIC };
  const note = await getNoteById(g.tenantId, g.clientId, noteId);
  if (!note) return { ok: false, error: GENERIC };
  if (!canEditNote(g.actor, note)) return { ok: false, error: DENIED };
  await softDeleteNote({ tenantId: g.tenantId, clientId: g.clientId, noteId, actorUserId: g.actor.userId });
  touch(g.clientId, note.contact_id);
  return { ok: true };
}

// ── Tasks ──────────────────────────────────────────────────────────────────────
export async function createTaskAction(
  clientId: string,
  contactId: string,
  input: { title: string; description?: string | null; priority?: "low" | "normal" | "high"; dueAt?: string | null; assignedToUserId?: string | null },
): Promise<CrmResult> {
  const v = parse(CreateTaskInput, { clientId, contactId, ...input });
  if (!v.ok) return { ok: false, error: INVALID };
  const g = await gate(clientId);
  if (!g) return { ok: false, error: GENERIC };
  const decided = resolveAssignee(g.actor, v.value.assignedToUserId);
  if (!decided.ok) return { ok: false, error: DENIED };
  if (decided.assignee && !(await assigneeHasClientAccess(g.tenantId, g.clientId, decided.assignee))) {
    return { ok: false, error: "That assignee has no access to this client." };
  }
  const row = await createTask({
    tenantId: g.tenantId,
    clientId: g.clientId,
    contactId,
    title: v.value.title,
    description: v.value.description ?? null,
    priority: v.value.priority,
    dueAt: v.value.dueAt ? new Date(v.value.dueAt) : null,
    assignedToUserId: decided.assignee,
    createdByUserId: g.actor.userId,
  });
  if (!row) return { ok: false, error: GENERIC };
  touch(g.clientId, contactId);
  return { ok: true, id: row.id };
}

export async function completeTaskAction(clientId: string, taskId: string): Promise<CrmResult> {
  const v = parse(TaskRefInput, { clientId, taskId });
  if (!v.ok) return { ok: false, error: INVALID };
  const g = await gate(clientId);
  if (!g) return { ok: false, error: GENERIC };
  const task = await getTaskById(g.tenantId, g.clientId, taskId);
  if (!task) return { ok: false, error: GENERIC };
  if (!canManageTask(g.actor, task)) return { ok: false, error: DENIED };
  await completeTask({ tenantId: g.tenantId, clientId: g.clientId, taskId, actorUserId: g.actor.userId });
  touch(g.clientId, task.contact_id);
  return { ok: true };
}

export async function reassignTaskAction(clientId: string, taskId: string, assignedToUserId: string | null): Promise<CrmResult> {
  const v = parse(UpdateTaskInput, { clientId, taskId, assignedToUserId });
  if (!v.ok) return { ok: false, error: INVALID };
  const g = await gate(clientId);
  if (!g) return { ok: false, error: GENERIC };
  const task = await getTaskById(g.tenantId, g.clientId, taskId);
  if (!task) return { ok: false, error: GENERIC };
  if (!canManageTask(g.actor, task)) return { ok: false, error: DENIED };
  const decided = resolveAssignee(g.actor, v.value.assignedToUserId);
  if (!decided.ok) return { ok: false, error: DENIED };
  if (decided.assignee && !(await assigneeHasClientAccess(g.tenantId, g.clientId, decided.assignee))) {
    return { ok: false, error: "That assignee has no access to this client." };
  }
  await updateTask({ tenantId: g.tenantId, clientId: g.clientId, taskId, actorUserId: g.actor.userId, patch: { assignedToUserId: decided.assignee } });
  touch(g.clientId, task.contact_id);
  return { ok: true };
}

export async function deleteTaskAction(clientId: string, taskId: string): Promise<CrmResult> {
  const v = parse(TaskRefInput, { clientId, taskId });
  if (!v.ok) return { ok: false, error: INVALID };
  const g = await gate(clientId);
  if (!g) return { ok: false, error: GENERIC };
  const task = await getTaskById(g.tenantId, g.clientId, taskId);
  if (!task) return { ok: false, error: GENERIC };
  if (!canManageTask(g.actor, task)) return { ok: false, error: DENIED };
  await cancelTask({ tenantId: g.tenantId, clientId: g.clientId, taskId, actorUserId: g.actor.userId });
  touch(g.clientId, task.contact_id);
  return { ok: true };
}

// ── Tags ───────────────────────────────────────────────────────────────────────
export async function createTagAction(clientId: string, name: string, color: string): Promise<CrmResult> {
  const v = parse(CreateTagInput, { clientId, name, color });
  if (!v.ok) return { ok: false, error: INVALID };
  const g = await gate(clientId);
  if (!g) return { ok: false, error: GENERIC };
  if (!canManageTagCatalog(g.actor)) return { ok: false, error: DENIED };
  const r = await createTag({ tenantId: g.tenantId, clientId: g.clientId, name: v.value.name, color: v.value.color });
  if (!r.ok) return { ok: false, error: "A tag with that name already exists." };
  touch(g.clientId);
  return { ok: true, id: r.tag.id };
}

export async function renameTagAction(clientId: string, tagId: string, name?: string, color?: string): Promise<CrmResult> {
  const v = parse(RenameTagInput, { clientId, tagId, ...(name !== undefined ? { name } : {}), ...(color !== undefined ? { color } : {}) });
  if (!v.ok) return { ok: false, error: INVALID };
  const g = await gate(clientId);
  if (!g) return { ok: false, error: GENERIC };
  if (!canManageTagCatalog(g.actor)) return { ok: false, error: DENIED };
  const r = await renameTag({ tenantId: g.tenantId, clientId: g.clientId, tagId, name: v.value.name, color: v.value.color });
  if (!r || !r.ok) return { ok: false, error: GENERIC };
  touch(g.clientId);
  return { ok: true };
}

export async function attachTagAction(clientId: string, contactId: string, tagId: string): Promise<CrmResult> {
  const v = parse(TagLinkInput, { clientId, contactId, tagId });
  if (!v.ok) return { ok: false, error: INVALID };
  const g = await gate(clientId);
  if (!g) return { ok: false, error: GENERIC };
  const r = await attachTag({ tenantId: g.tenantId, clientId: g.clientId, contactId, tagId, actorUserId: g.actor.userId });
  if (!r.ok) return { ok: false, error: GENERIC };
  touch(g.clientId, contactId);
  return { ok: true };
}

export async function detachTagAction(clientId: string, contactId: string, tagId: string): Promise<CrmResult> {
  const v = parse(TagLinkInput, { clientId, contactId, tagId });
  if (!v.ok) return { ok: false, error: INVALID };
  const g = await gate(clientId);
  if (!g) return { ok: false, error: GENERIC };
  const r = await detachTag({ tenantId: g.tenantId, clientId: g.clientId, contactId, tagId, actorUserId: g.actor.userId });
  if (!r.ok) return { ok: false, error: GENERIC };
  touch(g.clientId, contactId);
  return { ok: true };
}

"use server";

import { revalidatePath } from "next/cache";
import { resolveClientModuleContext } from "./clientModuleAccess";
import {
  CreateNoteInput,
  UpdateNoteInput,
  NoteRefInput,
  CreateTaskInput,
  UpdateTaskInput,
  TaskRefInput,
  CreateTagInput,
  RenameTagInput,
  TagRefInput,
  TagLinkInput,
  ChangeOwnerInput,
  ChangeStageInput,
  TimelineQueryInput,
  parse,
} from "./crmValidation";
import {
  canChangeOwner,
  canChangeStage,
  canEditNote,
  canManageTagCatalog,
  canManageTask,
  resolveAssignee,
  type CrmActor,
} from "./crmPermissions";
import * as notes from "@worker/db/repositories/contactNotes.js";
import * as tasks from "@worker/db/repositories/crmTasks.js";
import * as tags from "@worker/db/repositories/contactTags.js";
import { changeContactOwner, changeContactStage, isTenantMember } from "@worker/db/repositories/contactCrm.js";
import { getContactTimeline } from "@worker/db/repositories/contactTimeline.js";

/**
 * Operational-CRM server actions. EVERY action funnels through `gate(clientId)`:
 *   session (getAccessScope) → client access (canAccessClient) → non-default client
 *   → `crm` module ENABLED — any failure is one GENERIC result (never leaks whether
 *   the client/contact exists cross-tenant). Then Zod-validates the payload (strict,
 *   no coercion) and applies the ROLE rules (crmPermissions). tenant_id, actor, and
 *   permissions are NEVER taken from the browser — only clientId + entity ids +
 *   content are, and those are validated against the session scope + the DB.
 */

export type CrmResult<T = void> = { ok: true; value?: T } | { ok: false; error: string };
const ERR_GENERIC = "Not available.";
const ERR_INVALID = "Invalid request.";
const ERR_FORBIDDEN = "You don't have permission to do that.";
const GENERIC: CrmResult = { ok: false, error: ERR_GENERIC };
const INVALID: CrmResult = { ok: false, error: ERR_INVALID };
const FORBIDDEN: CrmResult = { ok: false, error: ERR_FORBIDDEN };

type Gate = { tenantId: string; clientId: string; actor: CrmActor };

async function gate(clientId: string): Promise<Gate | null> {
  const res = await resolveClientModuleContext(clientId, "crm");
  if (!res.ok) return null;
  const { scope, client } = res.context;
  return { tenantId: scope.tenantId, clientId: client.id, actor: { role: scope.role, userId: scope.userId } };
}

function revalidateContact(clientId: string, contactId: string): void {
  revalidatePath(`/clients/${clientId}/contacts/${contactId}`);
  revalidatePath(`/clients/${clientId}/contacts`);
}

// ── Notes ──────────────────────────────────────────────────────────────────────

export async function createNoteAction(input: unknown): Promise<CrmResult> {
  const p = parse(CreateNoteInput, input);
  if (!p.ok) return INVALID;
  const g = await gate(p.value.clientId);
  if (!g) return GENERIC;
  const note = await notes.createNote({
    tenantId: g.tenantId,
    clientId: g.clientId,
    contactId: p.value.contactId,
    body: p.value.body,
    createdByUserId: g.actor.userId,
  });
  if (!note) return GENERIC;
  revalidateContact(g.clientId, p.value.contactId);
  return { ok: true };
}

export async function updateNoteAction(input: unknown): Promise<CrmResult> {
  const p = parse(UpdateNoteInput, input);
  if (!p.ok) return INVALID;
  const g = await gate(p.value.clientId);
  if (!g) return GENERIC;
  const existing = await notes.getNoteById(g.tenantId, g.clientId, p.value.noteId);
  if (!existing) return GENERIC;
  if (!canEditNote(g.actor, existing)) return FORBIDDEN;
  const updated = await notes.updateNote({
    tenantId: g.tenantId,
    clientId: g.clientId,
    noteId: p.value.noteId,
    body: p.value.body,
    actorUserId: g.actor.userId,
  });
  if (!updated) return GENERIC;
  revalidateContact(g.clientId, updated.contact_id);
  return { ok: true };
}

export async function deleteNoteAction(input: unknown): Promise<CrmResult> {
  const p = parse(NoteRefInput, input);
  if (!p.ok) return INVALID;
  const g = await gate(p.value.clientId);
  if (!g) return GENERIC;
  const existing = await notes.getNoteById(g.tenantId, g.clientId, p.value.noteId);
  if (!existing) return GENERIC;
  if (!canEditNote(g.actor, existing)) return FORBIDDEN;
  const removed = await notes.softDeleteNote({
    tenantId: g.tenantId,
    clientId: g.clientId,
    noteId: p.value.noteId,
    actorUserId: g.actor.userId,
  });
  if (!removed) return GENERIC;
  revalidateContact(g.clientId, existing.contact_id);
  return { ok: true };
}

// ── Tasks ──────────────────────────────────────────────────────────────────────

export async function createTaskAction(input: unknown): Promise<CrmResult> {
  const p = parse(CreateTaskInput, input);
  if (!p.ok) return INVALID;
  const g = await gate(p.value.clientId);
  if (!g) return GENERIC;
  const assign = resolveAssignee(g.actor, p.value.assignedToUserId ?? null);
  if (!assign.ok) return FORBIDDEN;
  if (assign.assignee && !(await isTenantMember(g.tenantId, assign.assignee))) return INVALID;
  const task = await tasks.createTask({
    tenantId: g.tenantId,
    clientId: g.clientId,
    contactId: p.value.contactId,
    title: p.value.title,
    description: p.value.description ?? null,
    priority: p.value.priority,
    dueAt: p.value.dueAt ? new Date(p.value.dueAt) : null,
    assignedToUserId: assign.assignee,
    createdByUserId: g.actor.userId,
  });
  if (!task) return GENERIC;
  revalidateContact(g.clientId, p.value.contactId);
  return { ok: true };
}

export async function updateTaskAction(input: unknown): Promise<CrmResult> {
  const p = parse(UpdateTaskInput, input);
  if (!p.ok) return INVALID;
  const g = await gate(p.value.clientId);
  if (!g) return GENERIC;
  const existing = await tasks.getTaskById(g.tenantId, g.clientId, p.value.taskId);
  if (!existing) return GENERIC;
  if (!canManageTask(g.actor, existing)) return FORBIDDEN;
  const patch: Parameters<typeof tasks.updateTask>[0]["patch"] = {};
  if (p.value.title !== undefined) patch.title = p.value.title;
  if (p.value.description !== undefined) patch.description = p.value.description;
  if (p.value.priority !== undefined) patch.priority = p.value.priority;
  if (p.value.dueAt !== undefined) patch.dueAt = p.value.dueAt ? new Date(p.value.dueAt) : null;
  if (p.value.assignedToUserId !== undefined) {
    const assign = resolveAssignee(g.actor, p.value.assignedToUserId);
    if (!assign.ok) return FORBIDDEN;
    if (assign.assignee && !(await isTenantMember(g.tenantId, assign.assignee))) return INVALID;
    patch.assignedToUserId = assign.assignee;
  }
  const updated = await tasks.updateTask({ tenantId: g.tenantId, clientId: g.clientId, taskId: p.value.taskId, actorUserId: g.actor.userId, patch });
  if (!updated) return GENERIC;
  revalidateContact(g.clientId, updated.contact_id);
  return { ok: true };
}

async function taskTransition(
  input: unknown,
  op: (a: { tenantId: string; clientId: string; taskId: string; actorUserId: string }) => Promise<{ contact_id: string } | null>,
): Promise<CrmResult> {
  const p = parse(TaskRefInput, input);
  if (!p.ok) return INVALID;
  const g = await gate(p.value.clientId);
  if (!g) return GENERIC;
  const existing = await tasks.getTaskById(g.tenantId, g.clientId, p.value.taskId);
  if (!existing) return GENERIC;
  if (!canManageTask(g.actor, existing)) return FORBIDDEN;
  const r = await op({ tenantId: g.tenantId, clientId: g.clientId, taskId: p.value.taskId, actorUserId: g.actor.userId });
  if (!r) return GENERIC;
  revalidateContact(g.clientId, r.contact_id);
  return { ok: true };
}
// Server Actions must be `async function` declarations (Next.js constraint), so
// these thin wrappers can't be arrow consts.
export async function completeTaskAction(input: unknown): Promise<CrmResult> {
  return taskTransition(input, tasks.completeTask);
}
export async function reopenTaskAction(input: unknown): Promise<CrmResult> {
  return taskTransition(input, tasks.reopenTask);
}
export async function cancelTaskAction(input: unknown): Promise<CrmResult> {
  return taskTransition(input, tasks.cancelTask);
}

// ── Tags ─────────────────────────────────────────────────────────────────────

export async function createTagAction(input: unknown): Promise<CrmResult> {
  const p = parse(CreateTagInput, input);
  if (!p.ok) return INVALID;
  const g = await gate(p.value.clientId);
  if (!g) return GENERIC;
  if (!canManageTagCatalog(g.actor)) return FORBIDDEN;
  const r = await tags.createTag({ tenantId: g.tenantId, clientId: g.clientId, name: p.value.name, color: p.value.color });
  if (!r.ok) return { ok: false, error: "A tag with that name already exists." };
  revalidatePath(`/clients/${g.clientId}/contacts`);
  return { ok: true };
}

export async function renameTagAction(input: unknown): Promise<CrmResult> {
  const p = parse(RenameTagInput, input);
  if (!p.ok) return INVALID;
  const g = await gate(p.value.clientId);
  if (!g) return GENERIC;
  if (!canManageTagCatalog(g.actor)) return FORBIDDEN;
  const r = await tags.renameTag({ tenantId: g.tenantId, clientId: g.clientId, tagId: p.value.tagId, name: p.value.name, color: p.value.color });
  if (!r) return GENERIC;
  if (!r.ok) return { ok: false, error: "A tag with that name already exists." };
  revalidatePath(`/clients/${g.clientId}/contacts`);
  return { ok: true };
}

export async function deleteTagAction(input: unknown): Promise<CrmResult> {
  const p = parse(TagRefInput, input);
  if (!p.ok) return INVALID;
  const g = await gate(p.value.clientId);
  if (!g) return GENERIC;
  if (!canManageTagCatalog(g.actor)) return FORBIDDEN;
  await tags.deleteTag(g.tenantId, g.clientId, p.value.tagId);
  revalidatePath(`/clients/${g.clientId}/contacts`);
  return { ok: true };
}

export async function attachTagAction(input: unknown): Promise<CrmResult> {
  const p = parse(TagLinkInput, input);
  if (!p.ok) return INVALID;
  const g = await gate(p.value.clientId);
  if (!g) return GENERIC;
  const r = await tags.attachTag({ tenantId: g.tenantId, clientId: g.clientId, contactId: p.value.contactId, tagId: p.value.tagId, actorUserId: g.actor.userId });
  if (!r.ok) return GENERIC;
  revalidateContact(g.clientId, p.value.contactId);
  return { ok: true };
}

export async function detachTagAction(input: unknown): Promise<CrmResult> {
  const p = parse(TagLinkInput, input);
  if (!p.ok) return INVALID;
  const g = await gate(p.value.clientId);
  if (!g) return GENERIC;
  const r = await tags.detachTag({ tenantId: g.tenantId, clientId: g.clientId, contactId: p.value.contactId, tagId: p.value.tagId, actorUserId: g.actor.userId });
  if (!r.ok) return GENERIC;
  revalidateContact(g.clientId, p.value.contactId);
  return { ok: true };
}

// ── Owner / stage ──────────────────────────────────────────────────────────────

export async function changeOwnerAction(input: unknown): Promise<CrmResult> {
  const p = parse(ChangeOwnerInput, input);
  if (!p.ok) return INVALID;
  const g = await gate(p.value.clientId);
  if (!g) return GENERIC;
  if (!canChangeOwner(g.actor)) return FORBIDDEN;
  if (p.value.ownerUserId && !(await isTenantMember(g.tenantId, p.value.ownerUserId))) return INVALID;
  const c = await changeContactOwner({ tenantId: g.tenantId, clientId: g.clientId, contactId: p.value.contactId, ownerUserId: p.value.ownerUserId, actorUserId: g.actor.userId });
  if (!c) return GENERIC;
  revalidateContact(g.clientId, p.value.contactId);
  return { ok: true };
}

// ── Timeline ─────────────────────────────────────────────────────────────────

/** A timeline item with the Date serialized to an ISO string for the client. */
export interface TimelineItemDTO {
  id: string;
  type: string;
  occurredAt: string;
  title: string;
  summary: string | null;
  actorName: string | null;
  sourceId: string;
  sourceType: string;
}

/** Read-only "load more" for the contact Timeline tab. Gated like every other
 * action; returns one page (items + opaque nextCursor) with dates serialized. */
export async function loadContactTimelineAction(
  input: unknown,
): Promise<CrmResult<{ items: TimelineItemDTO[]; nextCursor: string | null }>> {
  const p = parse(TimelineQueryInput, input);
  if (!p.ok) return { ok: false, error: ERR_INVALID };
  const g = await gate(p.value.clientId);
  if (!g) return { ok: false, error: ERR_GENERIC };
  const page = await getContactTimeline(g.tenantId, g.clientId, p.value.contactId, {
    cursor: p.value.cursor ?? undefined,
  });
  return {
    ok: true,
    value: {
      items: page.items.map((i) => ({
        id: i.id,
        type: i.type,
        occurredAt: i.occurredAt.toISOString(),
        title: i.title,
        summary: i.summary,
        actorName: i.actorName,
        sourceId: i.sourceId,
        sourceType: i.sourceType,
      })),
      nextCursor: page.nextCursor,
    },
  };
}

export async function changeStageAction(input: unknown): Promise<CrmResult> {
  const p = parse(ChangeStageInput, input);
  if (!p.ok) return INVALID;
  const g = await gate(p.value.clientId);
  if (!g) return GENERIC;
  if (!canChangeStage(g.actor)) return FORBIDDEN;
  const c = await changeContactStage({ tenantId: g.tenantId, clientId: g.clientId, contactId: p.value.contactId, stage: p.value.stage, actorUserId: g.actor.userId });
  if (!c) return GENERIC;
  revalidateContact(g.clientId, p.value.contactId);
  return { ok: true };
}

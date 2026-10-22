/**
 * PURE authorization decisions for operational-CRM actions (no server/DB imports —
 * unit-testable). The server actions still resolve the REAL session scope + client
 * access + `crm` module gate + the action's permission first (contacts.edit for every
 * write); this only encodes the record-level rules on top of an already authorized user.
 *
 * They read PERMISSIONS (web/lib/permissions/catalog.ts), never role names:
 *  - contacts.manage_others → edit any note, manage any task, assign tasks to anyone
 *    (the agency and the Dueño hold it);
 *  - without it the narrow rules apply:
 *      notes: edit/delete only their OWN note (any CRM editor may create);
 *      tasks: modify/complete only tasks they CREATED or are ASSIGNED to; may only
 *             assign to THEMSELVES;
 *  - contacts.tags → create/rename tags in the catalogue (any CRM editor may attach/detach
 *    existing tags to a contact).
 */

export interface CrmActor {
  userId: string;
  /** The actor's permission keys on THIS client (already client-authorized). */
  permissions: ReadonlySet<string>;
}

export function isFullAccess(actor: CrmActor): boolean {
  return actor.permissions.has("contacts.manage_others");
}

export function canEditNote(actor: CrmActor, note: { created_by_user_id: string | null }): boolean {
  return isFullAccess(actor) || note.created_by_user_id === actor.userId;
}

export function canManageTask(
  actor: CrmActor,
  task: { created_by_user_id: string | null; assigned_to_user_id: string | null },
): boolean {
  return (
    isFullAccess(actor) ||
    task.created_by_user_id === actor.userId ||
    task.assigned_to_user_id === actor.userId
  );
}

/** Who a task may be assigned to. contacts.manage_others → anyone (validated as a member
 * with client access elsewhere); otherwise only themselves. Returns the ALLOWED assignee,
 * or ok:false to mean "not allowed". */
export function resolveAssignee(
  actor: CrmActor,
  requested: string | null | undefined,
): { ok: boolean; assignee: string | null } {
  if (isFullAccess(actor)) return { ok: true, assignee: requested ?? null };
  if (requested == null || requested === actor.userId) return { ok: true, assignee: requested ?? actor.userId };
  return { ok: false, assignee: null };
}

export function canManageTagCatalog(actor: CrmActor): boolean {
  return actor.permissions.has("contacts.tags");
}

/**
 * PURE authorization decisions for operational-CRM actions (no server/DB imports —
 * unit-testable). The server actions still resolve the REAL session scope + client
 * access + module gate first; this only encodes the ROLE rules on top of an already
 * client-authorized user.
 *
 * Roles: owner/admin have FULL access within the client. A member is limited:
 *  - notes: edit/delete only their OWN note (any CRM user may create);
 *  - tasks: modify/complete only tasks they CREATED or are ASSIGNED to; may only
 *    assign to THEMSELVES (never to arbitrary users);
 *  - tags catalogue (create/rename/delete): owner/admin only (any CRM user may
 *    attach/detach existing tags to a contact);
 *  - owner + stage changes: owner/admin only.
 *    DECISION: a member CANNOT change a contact's lifecycle stage — stage is a
 *    business/pipeline decision reserved for owner/admin (members drive day-to-day
 *    notes/tasks). Documented here + enforced server-side.
 */

export interface CrmActor {
  role: "owner" | "admin" | "member";
  userId: string;
}

export function isFullAccess(actor: CrmActor): boolean {
  return actor.role === "owner" || actor.role === "admin";
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

/** Who a task may be assigned to. owner/admin → anyone (validated as a member
 * elsewhere); a member → only themselves. Returns the ALLOWED assignee, or null to
 * mean "not allowed". */
export function resolveAssignee(actor: CrmActor, requested: string | null | undefined): { ok: boolean; assignee: string | null } {
  if (isFullAccess(actor)) return { ok: true, assignee: requested ?? null };
  // A member may leave it unassigned or assign to THEMSELVES; anyone else is denied.
  if (requested == null || requested === actor.userId) return { ok: true, assignee: requested ?? actor.userId };
  return { ok: false, assignee: null };
}

export const canManageTagCatalog = isFullAccess;
export const canChangeOwner = isFullAccess;
export const canChangeStage = isFullAccess;

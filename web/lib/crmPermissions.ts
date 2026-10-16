/**
 * PURE authorization decisions for operational-CRM actions (no server/DB imports —
 * unit-testable). The server actions still resolve the REAL session scope + client
 * access + `crm` module gate first; this only encodes the ROLE rules on top of an
 * already client-authorized user.
 *
 * FULL access within the client: the agency (tenant owner/admin) AND the CLIENT OWNER
 * (clientRole "owner") — the role is defined as full control of their own client, so it
 * grants full CRM control: edit any note, manage any task, manage the tag catalogue.
 * A limited member (clientRole "setter"/"staff") keeps the narrow rules:
 *  - notes: edit/delete only their OWN note (any CRM user may create);
 *  - tasks: modify/complete only tasks they CREATED or are ASSIGNED to; may only
 *    assign to THEMSELVES (never to arbitrary users);
 *  - tag catalogue (create/rename): full-access only (any CRM user may attach/detach
 *    existing tags to a contact).
 *
 * The gate resolves client access first, so a "member" actor reaching these predicates is
 * already authorized for THIS client — clientRole "owner" therefore means owner OF this
 * client (MF-1 item 5). Recovered from PR #2 (C-3), extended for the Client Owner.
 */

export interface CrmActor {
  role: "owner" | "admin" | "member";
  /** Within-client role; non-null iff role === "member". A Client Owner ("owner") has
   *  full CRM control inside their client. */
  clientRole: "owner" | "setter" | "staff" | null;
  userId: string;
}

export function isFullAccess(actor: CrmActor): boolean {
  return actor.role === "owner" || actor.role === "admin" || actor.clientRole === "owner";
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

/** Who a task may be assigned to. owner/admin → anyone (validated as a member with
 * client access elsewhere); a member → only themselves. Returns the ALLOWED assignee,
 * or ok:false to mean "not allowed". */
export function resolveAssignee(
  actor: CrmActor,
  requested: string | null | undefined,
): { ok: boolean; assignee: string | null } {
  if (isFullAccess(actor)) return { ok: true, assignee: requested ?? null };
  if (requested == null || requested === actor.userId) return { ok: true, assignee: requested ?? actor.userId };
  return { ok: false, assignee: null };
}

export const canManageTagCatalog = isFullAccess;

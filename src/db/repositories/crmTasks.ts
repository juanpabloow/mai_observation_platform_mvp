import type { PoolClient } from 'pg';
import { query, withTransaction } from '../client.js';
import { recordCrmActivity } from './crmActivityEvents.js';

/**
 * crm_tasks repository — follow-up tasks on a person. Lifecycle: open →
 * completed/cancelled, reopen → open. completed_at is kept consistent with status
 * (DB CHECK + these functions). Every write records a crm_activity_event in the SAME
 * transaction. All reads/writes are tenant + client scoped; writes verify the target
 * (contact/task) belongs to that (tenant, client) → generic null otherwise.
 */

export type TaskStatus = 'open' | 'completed' | 'cancelled';
export type TaskPriority = 'low' | 'normal' | 'high';

export interface CrmTaskRow {
  id: string;
  tenant_id: string;
  client_id: string;
  contact_id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  due_at: Date | null;
  assigned_to_user_id: string | null;
  created_by_user_id: string | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface CrmTaskView extends CrmTaskRow {
  assignee_name: string | null;
}

async function contactInClient(
  client: PoolClient,
  tenantId: string,
  clientId: string,
  contactId: string,
): Promise<boolean> {
  const r = await client.query(`SELECT 1 FROM contacts WHERE id = $1 AND tenant_id = $2 AND client_id = $3`, [
    contactId,
    tenantId,
    clientId,
  ]);
  return r.rows.length > 0;
}

export async function createTask(input: {
  tenantId: string;
  clientId: string;
  contactId: string;
  title: string;
  description?: string | null;
  priority?: TaskPriority;
  dueAt?: Date | null;
  assignedToUserId: string | null;
  createdByUserId: string;
}): Promise<CrmTaskRow | null> {
  return withTransaction(async (client) => {
    if (!(await contactInClient(client, input.tenantId, input.clientId, input.contactId))) return null;
    const r = await client.query<CrmTaskRow>(
      `INSERT INTO crm_tasks
         (tenant_id, client_id, contact_id, title, description, priority, due_at, assigned_to_user_id, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [
        input.tenantId,
        input.clientId,
        input.contactId,
        input.title,
        input.description ?? null,
        input.priority ?? 'normal',
        input.dueAt ?? null,
        input.assignedToUserId,
        input.createdByUserId,
      ],
    );
    const task = r.rows[0];
    await recordCrmActivity(client, {
      tenantId: input.tenantId,
      clientId: input.clientId,
      contactId: input.contactId,
      eventType: 'task_created',
      actorUserId: input.createdByUserId,
      detail: { task_id: task.id, title: task.title, assigned_to: task.assigned_to_user_id },
    });
    return task;
  });
}

export async function getTaskById(tenantId: string, clientId: string, taskId: string): Promise<CrmTaskRow | null> {
  const r = await query<CrmTaskRow>(
    `SELECT * FROM crm_tasks WHERE id = $1 AND tenant_id = $2 AND client_id = $3`,
    [taskId, tenantId, clientId],
  );
  return r.rows[0] ?? null;
}

/** Update editable fields (title/description/priority/due/assignee). Records
 * task_assigned when the assignee changes. Status is changed via the dedicated
 * complete/reopen/cancel functions, not here. */
export async function updateTask(input: {
  tenantId: string;
  clientId: string;
  taskId: string;
  actorUserId: string;
  patch: {
    title?: string;
    description?: string | null;
    priority?: TaskPriority;
    dueAt?: Date | null;
    assignedToUserId?: string | null;
  };
}): Promise<CrmTaskRow | null> {
  return withTransaction(async (client) => {
    const before = await client.query<CrmTaskRow>(
      `SELECT * FROM crm_tasks WHERE id = $1 AND tenant_id = $2 AND client_id = $3 FOR UPDATE`,
      [input.taskId, input.tenantId, input.clientId],
    );
    const prev = before.rows[0];
    if (!prev) return null;

    const sets: string[] = [];
    const params: unknown[] = [input.taskId, input.tenantId, input.clientId];
    const add = (col: string, val: unknown) => {
      params.push(val);
      sets.push(`${col} = $${params.length}`);
    };
    const p = input.patch;
    if (p.title !== undefined) add('title', p.title);
    if (p.description !== undefined) add('description', p.description);
    if (p.priority !== undefined) add('priority', p.priority);
    if (p.dueAt !== undefined) add('due_at', p.dueAt);
    if (p.assignedToUserId !== undefined) add('assigned_to_user_id', p.assignedToUserId);
    if (sets.length === 0) return prev;
    sets.push('updated_at = now()');
    const r = await client.query<CrmTaskRow>(
      `UPDATE crm_tasks SET ${sets.join(', ')} WHERE id = $1 AND tenant_id = $2 AND client_id = $3 RETURNING *`,
      params,
    );
    const task = r.rows[0];
    if (p.assignedToUserId !== undefined && p.assignedToUserId !== prev.assigned_to_user_id) {
      await recordCrmActivity(client, {
        tenantId: input.tenantId,
        clientId: input.clientId,
        contactId: task.contact_id,
        eventType: 'task_assigned',
        actorUserId: input.actorUserId,
        detail: { task_id: task.id, assigned_to: task.assigned_to_user_id },
      });
    }
    return task;
  });
}

async function transition(
  input: { tenantId: string; clientId: string; taskId: string; actorUserId: string },
  toStatus: TaskStatus,
  event: 'task_completed' | 'task_reopened' | 'task_cancelled',
): Promise<CrmTaskRow | null> {
  return withTransaction(async (client) => {
    const completedAtSql = toStatus === 'completed' ? 'now()' : 'NULL';
    const r = await client.query<CrmTaskRow>(
      `UPDATE crm_tasks SET status = $4, completed_at = ${completedAtSql}, updated_at = now()
        WHERE id = $1 AND tenant_id = $2 AND client_id = $3 RETURNING *`,
      [input.taskId, input.tenantId, input.clientId, toStatus],
    );
    const task = r.rows[0];
    if (!task) return null;
    await recordCrmActivity(client, {
      tenantId: input.tenantId,
      clientId: input.clientId,
      contactId: task.contact_id,
      eventType: event,
      actorUserId: input.actorUserId,
      detail: { task_id: task.id },
    });
    return task;
  });
}

export const completeTask = (i: { tenantId: string; clientId: string; taskId: string; actorUserId: string }) =>
  transition(i, 'completed', 'task_completed');
export const reopenTask = (i: { tenantId: string; clientId: string; taskId: string; actorUserId: string }) =>
  transition(i, 'open', 'task_reopened');
export const cancelTask = (i: { tenantId: string; clientId: string; taskId: string; actorUserId: string }) =>
  transition(i, 'cancelled', 'task_cancelled');

/** Tasks for one contact (all statuses unless filtered), soonest-due first, with the
 * assignee's display name. */
export async function listTasksForContact(
  tenantId: string,
  clientId: string,
  contactId: string,
  opts: { status?: TaskStatus } = {},
): Promise<CrmTaskView[]> {
  const params: unknown[] = [tenantId, clientId, contactId];
  let where = 't.tenant_id = $1 AND t.client_id = $2 AND t.contact_id = $3';
  if (opts.status) {
    params.push(opts.status);
    where += ` AND t.status = $${params.length}`;
  }
  const r = await query<CrmTaskView>(
    `SELECT t.*, u.name AS assignee_name
       FROM crm_tasks t
       LEFT JOIN "user" u ON u.id = t.assigned_to_user_id
      WHERE ${where}
      ORDER BY (t.status = 'open') DESC, t.due_at ASC NULLS LAST, t.created_at DESC`,
    params,
  );
  return r.rows;
}

/** Per-contact open-task summary for the list page — ONE batched query (no N+1):
 * the soonest-due OPEN task datetime + whether any open task is overdue. */
export interface ContactTaskSummary {
  contact_id: string;
  next_due_at: Date | null;
  has_open: boolean;
  overdue_count: number;
}
export async function openTaskSummaryByContacts(
  tenantId: string,
  clientId: string,
  contactIds: string[],
): Promise<Map<string, ContactTaskSummary>> {
  if (contactIds.length === 0) return new Map();
  const r = await query<ContactTaskSummary>(
    `SELECT contact_id,
            min(due_at) AS next_due_at,
            true AS has_open,
            count(*) FILTER (WHERE due_at IS NOT NULL AND due_at < now())::int AS overdue_count
       FROM crm_tasks
      WHERE tenant_id = $1 AND client_id = $2 AND status = 'open' AND contact_id = ANY($3::uuid[])
      GROUP BY contact_id`,
    [tenantId, clientId, contactIds],
  );
  return new Map(r.rows.map((x) => [x.contact_id, x]));
}

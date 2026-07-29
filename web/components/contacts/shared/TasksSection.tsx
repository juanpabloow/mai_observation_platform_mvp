"use client";

import { useState, useTransition } from "react";
import { formatDateTime } from "@/lib/format";
import type { MemberOption, TaskView } from "@/lib/contactShared";
import { completeTaskAction, createTaskAction } from "@/lib/crmActions";

/**
 * SHARED open-tasks block (C-4): the contact's open tasks with a Complete action, and a
 * compact "add task" composer (title + optional due date + optional assignee). Writes
 * through C-3's completeTaskAction / createTaskAction; the caller refreshes via
 * onChanged. Server re-validates assignee access + role on every write.
 */

const INPUT = "rounded-lg border border-line-strong bg-transparent px-2 py-1 text-sm";

export function TasksSection({
  clientId,
  contactId,
  tasks,
  assignableMembers,
  viewerUserId,
  viewerIsFullAccess,
  onChanged,
  allowCreate = true,
}: {
  clientId: string;
  contactId: string;
  tasks: TaskView[];
  assignableMembers: MemberOption[];
  viewerUserId: string;
  viewerIsFullAccess: boolean;
  onChanged?: () => void;
  allowCreate?: boolean;
}) {
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [assignee, setAssignee] = useState("");
  const [adding, setAdding] = useState(false);

  const canManage = (t: TaskView) =>
    viewerIsFullAccess || t.createdByUserId === viewerUserId || t.assignedToUserId === viewerUserId;

  const complete = (taskId: string) => {
    setErr(null);
    start(async () => {
      const r = await completeTaskAction(clientId, taskId);
      if (!r.ok) setErr(r.error);
      else onChanged?.();
    });
  };

  const create = () => {
    const t = title.trim();
    if (!t) return;
    setErr(null);
    start(async () => {
      const r = await createTaskAction(clientId, contactId, {
        title: t,
        dueAt: due ? new Date(`${due}T00:00:00`).toISOString() : null,
        assignedToUserId: assignee || null,
      });
      if (!r.ok) setErr(r.error);
      else {
        setTitle("");
        setDue("");
        setAssignee("");
        setAdding(false);
        onChanged?.();
      }
    });
  };

  return (
    <div className="flex flex-col gap-2">
      {tasks.length === 0 ? (
        <p className="text-sm text-faint">No open tasks.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {tasks.map((t) => (
            <li key={t.id} className="flex items-start justify-between gap-2 rounded-lg border border-line bg-card p-2.5">
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-sm text-foreground">{t.title}</span>
                <span className="truncate text-[11px] text-faint">
                  {t.assigneeName ? t.assigneeName : "Unassigned"}
                  {t.dueAt ? ` · due ${formatDateTime(new Date(t.dueAt))}` : ""}
                </span>
              </span>
              {canManage(t) ? (
                <button
                  type="button"
                  onClick={() => complete(t.id)}
                  disabled={pending}
                  className="shrink-0 rounded-lg border border-line px-2 py-1 text-xs text-muted transition-colors hover:bg-subtle hover:text-foreground disabled:opacity-50"
                >
                  Complete
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {allowCreate ? (
        adding ? (
          <div className="flex flex-col gap-1.5 rounded-lg border border-line p-2.5">
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Task title" className={INPUT} autoFocus />
            <div className="flex flex-wrap items-center gap-1.5">
              <input type="date" value={due} onChange={(e) => setDue(e.target.value)} className={INPUT} aria-label="Due date" />
              {assignableMembers.length > 0 ? (
                <select value={assignee} onChange={(e) => setAssignee(e.target.value)} className={INPUT} aria-label="Assignee">
                  <option value="">Unassigned</option>
                  {assignableMembers.map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {m.name ?? m.email}
                    </option>
                  ))}
                </select>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              <button type="button" onClick={create} disabled={pending || !title.trim()} className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">
                Add task
              </button>
              <button type="button" onClick={() => setAdding(false)} className="text-xs text-faint hover:text-foreground">
                Cancel
              </button>
              {err ? <span className="text-xs text-danger">{err}</span> : null}
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => setAdding(true)} className="rounded-lg border border-line px-2 py-1 text-xs text-muted hover:bg-subtle hover:text-foreground">
              Add task
            </button>
            {err ? <span className="text-xs text-danger">{err}</span> : null}
          </div>
        )
      ) : null}
    </div>
  );
}

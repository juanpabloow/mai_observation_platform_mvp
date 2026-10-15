"use client";

import { useState, useTransition } from "react";
import { formatLocalDate } from "@/lib/format";
import type { MemberOption, TaskView } from "@/lib/contactShared";
import { completeTaskAction, createTaskAction } from "@/lib/crmActions";
import { CRM_COPY } from "@/lib/contactLabels";
import { validateTaskTitle } from "@/lib/crmFieldRules";
import { FieldError } from "./FieldError";

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
  addOpen,
  onAddOpenChange,
}: {
  clientId: string;
  contactId: string;
  tasks: TaskView[];
  assignableMembers: MemberOption[];
  viewerUserId: string;
  viewerIsFullAccess: boolean;
  onChanged?: () => void;
  allowCreate?: boolean;
  /** CONTROLLED add form (the inbox ficha opens it from its section heading "+ Tarea").
   *  Omitted ⇒ the section keeps its own "Añadir tarea" button, as before. */
  addOpen?: boolean;
  onAddOpenChange?: (open: boolean) => void;
}) {
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [assignee, setAssignee] = useState("");
  const [ownAdding, setOwnAdding] = useState(false);
  const [titleErr, setTitleErr] = useState<string | null>(null);
  const controlled = addOpen !== undefined;
  const adding = controlled ? addOpen : ownAdding;
  const setAdding = (open: boolean) => {
    setTitleErr(null);
    if (controlled) onAddOpenChange?.(open);
    else setOwnAdding(open);
  };

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
    const invalid = validateTaskTitle(title);
    setTitleErr(invalid);
    if (invalid) return;
    const t = title.trim();
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
        <p className="text-sm text-faint">{CRM_COPY.empty.tasks}</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {tasks.map((t) => (
            <li key={t.id} className="flex items-start justify-between gap-2 rounded-lg border border-line bg-card p-2.5">
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-sm text-foreground">{t.title}</span>
                <span className="truncate text-[11px] text-faint">
                  {t.assigneeName ? t.assigneeName : "Sin asignar"}
                  {t.dueAt ? ` · vence el ${formatLocalDate(t.dueAt)}` : ""}
                </span>
              </span>
              {canManage(t) ? (
                <button
                  type="button"
                  onClick={() => complete(t.id)}
                  disabled={pending}
                  className="shrink-0 rounded-lg border border-line px-2 py-1 text-xs text-muted transition-colors hover:bg-subtle hover:text-foreground disabled:opacity-50"
                >
                  Completar
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {allowCreate ? (
        adding ? (
          <div className="flex flex-col gap-1.5 rounded-lg border border-line p-2.5">
            <label htmlFor={`task-title-${contactId}`} className="text-xs font-medium text-foreground">
              Título de la tarea
            </label>
            <input
              id={`task-title-${contactId}`}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={() => title !== "" && setTitleErr(validateTaskTitle(title))}
              aria-invalid={Boolean(titleErr)}
              aria-describedby={titleErr ? `task-title-err-${contactId}` : undefined}
              className={INPUT}
              autoFocus
            />
            <FieldError id={`task-title-err-${contactId}`} text={titleErr} />
            <div className="flex flex-wrap items-center gap-1.5">
              <input type="date" value={due} onChange={(e) => setDue(e.target.value)} className={INPUT} aria-label="Fecha límite" />
              {assignableMembers.length > 0 ? (
                <select value={assignee} onChange={(e) => setAssignee(e.target.value)} className={INPUT} aria-label="Responsable">
                  <option value="">Sin asignar</option>
                  {assignableMembers.map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {m.name ?? m.email}
                    </option>
                  ))}
                </select>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              <button type="button" onClick={create} disabled={pending} className="rounded-md bg-ink px-3 py-1.5 text-sm font-semibold text-ink-fg transition-colors hover:bg-ink-hover disabled:cursor-not-allowed disabled:opacity-50">
                {CRM_COPY.actions.create}
              </button>
              <button type="button" onClick={() => setAdding(false)} className="text-xs text-faint hover:text-foreground">
                {CRM_COPY.actions.cancel}
              </button>
              {err ? <span className="text-xs text-danger">{err}</span> : null}
            </div>
          </div>
        ) : controlled ? (
          err ? <span className="text-xs text-danger">{err}</span> : null
        ) : (
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => setAdding(true)} className="rounded-lg border border-line px-2 py-1 text-xs text-muted hover:bg-subtle hover:text-foreground">
              {CRM_COPY.actions.addTask}
            </button>
            {err ? <span className="text-xs text-danger">{err}</span> : null}
          </div>
        )
      ) : null}
    </div>
  );
}

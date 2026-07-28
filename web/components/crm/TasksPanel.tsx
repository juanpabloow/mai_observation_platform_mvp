"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  createTaskAction,
  completeTaskAction,
  reopenTaskAction,
  cancelTaskAction,
} from "@/lib/crmActions";
import { fmtDateTime, type MemberOption, type TaskDTO } from "./types";

const INPUT =
  "rounded-lg border border-line-strong bg-transparent px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent/40";

const PRIORITY_CHIP: Record<string, string> = {
  low: "bg-subtle text-muted",
  normal: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  high: "bg-red-500/15 text-red-700 dark:text-red-300",
};

/** datetime-local ("YYYY-MM-DDTHH:mm", no zone) → ISO-with-offset for the strict
 * Zod validator. Empty string → null. */
function toIso(local: string): string | null {
  if (!local) return null;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function isOverdue(t: TaskDTO): boolean {
  return t.status === "open" && t.dueAt != null && new Date(t.dueAt).getTime() < Date.now();
}

export function TasksPanel({
  clientId,
  contactId,
  tasks,
  members,
  canAssignOthers,
}: {
  clientId: string;
  contactId: string;
  tasks: TaskDTO[];
  members: MemberOption[];
  canAssignOthers: boolean;
}) {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState<"low" | "normal" | "high">("normal");
  const [dueLocal, setDueLocal] = useState("");
  const [assignee, setAssignee] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const run = (fn: () => Promise<{ ok: true; value?: unknown } | { ok: false; error: string }>, onOk?: () => void) => {
    setError(null);
    startTransition(async () => {
      const r = await fn();
      if (!r.ok) setError(r.error);
      else {
        onOk?.();
        router.refresh();
      }
    });
  };

  const create = () => {
    const t = title.trim();
    if (!t) return;
    run(
      () =>
        createTaskAction({
          clientId,
          contactId,
          title: t,
          priority,
          dueAt: toIso(dueLocal),
          assignedToUserId: canAssignOthers && assignee ? assignee : undefined,
        }),
      () => {
        setTitle("");
        setPriority("normal");
        setDueLocal("");
        setAssignee("");
      },
    );
  };

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 rounded-xl border border-line p-3">
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="New task…" className={`${INPUT} w-full`} />
        <div className="flex flex-wrap items-center gap-2">
          <select value={priority} onChange={(e) => setPriority(e.target.value as "low" | "normal" | "high")} className={INPUT}>
            <option value="low">Low</option>
            <option value="normal">Normal</option>
            <option value="high">High</option>
          </select>
          <input type="datetime-local" value={dueLocal} onChange={(e) => setDueLocal(e.target.value)} className={INPUT} />
          {canAssignOthers ? (
            <select value={assignee} onChange={(e) => setAssignee(e.target.value)} className={INPUT}>
              <option value="">Unassigned</option>
              {members.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name}
                </option>
              ))}
            </select>
          ) : null}
          <button
            onClick={create}
            disabled={pending || title.trim().length === 0}
            className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {pending ? "…" : "Add task"}
          </button>
        </div>
        {error ? <span className="text-xs text-danger">{error}</span> : null}
      </div>

      <ul className="flex flex-col gap-2">
        {tasks.length === 0 ? <li className="text-sm text-muted">No tasks yet.</li> : null}
        {tasks.map((t) => (
          <li key={t.id} className="flex items-start justify-between gap-3 rounded-lg border border-line p-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`font-medium text-sm ${t.status === "completed" ? "text-muted line-through" : ""}`}>{t.title}</span>
                <span className={`rounded px-1.5 py-0.5 text-[11px] ${PRIORITY_CHIP[t.priority]}`}>{t.priority}</span>
                {t.status === "cancelled" ? <span className="rounded bg-subtle px-1.5 py-0.5 text-[11px] text-faint">cancelled</span> : null}
                {isOverdue(t) ? <span className="rounded bg-red-500/15 px-1.5 py-0.5 text-[11px] text-red-700 dark:text-red-300">overdue</span> : null}
              </div>
              {t.description ? <p className="mt-1 whitespace-pre-wrap text-xs text-muted">{t.description}</p> : null}
              <p className="mt-1 text-xs text-faint">
                {t.dueAt ? `Due ${fmtDateTime(t.dueAt)}` : "No due date"} · {t.assigneeName ? `→ ${t.assigneeName}` : "Unassigned"}
              </p>
            </div>
            {t.canManage ? (
              <div className="flex shrink-0 gap-2 text-xs">
                {t.status === "open" ? (
                  <>
                    <button onClick={() => run(() => completeTaskAction({ clientId, taskId: t.id }))} disabled={pending} className="text-accent hover:underline disabled:opacity-50">
                      Complete
                    </button>
                    <button onClick={() => run(() => cancelTaskAction({ clientId, taskId: t.id }))} disabled={pending} className="text-muted hover:text-danger disabled:opacity-50">
                      Cancel
                    </button>
                  </>
                ) : null}
                {t.status !== "open" ? (
                  <button onClick={() => run(() => reopenTaskAction({ clientId, taskId: t.id }))} disabled={pending} className="text-muted hover:text-foreground disabled:opacity-50">
                    Reopen
                  </button>
                ) : null}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

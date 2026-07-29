"use client";

/**
 * TEMPORARY C-3 scaffolding — deleted in C-4 (the contact record is redesigned against
 * an approved mockup). It exists ONLY to exercise the timeline read model + the
 * notes/tasks/tags write paths. No new visual language: existing tokens only, plain
 * markup, DATA rendered as-is (the timeline returns keys/data, not prose).
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  addNoteAction,
  completeTaskAction,
  createTaskAction,
  attachTagAction,
  detachTagAction,
  createTagAction,
  loadContactTimelineAction,
} from "@/lib/crmActions";

type Source = "conversation" | "appointment" | "note" | "activity";
const SOURCES: Source[] = ["conversation", "appointment", "note", "activity"];

export interface TimelineItemView {
  id: string;
  kind: string;
  occurred_at: string;
  actor: string;
  summary: string | null;
  ref: Record<string, unknown>;
  meta: Record<string, unknown>;
}
export interface TaskView { id: string; title: string; status: string; due_at: string | null; assignee_name: string | null }
export interface TagView { id: string; name: string; color: string }
export interface MemberOption { user_id: string; email: string; name: string | null }

const INPUT = "rounded-lg border border-line-strong bg-transparent px-2 py-1.5 text-sm";
const fmt = (iso: string): string => new Intl.DateTimeFormat("es-CO", { dateStyle: "short", timeStyle: "short" }).format(new Date(iso));

export function ContactActivity({
  clientId,
  contactId,
  canManageTags,
  assignableMembers,
  initialItems,
  initialCursor,
  openTasks,
  attachedTags,
  tagCatalogue,
}: {
  clientId: string;
  contactId: string;
  canManageTags: boolean;
  assignableMembers: MemberOption[];
  initialItems: TimelineItemView[];
  initialCursor: string | null;
  openTasks: TaskView[];
  attachedTags: TagView[];
  tagCatalogue: TagView[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  const [items, setItems] = useState(initialItems);
  const [cursor, setCursor] = useState(initialCursor);
  const [kinds, setKinds] = useState<Set<Source>>(new Set(SOURCES));
  const [note, setNote] = useState("");
  const [taskTitle, setTaskTitle] = useState("");
  const [taskDue, setTaskDue] = useState("");
  const [taskAssignee, setTaskAssignee] = useState("");
  const [newTagName, setNewTagName] = useState("");
  const [attachTagId, setAttachTagId] = useState("");

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setErr(null);
    startTransition(async () => {
      const r = await fn();
      if (!r.ok) setErr(r.error ?? "Failed.");
      else router.refresh();
    });
  };

  const reloadTimeline = (selected: Set<Source>) => {
    startTransition(async () => {
      const r = await loadContactTimelineAction(clientId, contactId, null, [...selected]);
      if (r.ok) {
        setItems(r.page.items);
        setCursor(r.page.nextCursor);
      }
    });
  };
  const loadMore = () => {
    startTransition(async () => {
      const r = await loadContactTimelineAction(clientId, contactId, cursor, [...kinds]);
      if (r.ok) {
        setItems((prev) => [...prev, ...r.page.items]);
        setCursor(r.page.nextCursor);
      }
    });
  };
  const toggleKind = (k: Source) => {
    const next = new Set(kinds);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    setKinds(next);
    reloadTimeline(next);
  };

  return (
    <div className="flex flex-col gap-6">
      {err ? <p className="text-xs text-red-600 dark:text-red-400">{err}</p> : null}

      {/* ── Tags ── */}
      <section>
        <h2 className="text-sm font-semibold">Tags</h2>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {attachedTags.length === 0 ? <span className="text-xs text-muted">No tags.</span> : null}
          {attachedTags.map((t) => (
            <span key={t.id} className="inline-flex items-center gap-1 rounded-full bg-subtle px-2 py-0.5 text-xs">
              {t.name}
              <button type="button" disabled={pending} onClick={() => run(() => detachTagAction(clientId, contactId, t.id))} className="text-faint hover:text-foreground">×</button>
            </span>
          ))}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <select value={attachTagId} onChange={(e) => setAttachTagId(e.target.value)} className={INPUT}>
            <option value="">Attach existing tag…</option>
            {tagCatalogue.filter((t) => !attachedTags.some((a) => a.id === t.id)).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <button type="button" disabled={pending || !attachTagId} onClick={() => run(() => attachTagAction(clientId, contactId, attachTagId))} className="rounded-lg border border-line px-2 py-1 text-xs hover:bg-subtle disabled:opacity-50">Attach</button>
          {canManageTags ? (
            <>
              <input value={newTagName} onChange={(e) => setNewTagName(e.target.value)} placeholder="new tag name" className={INPUT} />
              <button type="button" disabled={pending || !newTagName.trim()} onClick={() => run(async () => { const r = await createTagAction(clientId, newTagName.trim(), "gray"); if (r.ok) setNewTagName(""); return r; })} className="rounded-lg border border-line px-2 py-1 text-xs hover:bg-subtle disabled:opacity-50">Create tag</button>
            </>
          ) : null}
        </div>
      </section>

      {/* ── Notes composer ── */}
      <section>
        <h2 className="text-sm font-semibold">Add note</h2>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} className={`${INPUT} mt-1 w-full max-w-lg`} placeholder="Write a note…" />
        <div>
          <button type="button" disabled={pending || !note.trim()} onClick={() => run(async () => { const r = await addNoteAction(clientId, contactId, note.trim()); if (r.ok) setNote(""); return r; })} className="mt-1 rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">Add note</button>
        </div>
      </section>

      {/* ── Tasks ── */}
      <section>
        <h2 className="text-sm font-semibold">Open tasks</h2>
        <ul className="mt-1 flex flex-col gap-1 text-sm">
          {openTasks.length === 0 ? <li className="text-xs text-muted">No open tasks.</li> : null}
          {openTasks.map((t) => (
            <li key={t.id} className="flex items-center justify-between gap-2 rounded-lg border border-line px-3 py-1.5">
              <span>{t.title}{t.due_at ? <span className="ml-2 text-xs text-faint">due {fmt(t.due_at)}</span> : null}{t.assignee_name ? <span className="ml-2 text-xs text-muted">· {t.assignee_name}</span> : null}</span>
              <button type="button" disabled={pending} onClick={() => run(() => completeTaskAction(clientId, t.id))} className="rounded-lg border border-line px-2 py-0.5 text-xs hover:bg-subtle disabled:opacity-50">Complete</button>
            </li>
          ))}
        </ul>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input value={taskTitle} onChange={(e) => setTaskTitle(e.target.value)} placeholder="New task title" className={INPUT} />
          <input type="date" value={taskDue} onChange={(e) => setTaskDue(e.target.value)} className={INPUT} />
          <select value={taskAssignee} onChange={(e) => setTaskAssignee(e.target.value)} className={INPUT}>
            <option value="">Unassigned</option>
            {assignableMembers.map((m) => <option key={m.user_id} value={m.user_id}>{m.name ?? m.email}</option>)}
          </select>
          <button
            type="button"
            disabled={pending || !taskTitle.trim()}
            onClick={() => run(async () => {
              const r = await createTaskAction(clientId, contactId, {
                title: taskTitle.trim(),
                dueAt: taskDue ? new Date(`${taskDue}T12:00:00Z`).toISOString() : null,
                assignedToUserId: taskAssignee || null,
              });
              if (r.ok) { setTaskTitle(""); setTaskDue(""); setTaskAssignee(""); }
              return r;
            })}
            className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            Add task
          </button>
        </div>
      </section>

      {/* ── Timeline ── */}
      <section>
        <h2 className="text-sm font-semibold">Timeline</h2>
        <div className="mt-1 flex flex-wrap gap-3 text-xs text-muted">
          {SOURCES.map((k) => (
            <label key={k} className="inline-flex items-center gap-1">
              <input type="checkbox" checked={kinds.has(k)} onChange={() => toggleKind(k)} /> {k}
            </label>
          ))}
        </div>
        <ul className="mt-2 flex flex-col gap-1 text-sm">
          {items.length === 0 ? <li className="text-xs text-muted">No activity.</li> : null}
          {items.map((it) => (
            <li key={it.id} className="flex items-start gap-2 border-b border-line/60 py-1.5 text-xs">
              <span className="w-28 shrink-0 text-faint">{fmt(it.occurred_at)}</span>
              <span className="shrink-0 rounded bg-subtle px-1.5 py-0.5 font-mono">{it.kind}</span>
              <span className="min-w-0 flex-1 text-muted">
                {it.summary ?? ""}
                {typeof it.meta.messageCount === "number" ? ` · ${it.meta.messageCount} msg` : ""}
                {typeof it.meta.actorName === "string" && it.meta.actorName ? ` · ${it.meta.actorName}` : ""}
              </span>
            </li>
          ))}
        </ul>
        {cursor ? (
          <button type="button" disabled={pending} onClick={loadMore} className="mt-2 rounded-lg border border-line px-3 py-1.5 text-xs text-muted hover:bg-subtle disabled:opacity-50">Load more</button>
        ) : null}
      </section>
    </div>
  );
}

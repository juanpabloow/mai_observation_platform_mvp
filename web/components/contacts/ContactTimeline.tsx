"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { formatDateTime, formatChatTime, formatDayLabel, localDayKey } from "@/lib/format";
import { agendaDateKey } from "@/lib/contactShared";
import { timelineCopy, TIMELINE_FILTERS } from "@/lib/timelineCopy";
import { KindIcon } from "./KindIcon";
import { addNoteAction, createTaskAction, loadContactTimelineAction } from "@/lib/crmActions";
import type { TimelineSource } from "@worker/db/repositories/contactTimeline.js";

/**
 * The CENTER of the record (C-4): the UNIFIED timeline. One place, every kind. Copy
 * comes from timelineCopy (title_key → words). Filtering pushes down to the C-3 API at
 * source granularity (never a client-side hide); "Load more" is keyset, never offset.
 * Visual weight follows importance — appointments/conversations/notes read as
 * substantive entries; CRM facts read as quiet log lines. Inline note + task composers
 * write through C-3 and the new entry appears after a first-page reload.
 */

export interface TimelineItemView {
  id: string;
  kind: string;
  occurred_at: string;
  actor: string;
  summary: string | null;
  ref: Record<string, unknown>;
  meta: Record<string, unknown>;
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
const INPUT = "w-full rounded-lg border border-line-strong bg-transparent px-2 py-1.5 text-sm";

/** Actor attribution: a named agent/user if we have one, else the actor role word. */
function actorLabel(item: TimelineItemView): string {
  const name = str(item.meta.actorName);
  if (name) return name;
  switch (item.actor) {
    case "customer":
      return "Customer";
    case "bot":
      return "Bot";
    case "user":
      return "Agent";
    default:
      return "System";
  }
}

function ConversationExtra({ clientId, item }: { clientId: string; item: TimelineItemView }) {
  const convId = str(item.ref.conversationId);
  const count = num(item.meta.messageCount);
  return (
    <div className="mt-0.5 flex items-center gap-2 text-xs text-faint">
      {count !== null ? <span>{count} messages</span> : null}
      {convId ? (
        <Link href={`/clients/${clientId}/inbox?c=${encodeURIComponent(convId)}`} className="text-muted hover:text-foreground">
          Open conversation →
        </Link>
      ) : null}
    </div>
  );
}

function AppointmentExtra({ clientId, item }: { clientId: string; item: TimelineItemView }) {
  const startAt = str(item.meta.startAt);
  const staff = str(item.meta.staffName);
  return (
    <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-faint">
      {startAt ? <span>{formatDateTime(new Date(startAt))}</span> : null}
      {staff ? <span>· {staff}</span> : null}
      {startAt ? (
        <Link href={`/clients/${clientId}/scheduling/agenda?date=${agendaDateKey(startAt)}`} className="text-muted hover:text-foreground">
          View on agenda →
        </Link>
      ) : null}
    </div>
  );
}

function TimelineRow({ clientId, item }: { clientId: string; item: TimelineItemView }) {
  const copy = timelineCopy(item.kind);
  const when = new Date(item.occurred_at);

  if (copy.weight === "quiet") {
    // Compact one-liner log line — no summary block.
    return (
      <li className="flex items-center gap-2.5 py-1.5 pl-1 text-xs text-muted">
        <KindIcon kind={copy.icon} className="size-3.5 shrink-0 text-faint" />
        <span className="text-foreground">{copy.title}</span>
        <span className="text-faint">· {actorLabel(item)}</span>
        <span className="ml-auto shrink-0 text-faint">{formatChatTime(when)}</span>
      </li>
    );
  }

  // Substantive entry — icon chip, title, summary, attribution.
  return (
    <li className="flex gap-3 py-2.5">
      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full border border-line bg-card text-muted">
        <KindIcon kind={copy.icon} className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <span className="text-sm font-medium text-foreground">{copy.title}</span>
          <span className="shrink-0 text-xs text-faint" title={formatDateTime(when)}>
            {formatChatTime(when)}
          </span>
        </div>
        {item.summary ? <p className="mt-0.5 line-clamp-3 whitespace-pre-wrap break-words text-sm text-muted">{item.summary}</p> : null}
        {item.kind === "conversation" ? <ConversationExtra clientId={clientId} item={item} /> : null}
        {item.kind.startsWith("appointment_") ? <AppointmentExtra clientId={clientId} item={item} /> : null}
        <p className="mt-0.5 text-[11px] text-faint">{actorLabel(item)}</p>
      </div>
    </li>
  );
}

export function ContactTimeline({
  clientId,
  contactId,
  initialItems,
  initialCursor,
}: {
  clientId: string;
  contactId: string;
  initialItems: TimelineItemView[];
  initialCursor: string | null;
}) {
  const [items, setItems] = useState<TimelineItemView[]>(initialItems);
  const [cursor, setCursor] = useState<string | null>(initialCursor);
  const [filter, setFilter] = useState(0); // index into TIMELINE_FILTERS ("All" = 0)
  const [loading, setLoading] = useState(false);
  const [composerErr, setComposerErr] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [taskOpen, setTaskOpen] = useState(false);
  const [taskTitle, setTaskTitle] = useState("");
  const [taskDue, setTaskDue] = useState("");
  const [pending, start] = useTransition();

  const sourcesFor = (idx: number): TimelineSource[] => TIMELINE_FILTERS[idx].sources ?? [];

  const reload = async (idx: number) => {
    setLoading(true);
    const r = await loadContactTimelineAction(clientId, contactId, null, sourcesFor(idx));
    setLoading(false);
    if (r.ok) {
      setItems(r.page.items);
      setCursor(r.page.nextCursor);
    }
  };
  const pickFilter = (idx: number) => {
    setFilter(idx);
    void reload(idx);
  };
  const loadMore = async () => {
    if (!cursor) return;
    setLoading(true);
    const r = await loadContactTimelineAction(clientId, contactId, cursor, sourcesFor(filter));
    setLoading(false);
    if (r.ok) {
      setItems((prev) => [...prev, ...r.page.items]);
      setCursor(r.page.nextCursor);
    }
  };

  const addNote = () => {
    const body = note.trim();
    if (!body) return;
    setComposerErr(null);
    start(async () => {
      const r = await addNoteAction(clientId, contactId, body);
      if (!r.ok) setComposerErr(r.error);
      else {
        setNote("");
        await reload(filter);
      }
    });
  };
  const addTask = () => {
    const t = taskTitle.trim();
    if (!t) return;
    setComposerErr(null);
    start(async () => {
      const r = await createTaskAction(clientId, contactId, {
        title: t,
        dueAt: taskDue ? new Date(`${taskDue}T00:00:00`).toISOString() : null,
      });
      if (!r.ok) setComposerErr(r.error);
      else {
        setTaskTitle("");
        setTaskDue("");
        setTaskOpen(false);
        await reload(filter);
      }
    });
  };

  // Group items by local day for date separators (matching the inbox thread treatment).
  const groups: { key: string; label: string; items: TimelineItemView[] }[] = [];
  const now = new Date();
  for (const it of items) {
    const d = new Date(it.occurred_at);
    const key = localDayKey(d);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(it);
    else groups.push({ key, label: formatDayLabel(d, now), items: [it] });
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Inline composers */}
      <div className="flex flex-col gap-2 rounded-xl border border-line bg-card p-3">
        <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note…" rows={2} className={INPUT} />
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={addNote} disabled={pending || !note.trim()} className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">
            Add note
          </button>
          {taskOpen ? null : (
            <button type="button" onClick={() => setTaskOpen(true)} className="rounded-lg border border-line px-2.5 py-1.5 text-sm text-muted hover:bg-subtle hover:text-foreground">
              Add task
            </button>
          )}
          {composerErr ? <span className="text-xs text-danger">{composerErr}</span> : null}
        </div>
        {taskOpen ? (
          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-2">
            <input value={taskTitle} onChange={(e) => setTaskTitle(e.target.value)} placeholder="Task title" className="min-w-40 flex-1 rounded-lg border border-line-strong bg-transparent px-2 py-1.5 text-sm" autoFocus />
            <input type="date" value={taskDue} onChange={(e) => setTaskDue(e.target.value)} className="rounded-lg border border-line-strong bg-transparent px-2 py-1.5 text-sm" aria-label="Due date" />
            <button type="button" onClick={addTask} disabled={pending || !taskTitle.trim()} className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">
              Add
            </button>
            <button type="button" onClick={() => setTaskOpen(false)} className="text-xs text-faint hover:text-foreground">
              Cancel
            </button>
          </div>
        ) : null}
      </div>

      {/* Filter chips — push down to the API */}
      <div className="flex flex-wrap gap-1.5">
        {TIMELINE_FILTERS.map((f, idx) => (
          <button
            key={f.label}
            type="button"
            onClick={() => pickFilter(idx)}
            aria-pressed={filter === idx}
            className={`rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
              filter === idx ? "bg-subtle text-foreground" : "text-muted hover:bg-subtle hover:text-foreground"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Timeline */}
      {items.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-line px-6 py-12 text-center">
          <p className="text-sm font-medium text-muted">Nothing here yet</p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-faint">
            Conversations, appointments, notes and changes for this contact will appear here as they happen.
          </p>
        </div>
      ) : (
        <div className="flex flex-col">
          {groups.map((g) => (
            <div key={g.key}>
              <div className="my-1 flex justify-center">
                <span className="rounded-full bg-black/5 px-2.5 py-0.5 text-[11px] text-neutral-500 dark:bg-white/10 dark:text-muted">
                  {g.label}
                </span>
              </div>
              <ul className="flex flex-col divide-y divide-line/60">
                {g.items.map((it) => (
                  <TimelineRow key={it.id} clientId={clientId} item={it} />
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {cursor ? (
        <div className="flex justify-center pt-1">
          <button type="button" onClick={loadMore} disabled={loading} className="rounded-lg border border-line px-3 py-1.5 text-sm text-muted transition-colors hover:bg-subtle hover:text-foreground disabled:opacity-50">
            {loading ? "Loading…" : "Load more"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

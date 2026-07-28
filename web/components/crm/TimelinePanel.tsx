"use client";

import { useState, useTransition } from "react";
import { loadContactTimelineAction } from "@/lib/crmActions";
import { fmtDateTime, type TimelineItemDTO } from "./types";

const SOURCE_DOT: Record<string, string> = {
  note: "bg-blue-500",
  task: "bg-amber-500",
  appointment: "bg-green-500",
  conversation: "bg-purple-500",
  crm: "bg-gray-400",
};

/** Read-only unified timeline (activity events + notes + tasks + appointments +
 * conversations) with cursor "load more". Items DESC; the first page is rendered
 * on the server, subsequent pages fetched through the gated action. */
export function TimelinePanel({
  clientId,
  contactId,
  initialItems,
  initialCursor,
}: {
  clientId: string;
  contactId: string;
  initialItems: TimelineItemDTO[];
  initialCursor: string | null;
}) {
  const [items, setItems] = useState<TimelineItemDTO[]>(initialItems);
  const [cursor, setCursor] = useState<string | null>(initialCursor);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const loadMore = () => {
    if (!cursor) return;
    setError(null);
    startTransition(async () => {
      const r = await loadContactTimelineAction({ clientId, contactId, cursor });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      const page = r.value;
      if (page) {
        setItems((prev) => [...prev, ...page.items]);
        setCursor(page.nextCursor);
      }
    });
  };

  return (
    <section className="flex flex-col gap-3">
      {items.length === 0 ? <p className="text-sm text-muted">No activity yet.</p> : null}
      <ol className="flex flex-col gap-3">
        {items.map((it) => (
          <li key={it.id} className="flex gap-3">
            <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${SOURCE_DOT[it.sourceType] ?? "bg-gray-400"}`} aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-sm font-medium">{it.title}</span>
                <span className="text-xs text-faint">{fmtDateTime(it.occurredAt)}</span>
              </div>
              {it.summary ? <p className="mt-0.5 whitespace-pre-wrap text-xs text-muted">{it.summary}</p> : null}
              {it.actorName ? <p className="mt-0.5 text-[11px] text-faint">by {it.actorName}</p> : null}
            </div>
          </li>
        ))}
      </ol>
      {error ? <span className="text-xs text-danger">{error}</span> : null}
      {cursor ? (
        <button
          onClick={loadMore}
          disabled={pending}
          className="self-start rounded-lg border border-line px-3 py-1.5 text-sm hover:bg-subtle disabled:opacity-50"
        >
          {pending ? "Loading…" : "Load more"}
        </button>
      ) : null}
    </section>
  );
}

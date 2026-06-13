"use client";

import { useMemo, useState } from "react";
import Link from "next/link";

/** One row in the conversation list (all display strings pre-formatted server-side). */
export interface ConversationListItem {
  conversationId: string;
  /** contact_name, or null (then displayName falls back to the id). */
  contactName: string | null;
  /** What to show as the title: contactName ?? conversationId. */
  displayName: string;
  /** Last message preview (most recent message, truncated). */
  preview: string;
  /** Pre-formatted last-activity timestamp. */
  timestamp: string;
  turnCount: number;
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (/^\d+$/.test(name.trim())) return "#"; // bare phone id
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

export function ConversationList({
  workflowId,
  conversations,
}: {
  workflowId: string;
  conversations: ConversationListItem[];
}) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return conversations;
    return conversations.filter(
      (c) =>
        c.displayName.toLowerCase().includes(needle) ||
        c.conversationId.toLowerCase().includes(needle),
    );
  }, [query, conversations]);

  const base = `/workflows/${encodeURIComponent(workflowId)}/conversations`;

  return (
    <div className="flex flex-col gap-3">
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search by name or number…"
        className="w-full rounded-xl border border-black/10 bg-transparent px-4 py-2 text-sm outline-none transition-colors placeholder:text-neutral-600 focus:border-black/25 dark:border-white/10 dark:focus:border-white/25"
      />

      {filtered.length === 0 ? (
        <p className="px-1 py-8 text-center text-sm text-neutral-500">
          No conversations match &ldquo;{query}&rdquo;.
        </p>
      ) : (
        <ul className="divide-y divide-black/5 overflow-hidden rounded-xl border border-black/10 dark:divide-white/5 dark:border-white/10">
          {filtered.map((c) => (
            <li key={c.conversationId}>
              <Link
                href={`${base}/${encodeURIComponent(c.conversationId)}`}
                className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.04]"
              >
                <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-sm font-medium text-emerald-300">
                  {initials(c.displayName)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="truncate font-medium text-neutral-100">{c.displayName}</span>
                    <span className="shrink-0 text-xs text-neutral-500">{c.timestamp}</span>
                  </span>
                  <span className="mt-0.5 flex items-center justify-between gap-2">
                    <span className="truncate text-sm text-neutral-500">{c.preview}</span>
                    <span className="shrink-0 rounded-full bg-white/10 px-1.5 py-0.5 text-[10px] text-neutral-400">
                      {c.turnCount}
                    </span>
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

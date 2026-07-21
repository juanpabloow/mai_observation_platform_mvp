"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { InboxThread } from "./InboxThread";
import type {
  HistoryTurnView,
  InboxHeaderView,
  InboxMessageView,
} from "@/lib/inboxView";

interface ThreadPayload {
  header: InboxHeaderView;
  messages: InboxMessageView[];
  history?: HistoryTurnView[];
  activityWindowHours: number;
  asOf: string;
}

/**
 * The conversation DRAWER (H-8): a right-side overlay over the live grid, deep-linked
 * via ?c=<conversationId>. Opens on load if the param is present and on card click
 * (the cards are ?c= links, so no full navigation); Esc and backdrop-click close by
 * dropping the param. On mobile it's a full-screen sheet. The grid stays mounted and
 * polling behind it. Access is enforced by the session-gated messages route.
 */
export function InboxDrawer({
  clientId,
  viewerUserId,
  viewerName,
  viewerIsFullAccess,
}: {
  clientId: string;
  viewerUserId: string;
  viewerName: string | null;
  viewerIsFullAccess: boolean;
}) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const c = searchParams.get("c");

  const [payload, setPayload] = useState<ThreadPayload | null>(null);
  const [loadError, setLoadError] = useState(false);

  const close = useCallback(() => {
    const p = new URLSearchParams(searchParams.toString());
    p.delete("c");
    const qs = p.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [searchParams, router, pathname]);

  // Load the thread (with pre-handoff history) whenever the open conversation changes.
  useEffect(() => {
    if (!c) {
      setPayload(null);
      setLoadError(false);
      return;
    }
    let cancelled = false;
    setPayload(null);
    setLoadError(false);
    void (async () => {
      try {
        const res = await fetch(`/api/inbox/${clientId}/conversations/${c}/messages?history=1`, {
          cache: "no-store",
        });
        if (!res.ok) {
          if (!cancelled) setLoadError(true);
          return;
        }
        const data = (await res.json()) as ThreadPayload;
        if (!cancelled) setPayload(data);
      } catch {
        if (!cancelled) setLoadError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [c, clientId]);

  // Esc closes.
  useEffect(() => {
    if (!c) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [c, close]);

  if (!c) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/40" onClick={close} aria-hidden />
      <aside className="relative z-10 flex h-full w-full flex-col border-l border-line bg-background shadow-xl md:max-w-[480px]">
        {loadError ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <p className="text-sm text-muted">This conversation isn&rsquo;t available.</p>
            <button
              type="button"
              onClick={close}
              className="rounded-lg border border-black/10 px-3 py-1.5 text-sm transition-colors hover:bg-black/[0.04] dark:border-line-strong dark:hover:bg-subtle"
            >
              Close
            </button>
          </div>
        ) : payload ? (
          <InboxThread
            key={c}
            clientId={clientId}
            initial={payload}
            viewerUserId={viewerUserId}
            viewerName={viewerName}
            viewerIsFullAccess={viewerIsFullAccess}
            onClose={close}
          />
        ) : (
          <div className="flex h-full items-center justify-center p-6 text-sm text-faint">Loading…</div>
        )}
      </aside>
    </div>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { InboxThread } from "./InboxThread";
import { SidePane } from "./SidePane";
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
 * The conversation pane — a right-side SidePane over the live grid, deep-linked via
 * ?c=<conversationId> (H-8/H-8.2). Opens on load if the param is present and on card
 * click (cards are ?c= links → no full navigation); the ✕ / Esc close by dropping
 * the param. NON-MODAL (SidePane has no backdrop), so the grid stays visible, polling,
 * and interactive behind it — clicking another card just switches ?c= and the pane
 * swaps to that conversation. To avoid a blank flash while the newly-selected thread
 * loads, the previously-loaded thread stays visible until the new payload arrives
 * (InboxThread is keyed by the LOADED conversation id, so it remounts on the swap).
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
  // The previous payload is intentionally NOT cleared here — it stays on screen until
  // the new one lands, so switching cards never flashes a blank/"Loading" pane.
  useEffect(() => {
    if (!c) {
      setPayload(null);
      setLoadError(false);
      return;
    }
    let cancelled = false;
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

  if (!c) return null;

  return (
    <SidePane paneType="inbox" onClose={close}>
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
          key={payload.header.id}
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
    </SidePane>
  );
}

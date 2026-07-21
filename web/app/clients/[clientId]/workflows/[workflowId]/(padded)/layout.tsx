/**
 * (padded) route group — every workflow section EXCEPT executions (Inbox, Analytics,
 * Conversations list/thread/settings). This gives them the SCROLLING slot with the
 * familiar centered max-w-6xl padded column, so each page scrolls normally under the
 * fixed app shell with no per-page wrapper.
 *
 * This wrapper used to be a pathname branch in the parent workflow layout; it lives
 * here now so that navigating in from executions (the (workspace) group) REMOUNTS it
 * — the padding can never be stolen by the executions bounded slot again (the H-8.1
 * flush bug). Route groups don't affect the URL.
 */
export default function PaddedLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-8">{children}</div>
    </div>
  );
}

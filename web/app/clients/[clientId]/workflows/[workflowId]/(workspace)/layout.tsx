/**
 * (workspace) route group — full-bleed workflow sections whose page owns its own
 * scroll (currently just the executions master-detail). This gives them the BOUNDED
 * slot: it fills the app shell's content region (flex-1 min-h-0) and does NOT scroll
 * itself, so ExecutionsWorkspace can hand its table column + detail panel their OWN
 * independent scroll regions (and supply its own max-w-6xl + horizontal padding).
 *
 * This wrapper used to be a pathname branch in the parent workflow layout; it lives
 * here now so that navigating in from a (padded) section REMOUNTS it — the slot can
 * never be the wrong kind for the active page (the H-8.1 flush/trapped-pane bug).
 * Route groups don't affect the URL.
 */
export default function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-0 flex-1 flex-col">{children}</div>;
}

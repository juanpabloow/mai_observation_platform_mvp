/**
 * (workspace) route group — full-bleed workflow sections (currently just executions).
 * This gives them the BOUNDED slot: it fills the app shell's content region (flex-1
 * min-h-0) and does NOT scroll itself, so the page can lay out an edge-to-edge,
 * full-width table with its own scroll region (H-8.2), with the execution detail
 * opening as the shared non-modal SidePane overlay on top.
 *
 * This wrapper used to be a pathname branch in the parent workflow layout; it lives
 * here now so that navigating in from a (padded) section REMOUNTS it — the slot can
 * never be the wrong kind for the active page (the H-8.1 flush/trapped-pane bug).
 * Route groups don't affect the URL.
 */
export default function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-0 flex-1 flex-col">{children}</div>;
}

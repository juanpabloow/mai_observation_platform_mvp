"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * The compact in-content tab bar shown INSIDE a workflow (Executions | Analytics).
 * It lives in the shared workflow layout so both pages inherit ONE bar (never
 * duplicated per page). Inbox is deliberately NOT a tab — the Inbox is client-level
 * now (its old per-workflow routes still resolve for compatibility, but they're not
 * surfaced here).
 *
 * Reactive via usePathname so the active tab tracks client-side navigation. `slot`
 * is the workflow segment ("all" for the aggregate view or an n8n workflow id).
 */
const TABS = [
  { key: "executions", label: "Executions" },
  { key: "analytics", label: "Analytics" },
] as const;

export function WorkflowTabs({ clientId, slot }: { clientId: string; slot: string }) {
  const pathname = usePathname();
  const base = `/clients/${encodeURIComponent(clientId)}/workflows/${encodeURIComponent(slot)}`;

  return (
    <nav
      aria-label="Workflow views"
      className="flex shrink-0 items-center gap-1 border-b border-line px-4 pt-2"
    >
      {TABS.map((t) => {
        const href = `${base}/${t.key}`;
        const active = pathname.startsWith(href);
        return (
          <Link
            key={t.key}
            href={href}
            aria-current={active ? "page" : undefined}
            className={`-mb-px rounded-t-md border-b-2 px-3 py-1.5 text-sm transition-colors ${
              active
                ? "border-foreground font-medium text-foreground"
                : "border-transparent text-muted hover:text-foreground"
            }`}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}

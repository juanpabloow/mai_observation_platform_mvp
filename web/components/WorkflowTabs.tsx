"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Tab nav for a workflow. "Executions" is live today; future sibling views
 * (Analytics, Conversations) are placeholders here — adding one later means
 * flipping `enabled` and creating web/app/workflows/[workflowId]/<tab>/page.tsx.
 */
const TABS = [
  { key: "executions", label: "Executions", enabled: true },
  { key: "conversations", label: "Conversations", enabled: true },
  { key: "analytics", label: "Analytics", enabled: false },
];

export function WorkflowTabs({ workflowId }: { workflowId: string }) {
  const pathname = usePathname();
  const base = `/workflows/${encodeURIComponent(workflowId)}`;

  return (
    <nav className="flex gap-1 border-b border-black/10 dark:border-white/10">
      {TABS.map((tab) => {
        const href = `${base}/${tab.key}`;
        const active = pathname.startsWith(href);

        if (!tab.enabled) {
          return (
            <span
              key={tab.key}
              title="Coming soon"
              className="cursor-not-allowed px-3 py-2 text-sm text-neutral-600"
            >
              {tab.label}
            </span>
          );
        }

        return (
          <Link
            key={tab.key}
            href={href}
            className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${
              active
                ? "border-neutral-800 font-medium text-neutral-900 dark:border-white dark:text-white"
                : "border-transparent text-neutral-500 hover:text-neutral-300"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}

"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

const AUTH_PREFIXES = ["/login", "/signup", "/logout"];

/** The workflow-level base path + the workflow slot ("all" for the aggregate view). */
function parseWorkflowRoute(pathname: string): { base: string; slot: string } | null {
  const m = pathname.match(/^(\/clients\/[^/]+\/workflows\/([^/]+))(?:\/|$)/);
  return m ? { base: m[1], slot: m[2] } : null;
}

function SideLink({
  href,
  label,
  active,
}: {
  href: string;
  label: string;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`rounded-lg px-3 py-2 text-sm transition-colors ${
        active
          ? "bg-subtle font-medium text-foreground"
          : "text-muted hover:bg-subtle hover:text-foreground"
      }`}
    >
      {label}
    </Link>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-3 pb-1 pt-3 text-[10px] font-medium uppercase tracking-wider text-faint">
      {children}
    </p>
  );
}

/**
 * Left navigation, below the full-width header. LEVEL-AWARE (the two-level model):
 *  - TENANT level → Hub + Clients & Workflows.
 *  - WORKFLOW level (/clients/[c]/workflows/[w]/…) → ONLY that workflow's features
 *    (Executions / Conversations / Analytics); no tenant-level link by design.
 *    Back to tenant level is via the header (the logo → Hub, and the breadcrumb
 *    client picker, whose default client reads "Hub").
 *  - "ALL WORKFLOWS" (workflow slot = "all", analytics only): Analytics stays on
 *    the aggregate; Executions/Conversations carry ?from so the all/{exec,conv}
 *    redirect routes return the user to the REMEMBERED workflow.
 * Reactive via usePathname/useSearchParams (a root-layout server component would
 * not update on client navigation). Hidden on auth screens + small screens.
 */
export function AppSidebar() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  if (AUTH_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return null;
  }

  const route = parseWorkflowRoute(pathname);
  // On the "all" aggregate view, carry ?from so Executions/Conversations resolve
  // to the remembered workflow (via the all/{exec,conv} redirect routes).
  const from = route?.slot === "all" ? searchParams.get("from") : null;
  const fromQuery = from ? `?from=${encodeURIComponent(from)}` : "";

  return (
    <aside className="hidden w-52 shrink-0 flex-col gap-0.5 border-r border-line bg-sidebar px-3 py-4 md:flex">
      {route ? (
        <>
          <SectionLabel>Workflow</SectionLabel>
          <SideLink
            href={`${route.base}/executions${fromQuery}`}
            label="Executions"
            active={pathname.startsWith(`${route.base}/executions`)}
          />
          <SideLink
            href={`${route.base}/conversations${fromQuery}`}
            label="Conversations"
            active={pathname.startsWith(`${route.base}/conversations`)}
          />
          <SideLink
            href={`${route.base}/analytics${fromQuery}`}
            label="Analytics"
            active={pathname.startsWith(`${route.base}/analytics`)}
          />
        </>
      ) : (
        <>
          <SideLink href="/" label="Hub" active={pathname === "/"} />
          <SideLink
            href="/clients"
            label="Clients & Workflows"
            active={pathname === "/clients" || pathname.startsWith("/clients/")}
          />
        </>
      )}
    </aside>
  );
}

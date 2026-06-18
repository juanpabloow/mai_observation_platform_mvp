"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const AUTH_PREFIXES = ["/login", "/signup", "/logout"];

/** Raw (URL-encoded, as they appear in the path) client + workflow segments. */
function parseWorkflowRoute(pathname: string): { base: string } | null {
  const m = pathname.match(/^(\/clients\/[^/]+\/workflows\/[^/]+)(?:\/|$)/);
  return m ? { base: m[1] } : null;
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
 *    (Executions / Conversations / Analytics-stub); no tenant-level link by design.
 *    Back to tenant level is via the header (the logo → Hub, and the breadcrumb
 *    client picker, whose default client reads "Hub").
 * Reactive via usePathname (a root-layout server component would not update on
 * client navigation). Hidden on the auth screens and on small screens (the header
 * breadcrumb covers navigation there).
 */
export function AppSidebar() {
  const pathname = usePathname();
  if (AUTH_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return null;
  }

  const route = parseWorkflowRoute(pathname);

  return (
    <aside className="hidden w-52 shrink-0 flex-col gap-0.5 border-r border-line bg-sidebar px-3 py-4 md:flex">
      {route ? (
        <>
          <SectionLabel>Workflow</SectionLabel>
          <SideLink
            href={`${route.base}/executions`}
            label="Executions"
            active={pathname.startsWith(`${route.base}/executions`)}
          />
          <SideLink
            href={`${route.base}/conversations`}
            label="Conversations"
            active={pathname.startsWith(`${route.base}/conversations`)}
          />
          <span
            title="Coming soon"
            className="flex cursor-not-allowed items-center justify-between rounded-lg px-3 py-2 text-sm text-faint"
          >
            Analytics
            <span className="rounded-full bg-subtle px-1.5 py-0.5 text-[10px] uppercase tracking-wider">
              Soon
            </span>
          </span>
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

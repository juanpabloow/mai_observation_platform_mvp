"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

const AUTH_PREFIXES = ["/login", "/signup", "/logout"];

/** The workflow-level base path + the workflow slot ("all" for the aggregate view). */
function parseWorkflowRoute(pathname: string): { base: string; slot: string } | null {
  const m = pathname.match(/^(\/clients\/[^/]+\/workflows\/([^/]+))(?:\/|$)/);
  return m ? { base: m[1], slot: m[2] } : null;
}

/** The client id when inside a client (/clients/<id>/…); null at the tenant level. */
function parseClientId(pathname: string): string | null {
  const m = pathname.match(/^\/clients\/([^/]+)(?:\/|$)/);
  return m ? m[1] : null;
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
 * Left navigation, below the full-width header. LEVEL-AWARE (three levels):
 *  - TENANT level → Hub + Clients & Workflows (owner/admin); a member gets a single
 *    "Overview" back to their client (they have no tenant level).
 *  - CLIENT level → a "Client" section with Team (owner/admin only — member
 *    management for that client). Shown whenever inside a client (alongside the
 *    workflow features at a workflow route, or alone on /clients/[c]/team).
 *  - WORKFLOW level (/clients/[c]/workflows/[w]/…) → that workflow's features
 *    (Executions / Conversations / Analytics). On "all" (slot="all"),
 *    Executions/Conversations carry ?from so the redirect routes return to the
 *    remembered workflow.
 * Members never see the Client/Team section (Team is owner/admin only). Reactive
 * via usePathname/useSearchParams. Hidden on auth screens + small screens.
 */
export function AppSidebar({ memberClientId }: { memberClientId: string | null }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  if (AUTH_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return null;
  }

  const route = parseWorkflowRoute(pathname);
  const clientId = parseClientId(pathname);
  const isMember = memberClientId !== null;
  const onTeam = clientId ? pathname.startsWith(`/clients/${clientId}/team`) : false;

  // On the "all" aggregate view, carry ?from so Executions/Conversations resolve
  // to the remembered workflow (via the all/{exec,conv} redirect routes).
  const from = route?.slot === "all" ? searchParams.get("from") : null;
  const fromQuery = from ? `?from=${encodeURIComponent(from)}` : "";

  // CLIENT section — owner/admin inside a client (member management for it).
  const clientSection =
    clientId && !isMember ? (
      <>
        <SectionLabel>Client</SectionLabel>
        <SideLink href={`/clients/${clientId}/team`} label="Team" active={onTeam} />
      </>
    ) : null;

  // WORKFLOW section — that workflow's features.
  const workflowSection = route ? (
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
  ) : null;

  let body: React.ReactNode;
  if (route) {
    // Workflow level: features + (owner/admin) the client's Team.
    body = (
      <>
        {clientSection}
        {workflowSection}
      </>
    );
  } else if (clientId && !isMember) {
    // Client-level non-workflow route (e.g. /clients/[c]/team).
    body = clientSection;
  } else if (isMember) {
    // Member at a tenant-level route (e.g. /executions/[id]) — back to their client.
    body = (
      <>
        <SectionLabel>Client</SectionLabel>
        <SideLink href={`/clients/${memberClientId}/workflows/all/analytics`} label="Overview" active={false} />
      </>
    );
  } else {
    // Owner/admin tenant level.
    body = (
      <>
        <SideLink href="/" label="Hub" active={pathname === "/"} />
        <SideLink
          href="/clients"
          label="Clients & Workflows"
          active={pathname === "/clients" || pathname.startsWith("/clients/")}
        />
      </>
    );
  }

  return (
    <aside className="hidden w-52 shrink-0 flex-col gap-0.5 border-r border-line bg-sidebar px-3 py-4 md:flex">
      {body}
    </aside>
  );
}

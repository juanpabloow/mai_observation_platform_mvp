"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useSidebar } from "@/components/SidebarContext";
import { InboxTabLink } from "@/components/InboxTabLink";

const AUTH_PREFIXES = ["/login", "/signup", "/logout"];

/** A tenant workflow (id + owning client) — the minimum the rail needs to keep the
 * workflow tabs pointing at a real workflow from the client-level Team page. */
export interface SidebarWorkflow {
  id: string;
  clientId: string;
  name: string | null;
}

/** Workflow-level base path + clientId + slot ("all" for the aggregate view). */
function parseWorkflowRoute(
  pathname: string,
): { base: string; clientId: string; slot: string } | null {
  const m = pathname.match(/^\/clients\/([^/]+)\/workflows\/([^/]+)/);
  return m ? { base: `/clients/${m[1]}/workflows/${m[2]}`, clientId: m[1], slot: m[2] } : null;
}

/** The client id when inside a client (/clients/<id>/…); null at the tenant level. */
function parseClientId(pathname: string): string | null {
  const m = pathname.match(/^\/clients\/([^/]+)(?:\/|$)/);
  return m ? m[1] : null;
}

function SideLink({ href, label, active }: { href: string; label: string; active: boolean }) {
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

/** A workflow tab shown but inert — only when a client has zero workflows (so the
 * Team tab still works while the workflow tabs have nowhere to point). */
function DisabledItem({ label }: { label: string }) {
  return (
    <span
      aria-disabled
      title="No workflows in this client yet"
      className="cursor-default rounded-lg px-3 py-2 text-sm text-faint/60"
    >
      {label}
    </span>
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
 * Left navigation, below the full-width header.
 *
 * INSIDE A CLIENT the rail is a SINGLE STABLE LIST — Executions, Conversations,
 * Analytics, and (owner/admin) Team — always shown together; clicking any one just
 * swaps the content, the list never rearranges or hides items. Executions/
 * Conversations/Analytics are workflow-level and Team is client-level, so the rail
 * keeps the workflow tabs pointed at a CONTEXT WORKFLOW:
 *   - on a workflow route → that workflow (the "all" aggregate carries ?from, as
 *     the All-workflows view already does);
 *   - on the client-level Team route → the remembered workflow (?from, the CL-5c
 *     idea), else the client's first workflow, else the tabs render disabled (a
 *     client with members but no workflows is valid — Team still works).
 * Team always carries the context workflow as ?from, so returning to a workflow tab
 * lands on the one you came from.
 *
 * OUTSIDE A CLIENT: owner/admin get Hub + Clients & Workflows; a member (who has no
 * tenant level) gets a single link back to their client. Members never see Team.
 *
 * Reactive via usePathname/useSearchParams. Hidden on auth screens + small screens.
 */
export function AppSidebar({
  memberClientId,
  workflows,
}: {
  memberClientId: string | null;
  workflows: SidebarWorkflow[];
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { collapsed } = useSidebar();
  if (AUTH_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return null;
  }
  // Hidden by the toggle → the content region fills the freed space (flex).
  if (collapsed) return null;

  const route = parseWorkflowRoute(pathname);
  const clientId = route?.clientId ?? parseClientId(pathname);
  const isMember = memberClientId !== null;

  const railClass =
    "hidden w-52 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-line bg-sidebar px-3 py-4 md:flex";

  // ── Inside a client: the stable Executions/Conversations/Analytics/Team list ──
  if (clientId) {
    const onTeam = pathname.startsWith(`/clients/${clientId}/team`);

    // The workflow the tabs point at, the ?from they carry (the "all" case), and
    // the workflow to remember when opening Team.
    let wfBase: string | null;
    let wfQuery = "";
    let teamFrom: string | null;

    if (route) {
      wfBase = route.base; // /clients/<c>/workflows/<slot>
      if (route.slot === "all") {
        // Aggregate view: carry ?from so Executions/Conversations redirect back to
        // the remembered workflow (unchanged All-workflows behavior).
        const from = searchParams.get("from");
        wfQuery = from ? `?from=${encodeURIComponent(from)}` : "";
        teamFrom = from;
      } else {
        teamFrom = route.slot; // the actual workflow we're viewing
      }
    } else {
      // Client-level (Team) route: resolve the remembered (?from) or first workflow.
      const clientWorkflows = workflows
        .filter((w) => w.clientId === clientId)
        .sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id));
      const from = searchParams.get("from");
      const w =
        from && clientWorkflows.some((x) => x.id === from)
          ? from
          : (clientWorkflows[0]?.id ?? null);
      wfBase = w ? `/clients/${clientId}/workflows/${encodeURIComponent(w)}` : null;
      teamFrom = w;
    }

    const teamHref = `/clients/${clientId}/team${teamFrom ? `?from=${encodeURIComponent(teamFrom)}` : ""}`;

    return (
      <aside className={railClass}>
        {wfBase ? (
          <>
            <SideLink
              href={`${wfBase}/executions${wfQuery}`}
              label="Executions"
              active={pathname.startsWith(`${wfBase}/executions`)}
            />
            {/* H-7: the Inbox tab carries a LIVE per-workflow pending badge (the
                client-level attention badge was removed with the attention surface).
                Active on the inbox route AND the settings surface (still under
                /conversations/settings). teamFrom is the context workflow id. */}
            {teamFrom ? (
              <InboxTabLink
                href={`${wfBase}/inbox${wfQuery}`}
                active={
                  pathname.startsWith(`${wfBase}/inbox`) ||
                  pathname.startsWith(`${wfBase}/conversations`)
                }
                countEndpoint={`/api/inbox/${clientId}/workflows/${encodeURIComponent(teamFrom)}/pending-count`}
                label="Inbox"
              />
            ) : (
              <SideLink
                href={`${wfBase}/inbox${wfQuery}`}
                label="Inbox"
                active={pathname.startsWith(`${wfBase}/inbox`)}
              />
            )}
            <SideLink
              href={`${wfBase}/analytics${wfQuery}`}
              label="Analytics"
              active={pathname.startsWith(`${wfBase}/analytics`)}
            />
          </>
        ) : (
          // Owner/admin on an empty client's Team page: tabs have no target.
          <>
            <DisabledItem label="Executions" />
            <DisabledItem label="Inbox" />
            <DisabledItem label="Analytics" />
          </>
        )}
        {/* Team is owner/admin only — a member never sees it. */}
        {!isMember ? <SideLink href={teamHref} label="Team" active={onTeam} /> : null}
      </aside>
    );
  }

  // ── Outside a client ──
  if (isMember) {
    // A member has no tenant level — link back to their client's overview.
    return (
      <aside className={railClass}>
        <SectionLabel>Client</SectionLabel>
        <SideLink
          href={`/clients/${memberClientId}/workflows/all/analytics`}
          label="Overview"
          active={false}
        />
      </aside>
    );
  }

  // Owner/admin tenant level.
  return (
    <aside className={railClass}>
      <SideLink href="/" label="Hub" active={pathname === "/"} />
      <SideLink
        href="/clients"
        label="Clients & Workflows"
        active={pathname === "/clients" || pathname.startsWith("/clients/")}
      />
    </aside>
  );
}

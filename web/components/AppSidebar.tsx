"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSidebar } from "@/components/SidebarContext";
import { InboxTabLink } from "@/components/InboxTabLink";

const AUTH_PREFIXES = ["/login", "/signup", "/logout", "/forgot-password", "/reset-password"];

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
 * INSIDE A CLIENT the rail is grouped by category (final design):
 *   AUTOMATION   → Workflows (the client's workflow LIST at /clients/<c>/workflows,
 *                  active across every /workflows/… route) and Overview (the
 *                  aggregate "All workflows" analytics).
 *   CONVERSATIONS→ Inbox — the client-level UNIFIED inbox with a live AGGREGATED
 *                  pending badge. NEVER nested under a workflow.
 *   CRM          → Contacts (iff the crm module is enabled).
 *   SCHEDULING   → Agenda (iff the scheduling module is enabled).
 *   ADMINISTRATION (owner/admin only) → Team, and Modules (hidden for the real
 *                  default/"Unassigned" client, which can't have modules).
 * NO individual workflow names appear in the rail — switching workflows is the
 * header's job (the workflow switcher) and the Workflows list page. A member never
 * receives any other client's data.
 *
 * OUTSIDE A CLIENT: owner/admin get Hub + Clients & Workflows; a member (who has no
 * tenant level) gets a single link back to their client. Members never see Team.
 *
 * Reactive via usePathname. Hidden on auth screens + small screens.
 */
export function AppSidebar({
  memberClientId,
  defaultClientId,
  enabledModules,
}: {
  memberClientId: string | null;
  /** The tenant's default/"Unassigned" client id (owner/admin; null for members
   * or logged-out) — the rail hides Modules for it (it can't have modules). */
  defaultClientId: string | null;
  /** clientId → ENABLED module keys (server-resolved). Owner/admin: the whole
   * tenant; member: only their client. Drives the Contacts/Agenda links. */
  enabledModules: Record<string, string[]>;
}) {
  const pathname = usePathname();
  const { collapsed } = useSidebar();
  if (AUTH_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return null;
  }
  // Hidden by the toggle → the content region fills the freed space (flex).
  if (collapsed) return null;

  const clientId = parseClientId(pathname);
  const isMember = memberClientId !== null;

  const railClass =
    "hidden w-52 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-line bg-sidebar px-3 py-4 md:flex";

  // ── Inside a client (final design): grouped categories. AUTOMATION (Workflows +
  // Overview), CONVERSATIONS (Inbox), CRM, SCHEDULING, ADMINISTRATION. NO individual
  // workflow names — the header switcher + the Workflows list page own that. ──
  if (clientId) {
    const onTeam = pathname.startsWith(`/clients/${clientId}/team`);
    const onModules = pathname.startsWith(`/clients/${clientId}/modules`);
    const onInbox = pathname.startsWith(`/clients/${clientId}/inbox`);
    // Workflows stays active across EVERY /workflows/… route (the list page, the
    // aggregate, and any specific workflow's Executions/Analytics).
    const onWorkflows = pathname.startsWith(`/clients/${clientId}/workflows`);

    // This client's ENABLED modules (server-resolved; [] when none/unknown).
    const clientModuleKeys = enabledModules[clientId] ?? [];
    const overviewHref = `/clients/${clientId}/workflows/all/analytics`;

    return (
      <aside className={railClass}>
        <SectionLabel>Automation</SectionLabel>
        {/* Workflows FIRST — the client's workflow list; active on all /workflows/…. */}
        <SideLink href={`/clients/${clientId}/workflows`} label="Workflows" active={onWorkflows} />
        <SideLink href={overviewHref} label="Overview" active={pathname === overviewHref} />

        <SectionLabel>Conversations</SectionLabel>
        {/* Client-level unified Inbox with a LIVE aggregated pending badge across ALL
            the client's workflows. Never nested under a workflow. */}
        <InboxTabLink
          href={`/clients/${clientId}/inbox`}
          active={onInbox}
          countEndpoint={`/api/inbox/${clientId}/pending-count`}
          label="Inbox"
        />

        {/* Per-client MODULE surfaces: Contacts iff crm enabled, Agenda iff scheduling
            enabled — client-scoped routes, for every role on this rail. */}
        {clientModuleKeys.includes("crm") ? (
          <>
            <SectionLabel>CRM</SectionLabel>
            <SideLink
              href={`/clients/${clientId}/contacts`}
              label="Contacts"
              active={pathname.startsWith(`/clients/${clientId}/contacts`)}
            />
          </>
        ) : null}
        {clientModuleKeys.includes("scheduling") ? (
          <>
            <SectionLabel>Scheduling</SectionLabel>
            <SideLink
              href={`/clients/${clientId}/scheduling/agenda`}
              label="Agenda"
              active={pathname.startsWith(`/clients/${clientId}/scheduling`)}
            />
          </>
        ) : null}

        {/* Team + Modules are owner/admin only — a member never sees either. Both are
            CLIENT-level routes, so they work even when the client has zero workflows.
            Modules is additionally hidden for the DEFAULT ("Unassigned") client —
            identified by its real is_default id, never by name — since it can't have
            modules (the page 404s and the action refuses). */}
        {!isMember ? (
          <>
            <SectionLabel>Administration</SectionLabel>
            <SideLink href={`/clients/${clientId}/team`} label="Team" active={onTeam} />
            {clientId !== defaultClientId ? (
              <SideLink href={`/clients/${clientId}/modules`} label="Modules" active={onModules} />
            ) : null}
          </>
        ) : null}
      </aside>
    );
  }

  // ── Outside a client ──
  if (isMember) {
    // A member has no tenant level — link back to their client's overview, plus
    // ONLY the module surfaces enabled for THEIR client (client-scoped routes).
    // No "Scheduling admin" — sites/staff/services CRUD is owner/admin only.
    const memberModules = enabledModules[memberClientId] ?? [];
    return (
      <aside className={railClass}>
        <SectionLabel>Client</SectionLabel>
        <SideLink
          href={`/clients/${memberClientId}/workflows/all/analytics`}
          label="Overview"
          active={false}
        />
        {memberModules.includes("crm") ? (
          <SideLink
            href={`/clients/${memberClientId}/contacts`}
            label="Contacts"
            active={pathname.startsWith(`/clients/${memberClientId}/contacts`)}
          />
        ) : null}
        {memberModules.includes("scheduling") ? (
          <SideLink
            href={`/clients/${memberClientId}/scheduling/agenda`}
            label="Agenda"
            active={pathname.startsWith(`/clients/${memberClientId}/scheduling`)}
          />
        ) : null}
      </aside>
    );
  }

  // Owner/admin tenant level. Agenda/Contacts are CLIENT-scoped now (Phase 3A) —
  // no global aggregate links; the tenant-level Scheduling admin stays (the
  // services catalogue is tenant-level, see /scheduling/admin).
  return (
    <aside className={railClass}>
      <SideLink href="/" label="Hub" active={pathname === "/"} />
      <SideLink
        href="/clients"
        label="Clients & Workflows"
        active={pathname === "/clients" || pathname.startsWith("/clients/")}
      />
      <SectionLabel>Scheduling</SectionLabel>
      <SideLink
        href="/scheduling/admin"
        label="Scheduling admin"
        active={pathname.startsWith("/scheduling/admin")}
      />
    </aside>
  );
}

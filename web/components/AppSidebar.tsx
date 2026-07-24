"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useSidebar } from "@/components/SidebarContext";
import { InboxTabLink } from "@/components/InboxTabLink";
import { AccountMenu } from "@/components/AccountMenu";

const AUTH_PREFIXES = ["/login", "/signup", "/logout", "/forgot-password", "/reset-password"];

/** The client id when inside a client (/clients/<id>/…); null at the tenant level. */
function parseClientId(pathname: string): string | null {
  const m = pathname.match(/^\/clients\/([^/]+)(?:\/|$)/);
  return m ? m[1] : null;
}

// ── Inline SVG icon set (no icon dependency is installed; the app uses inline SVG).
// 18px, 1.5 stroke, currentColor — consistent weight across the rail. ─────────────
const iconCls = "size-[18px] shrink-0";
const Icon = {
  workflows: (
    <svg viewBox="0 0 24 24" className={iconCls} fill="none" aria-hidden>
      <rect x="3" y="3" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
      <rect x="15" y="15" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M9 6h4a3 3 0 0 1 3 3v6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  ),
  overview: (
    <svg viewBox="0 0 24 24" className={iconCls} fill="none" aria-hidden>
      <rect x="3" y="3" width="8" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
      <rect x="3" y="15" width="8" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
      <rect x="14" y="3" width="7" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  ),
  inbox: (
    <svg viewBox="0 0 24 24" className={iconCls} fill="none" aria-hidden>
      <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5.5Z" stroke="currentColor" strokeWidth="1.6" />
      <path d="M4 14h4a2 2 0 0 0 4 0h8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  contacts: (
    <svg viewBox="0 0 24 24" className={iconCls} fill="none" aria-hidden>
      <circle cx="12" cy="8" r="3.25" stroke="currentColor" strokeWidth="1.6" />
      <path d="M5.5 19a6.5 6.5 0 0 1 13 0" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  ),
  agenda: (
    <svg viewBox="0 0 24 24" className={iconCls} fill="none" aria-hidden>
      <rect x="4" y="5" width="16" height="15" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M4 9h16M8 3v4M16 3v4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  ),
  team: (
    <svg viewBox="0 0 24 24" className={iconCls} fill="none" aria-hidden>
      <circle cx="9" cy="8" r="3" stroke="currentColor" strokeWidth="1.6" />
      <path d="M3.5 19a5.5 5.5 0 0 1 11 0" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M16 6.2a3 3 0 0 1 0 5.6M17.5 19a5.5 5.5 0 0 0-3-4.9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  ),
  modules: (
    <svg viewBox="0 0 24 24" className={iconCls} fill="none" aria-hidden>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  ),
  hub: (
    <svg viewBox="0 0 24 24" className={iconCls} fill="none" aria-hidden>
      <path d="M4 11 12 4l8 7M6 9.5V19h12V9.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  clients: (
    <svg viewBox="0 0 24 24" className={iconCls} fill="none" aria-hidden>
      <rect x="4" y="4" width="9" height="16" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M13 9h6a1.5 1.5 0 0 1 1.5 1.5V20M7 8h3M7 12h3M7 16h3M16 13h1.5M16 16h1.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  ),
  schedulingAdmin: (
    <svg viewBox="0 0 24 24" className={iconCls} fill="none" aria-hidden>
      <rect x="4" y="5" width="16" height="15" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M4 9h16M8 3v4M16 3v4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="12" cy="14.5" r="1.6" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  ),
} as const;

interface NavItem {
  key: string;
  label: string;
  href: string;
  icon: ReactNode;
  active: boolean;
  /** When set, render the polling InboxTabLink (live aggregated pending badge). */
  countEndpoint?: string;
}
interface NavSection {
  label: string;
  items: NavItem[];
}

/** One static nav row (icon + label expanded, icon-only + tooltip collapsed). */
function NavLink({
  item,
  collapsed,
  onNavigate,
}: {
  item: NavItem;
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  const base = `group relative flex items-center rounded-lg text-sm transition-colors ${
    collapsed ? "justify-center px-0 py-2" : "gap-2.5 px-3 py-2"
  } ${
    item.active
      ? "bg-subtle font-medium text-foreground"
      : "text-muted hover:bg-subtle hover:text-foreground"
  }`;
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={item.active ? "page" : undefined}
      aria-label={collapsed ? item.label : undefined}
      title={collapsed ? item.label : undefined}
      className={base}
    >
      <span className="shrink-0" aria-hidden>
        {item.icon}
      </span>
      {collapsed ? null : <span className="flex-1 truncate">{item.label}</span>}
    </Link>
  );
}

function SectionHeader({ label, collapsed, first }: { label: string; collapsed: boolean; first: boolean }) {
  if (collapsed) {
    // A hairline divider stands in for the label; the group still carries aria-label.
    return first ? null : <div aria-hidden className="mx-2 my-2 border-t border-line" />;
  }
  return (
    <p className={`px-3 pb-1 text-[10px] font-medium uppercase tracking-wider text-faint ${first ? "pt-1" : "pt-4"}`}>
      {label}
    </p>
  );
}

/** Avatar circle with the user's initial. */
function Avatar({ initial }: { initial: string }) {
  return (
    <span
      aria-hidden
      className="flex size-7 shrink-0 items-center justify-center rounded-full border border-line-strong bg-subtle text-xs font-semibold text-foreground"
    >
      {initial}
    </span>
  );
}

interface Account {
  email: string;
  role: "owner" | "admin" | "member";
  clientLabel: string | null;
  canSwitchClients: boolean;
}

/** The rail contents (nav + fixed account footer), shared by the desktop rail and
 * the mobile drawer. `collapsed` only ever true on desktop. */
function RailBody({
  sections,
  collapsed,
  account,
  onNavigate,
}: {
  sections: NavSection[];
  collapsed: boolean;
  account: Account;
  onNavigate?: () => void;
}) {
  const [acctOpen, setAcctOpen] = useState(false);
  const footerRef = useRef<HTMLDivElement>(null);

  // Close the account popover on outside click / Escape.
  useEffect(() => {
    if (!acctOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (footerRef.current && !footerRef.current.contains(e.target as Node)) setAcctOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAcctOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [acctOpen]);

  const initial = account.email.trim()[0]?.toUpperCase() ?? "?";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <nav
        aria-label="Primary"
        className={`flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto py-3 ${collapsed ? "px-2" : "px-3"}`}
      >
        {sections.map((section, i) => (
          <div key={section.label} role="group" aria-label={section.label} className="flex flex-col gap-0.5">
            <SectionHeader label={section.label} collapsed={collapsed} first={i === 0} />
            {section.items.map((item) =>
              item.countEndpoint ? (
                <InboxTabLink
                  key={item.key}
                  href={item.href}
                  active={item.active}
                  countEndpoint={item.countEndpoint}
                  label={item.label}
                  icon={item.icon}
                  collapsed={collapsed}
                  onNavigate={onNavigate}
                />
              ) : (
                <NavLink key={item.key} item={item} collapsed={collapsed} onNavigate={onNavigate} />
              ),
            )}
          </div>
        ))}
      </nav>

      {/* Fixed account footer — opens the SHARED account menu (same one the header
          uses). Flyout above when expanded, to the right when collapsed. */}
      <div ref={footerRef} className={`relative shrink-0 border-t border-line ${collapsed ? "p-2" : "p-3"}`}>
        <button
          type="button"
          onClick={() => setAcctOpen((o) => !o)}
          aria-haspopup="menu"
          aria-expanded={acctOpen}
          aria-label={collapsed ? `Account: ${account.email}` : undefined}
          title={collapsed ? account.email : undefined}
          className={`flex w-full items-center rounded-lg text-sm text-muted transition-colors hover:bg-subtle hover:text-foreground ${
            collapsed ? "justify-center p-1" : "gap-2.5 px-2 py-1.5"
          }`}
        >
          <Avatar initial={initial} />
          {collapsed ? null : (
            <span className="flex min-w-0 flex-1 flex-col text-left">
              <span className="truncate text-sm font-medium text-foreground">{account.email}</span>
              <span className="truncate text-xs capitalize text-faint">{account.role}</span>
            </span>
          )}
        </button>

        {acctOpen ? (
          <div
            role="menu"
            className={`absolute z-50 overflow-hidden rounded-xl border border-line bg-background shadow-xl ${
              collapsed ? "bottom-2 left-full ml-2 w-60" : "inset-x-2 bottom-full mb-2"
            }`}
          >
            <AccountMenu
              email={account.email}
              role={account.role}
              clientLabel={account.clientLabel}
              canSwitchClients={account.canSwitchClients}
              onNavigate={() => {
                setAcctOpen(false);
                onNavigate?.();
              }}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Left navigation, below the full-width header.
 *
 * INSIDE A CLIENT the rail is grouped by category (final visual design):
 *   AUTOMATION    → Workflows (the client's workflow LIST, active across every
 *                   /workflows/… route) then Overview (the aggregate analytics).
 *   CONVERSATIONS → Inbox — the client-level UNIFIED inbox with a live AGGREGATED
 *                   pending badge; never nested under a workflow.
 *   CRM           → Contacts (iff the crm module is enabled).
 *   SCHEDULING    → Agenda (iff the scheduling module is enabled).
 *   ADMINISTRATION (owner/admin only) → Team, and Modules (hidden for the real
 *                   default/"Unassigned" client, which can't have modules).
 * NO individual workflow names appear in the rail — switching workflows is the
 * header's job (the workflow switcher) and the Workflows list page.
 *
 * OUTSIDE A CLIENT: owner/admin get Hub + Clients & Workflows + Scheduling admin; a
 * member gets a link back to their client. Members never see Team.
 *
 * Three responsive states: full rail (≥md), collapsed icon-only rail (≥md, toggled),
 * and an off-canvas drawer (<md). A fixed footer opens the shared account menu.
 * Reactive via usePathname; hidden on auth screens.
 */
export function AppSidebar({
  memberClientId,
  defaultClientId,
  enabledModules,
  email,
  role,
  clientLabel,
}: {
  memberClientId: string | null;
  /** The tenant's default/"Unassigned" client id (owner/admin; null for members or
   * logged-out) — the rail hides Modules for it (it can't have modules). */
  defaultClientId: string | null;
  /** clientId → ENABLED module keys (server-resolved). Drives Contacts/Agenda. */
  enabledModules: Record<string, string[]>;
  /** Signed-in user identity for the footer account menu. */
  email: string;
  role: "owner" | "admin" | "member";
  clientLabel: string | null;
}) {
  const pathname = usePathname();
  const { collapsed, mobileOpen, setMobileOpen } = useSidebar();

  // Escape closes the mobile drawer (the listener lives in an effect; it only calls
  // setState from an event callback, never synchronously in the effect body).
  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobileOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [mobileOpen, setMobileOpen]);

  if (AUTH_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return null;
  }

  const clientId = parseClientId(pathname);
  const isMember = memberClientId !== null;
  const account: Account = {
    email,
    role,
    clientLabel,
    canSwitchClients: memberClientId === null,
  };

  // Build the section model for the current context.
  let sections: NavSection[];
  if (clientId) {
    const moduleKeys = enabledModules[clientId] ?? [];
    const c = (p: string) => `/clients/${clientId}${p}`;
    const automation: NavItem[] = [
      {
        key: "workflows",
        label: "Workflows",
        href: c("/workflows"),
        icon: Icon.workflows,
        active: pathname.startsWith(c("/workflows")),
      },
      {
        key: "overview",
        label: "Overview",
        href: c("/workflows/all/analytics"),
        icon: Icon.overview,
        active: pathname === c("/workflows/all/analytics"),
      },
    ];
    const conversations: NavItem[] = [
      {
        key: "inbox",
        label: "Inbox",
        href: c("/inbox"),
        icon: Icon.inbox,
        active: pathname.startsWith(c("/inbox")),
        countEndpoint: `/api/inbox/${clientId}/pending-count`,
      },
    ];
    sections = [
      { label: "Automation", items: automation },
      { label: "Conversations", items: conversations },
    ];
    if (moduleKeys.includes("crm")) {
      sections.push({
        label: "CRM",
        items: [
          { key: "contacts", label: "Contacts", href: c("/contacts"), icon: Icon.contacts, active: pathname.startsWith(c("/contacts")) },
        ],
      });
    }
    if (moduleKeys.includes("scheduling")) {
      sections.push({
        label: "Scheduling",
        items: [
          { key: "agenda", label: "Agenda", href: c("/scheduling/agenda"), icon: Icon.agenda, active: pathname.startsWith(c("/scheduling")) },
        ],
      });
    }
    if (!isMember) {
      const admin: NavItem[] = [
        { key: "team", label: "Team", href: c("/team"), icon: Icon.team, active: pathname.startsWith(c("/team")) },
      ];
      // Modules is hidden for the DEFAULT client (it can't have modules).
      if (clientId !== defaultClientId) {
        admin.push({ key: "modules", label: "Modules", href: c("/modules"), icon: Icon.modules, active: pathname.startsWith(c("/modules")) });
      }
      sections.push({ label: "Administration", items: admin });
    }
  } else if (isMember) {
    const m = (p: string) => `/clients/${memberClientId}${p}`;
    const memberModules = enabledModules[memberClientId] ?? [];
    const items: NavItem[] = [
      { key: "overview", label: "Overview", href: m("/workflows/all/analytics"), icon: Icon.overview, active: false },
    ];
    if (memberModules.includes("crm")) {
      items.push({ key: "contacts", label: "Contacts", href: m("/contacts"), icon: Icon.contacts, active: pathname.startsWith(m("/contacts")) });
    }
    if (memberModules.includes("scheduling")) {
      items.push({ key: "agenda", label: "Agenda", href: m("/scheduling/agenda"), icon: Icon.agenda, active: pathname.startsWith(m("/scheduling")) });
    }
    sections = [{ label: "Client", items }];
  } else {
    // Owner/admin tenant level.
    sections = [
      {
        label: "Workspace",
        items: [
          { key: "hub", label: "Hub", href: "/", icon: Icon.hub, active: pathname === "/" },
          {
            key: "clients",
            label: "Clients & Workflows",
            href: "/clients",
            icon: Icon.clients,
            active: pathname === "/clients" || pathname.startsWith("/clients/"),
          },
        ],
      },
      {
        label: "Scheduling",
        items: [
          { key: "sched-admin", label: "Scheduling admin", href: "/scheduling/admin", icon: Icon.schedulingAdmin, active: pathname.startsWith("/scheduling/admin") },
        ],
      },
    ];
  }

  return (
    <>
      {/* DESKTOP rail — full (w-60) or collapsed icon-only (w-16). */}
      <aside
        data-collapsed={collapsed}
        className={`hidden shrink-0 flex-col border-r border-line bg-sidebar transition-[width] duration-200 md:flex ${
          collapsed ? "w-16" : "w-60"
        }`}
      >
        <RailBody sections={sections} collapsed={collapsed} account={account} />
      </aside>

      {/* MOBILE drawer — off-canvas, over a backdrop. Always expanded content. */}
      {mobileOpen ? (
        <div className="md:hidden">
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => setMobileOpen(false)}
            className="fixed inset-0 z-40 bg-black/40"
          />
          <aside
            aria-label="Sidebar"
            className="fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-line bg-background shadow-xl"
          >
            <RailBody
              sections={sections}
              collapsed={false}
              account={account}
              onNavigate={() => setMobileOpen(false)}
            />
          </aside>
        </div>
      ) : null}
    </>
  );
}

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useSidebar } from "@/components/SidebarContext";
import { useScope } from "@/components/ScopeProvider";
import { scopeHref } from "@/lib/scopeSurface";
import { InboxTabLink } from "@/components/InboxTabLink";
import { AccountMenu } from "@/components/AccountMenu";
import { RAIL_ROW } from "@/components/railRow";

const AUTH_PREFIXES = ["/login", "/signup", "/logout", "/forgot-password", "/reset-password"];

/** The client id when inside a client (/clients/<id>/…); null at the tenant level. */
function parseClientId(pathname: string): string | null {
  const m = pathname.match(/^\/clients\/([^/]+)(?:\/|$)/);
  return m ? m[1] : null;
}

// ── Inline SVG icon set (no icon dependency is installed; the app uses inline SVG).
// 18px, 1.5 stroke, currentColor — consistent weight across the rail. ─────────────
/* 17px. The design specifies 15px against its own 13.5px label; at the 14px label this
   rail actually renders, 15px read as a smaller glyph beside a bigger word. */
const iconCls = "size-[0.9375rem] shrink-0";

const Icon = {
  workflows: (
    <svg viewBox="0 0 24 24" className={iconCls} fill="none" aria-hidden>
      <rect x="3" y="3" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      <rect x="15" y="15" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M9 6h4a3 3 0 0 1 3 3v6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  ),
  overview: (
    <svg viewBox="0 0 24 24" className={iconCls} fill="none" aria-hidden>
      <rect x="3" y="3" width="8" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      <rect x="3" y="15" width="8" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      <rect x="14" y="3" width="7" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  ),
  inbox: (
    <svg viewBox="0 0 24 24" className={iconCls} fill="none" aria-hidden>
      <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5.5Z" stroke="currentColor" strokeWidth="1.4" />
      <path d="M4 14h4a2 2 0 0 0 4 0h8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  contacts: (
    <svg viewBox="0 0 24 24" className={iconCls} fill="none" aria-hidden>
      <circle cx="12" cy="8" r="3.25" stroke="currentColor" strokeWidth="1.4" />
      <path d="M5.5 19a6.5 6.5 0 0 1 13 0" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  ),
  agenda: (
    <svg viewBox="0 0 24 24" className={iconCls} fill="none" aria-hidden>
      <rect x="4" y="5" width="16" height="15" rx="2" stroke="currentColor" strokeWidth="1.4" />
      <path d="M4 9h16M8 3v4M16 3v4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  ),
  team: (
    <svg viewBox="0 0 24 24" className={iconCls} fill="none" aria-hidden>
      <circle cx="9" cy="8" r="3" stroke="currentColor" strokeWidth="1.4" />
      <path d="M3.5 19a5.5 5.5 0 0 1 11 0" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M16 6.2a3 3 0 0 1 0 5.6M17.5 19a5.5 5.5 0 0 0-3-4.9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  ),
  modules: (
    <svg viewBox="0 0 24 24" className={iconCls} fill="none" aria-hidden>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  ),
  hub: (
    <svg viewBox="0 0 24 24" className={iconCls} fill="none" aria-hidden>
      <path d="M4 11 12 4l8 7M6 9.5V19h12V9.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  clients: (
    <svg viewBox="0 0 24 24" className={iconCls} fill="none" aria-hidden>
      <rect x="4" y="4" width="9" height="16" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M13 9h6a1.5 1.5 0 0 1 1.5 1.5V20M7 8h3M7 12h3M7 16h3M16 13h1.5M16 16h1.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  ),
  schedulingAdmin: (
    <svg viewBox="0 0 24 24" className={iconCls} fill="none" aria-hidden>
      <rect x="4" y="5" width="16" height="15" rx="2" stroke="currentColor" strokeWidth="1.4" />
      <path d="M4 9h16M8 3v4M16 3v4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="12" cy="14.5" r="1.6" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  ),
  settings: (
    <svg viewBox="0 0 24 24" className={iconCls} fill="none" aria-hidden>
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6 18 18M18 6l-1.4 1.4M7.4 16.6 6 18"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
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
  // The ACTIVE row is a SOLID BRAND fill with white text — the single strongest mark in
  // the shell, so "where am I" is answered at a glance and only ever by one row.
  // Everything else is quiet metadata grey until hovered, and hover is a change of
  // GROUND, never a hue (see --sidebar-hover-dark in globals.css).
  //
  // DENSITY is the design's (`padding: 8px 18px`, no min-height, no gap between rows):
  // ~32px per row against the 40px `min-h-10` this used to force. Eleven rows at 40px
  // pushed Administration toward the fold on a laptop and made the rail read as a
  // marketing menu rather than as a tool's chrome.
  //
  // The active row is INSET (`mx-2.5`) rather than full-bleed: a red band running edge to
  // edge is a second border on the content, where an inset pill reads as an object in a
  // list. The idle rows carry the same inset as transparent margin, so nothing shifts by
  // a pixel when selection moves.
  const base = `${RAIL_ROW} ${
    collapsed ? "justify-center px-0 py-2.5" : "gap-3 px-2.5 py-2.5"
  } ${
    item.active
      ? "bg-nav-active font-semibold text-white"
      : "text-sidebar-muted hover:bg-sidebar-hover hover:text-sidebar-fg"
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
    return first ? null : <div aria-hidden className="mx-2 my-2 border-t border-sidebar-border" />;
  }
  // 18px of side padding to line the label up with the row TEXT (a row is inset 10px and
  // padded 8px), and the design's 6px below / 16px above the next group.
  return <p className={`u-th-sidebar px-[18px] pb-1.5 ${first ? "pt-0.5" : "pt-4"}`}>{label}</p>;
}

/**
 * The BRAND block at the top of the rail (final design): the red mark plus the
 * wordmark, linking home. It lives here — not in the header — because the sidebar
 * is now the full-height first column, so the brand sits above the nav and the
 * header starts after the rail.
 */
function Brand({ homeHref, collapsed, onNavigate }: { homeHref: string; collapsed: boolean; onNavigate?: () => void }) {
  return (
    <div
      // NO bottom rule. The brand is part of the rail, not a titlebar over it: a hairline
      // here cut the rail into two panels and made the first section heading look like it
      // belonged to a different list. The padding below is the separation.
      className={`flex h-[var(--topbar-height)] shrink-0 items-center ${
        collapsed ? "justify-center px-2" : "px-[18px]"
      }`}
    >
      <Link
        href={homeHref}
        onClick={onNavigate}
        aria-label="M_AI — home"
        title={collapsed ? "M_AI — home" : undefined}
        className="flex items-center gap-2.5 rounded-md transition-opacity hover:opacity-80"
      >
        <span aria-hidden className="size-6 shrink-0 rounded bg-nav-active" />
        {collapsed ? null : (
          <span className="text-[0.9375rem] font-semibold tracking-tight text-sidebar-fg">M_AI</span>
        )}
      </Link>
    </div>
  );
}

/**
 * The account disc in the rail's footer — a two-tone gradient SPHERE, the same object the
 * contacts table and the inbox queue draw (see `.u-avatar-*` in globals.css).
 *
 * CRM Color Refactor: the profile footer avatar is a NEUTRAL squared tile (design frame
 * 20f) — dark fill, hairline, mono initials — not an identity-coloured disc. The account
 * owner is the one person the rail already names in words right beside it, so it needs no
 * colour to be found.
 */
function Avatar({ initial }: { initial: string }) {
  return (
    <span
      aria-hidden
      className="u-mono flex size-[26px] shrink-0 items-center justify-center rounded-lg border border-sidebar-border bg-sidebar-border text-[0.625rem] font-semibold text-sidebar-fg"
    >
      {initial}
    </span>
  );
}

interface Account {
  /** Display name — the footer's primary label (an email is a fallback, not a label). */
  name: string | null;
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
  homeHref,
  onNavigate,
}: {
  sections: NavSection[];
  collapsed: boolean;
  account: Account;
  homeHref: string;
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

  const label = account.name?.trim() || account.email;
  const initial = (label.trim().slice(0, 2) || "?").toUpperCase();

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Brand homeHref={homeHref} collapsed={collapsed} onNavigate={onNavigate} />
      <nav
        aria-label="Primary"
        className={`flex min-h-0 flex-1 flex-col overflow-y-auto py-4 ${collapsed ? "px-2" : "px-0"}`}
      >
        {sections.map((section, i) => (
          <div key={section.label} role="group" aria-label={section.label} className="flex flex-col">
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

      {/* Fixed account footer — opens the SHARED account menu (same one the header uses).
          Flyout above when expanded, to the right when collapsed.

          It KEEPS its top rule, unlike the brand above: this one separates navigation from
          the account, which is a real boundary — above it is where you can go, below it is
          who you are. */}
      <div ref={footerRef} className={`relative shrink-0 border-t border-sidebar-border ${collapsed ? "p-2" : "py-2"}`}>
        <button
          type="button"
          onClick={() => setAcctOpen((o) => !o)}
          aria-haspopup="menu"
          aria-expanded={acctOpen}
          aria-label={collapsed ? `Account: ${label}` : undefined}
          title={account.email}
          // The SAME row as the nav items above (RAIL_ROW): same inset, same 10px radius,
          // same hover. It used to be a full-width `rounded-lg` block with its own
          // padding, so the one row that is always on screen was the one row shaped
          // differently from every other.
          className={`${RAIL_ROW} w-[calc(100%-1.25rem)] text-sidebar-muted hover:bg-sidebar-hover hover:text-sidebar-fg ${
            collapsed
              ? "flex items-center justify-center p-1"
              : "grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2.5 px-2.5 py-2 text-left"
          }`}
        >
          <Avatar initial={initial} />
          {collapsed ? null : (
            <>
              {/* Track 2: starts AFTER the avatar's track + the gap, so the label can never
                  render on top of the avatar. minmax(0,1fr) lets it shrink below its content
                  width, which is what makes truncate work. */}
              <span className="flex min-w-0 flex-col overflow-hidden">
                <span className="truncate text-[0.8125rem] font-medium leading-tight text-sidebar-fg">{label}</span>
                <span className="u-mono truncate text-[0.625rem] uppercase leading-tight tracking-wide text-sidebar-section">
                  {account.role}
                </span>
              </span>
              {/* The disclosure caret (design frame 20f) — the footer opens the account menu. */}
              <span aria-hidden className="shrink-0 text-[0.5625rem] text-sidebar-section">▾</span>
            </>
          )}
        </button>

        {acctOpen ? (
          <div
            role="menu"
            className={`absolute z-50 overflow-hidden rounded-lg border border-line bg-popover ${
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
 *   SCHEDULING    → Agenda, Staff, Scheduling settings (iff the module is enabled).
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
  name,
  memberClientId,
  defaultClientId,
  enabledModules,
  email,
  role,
  clientLabel,
}: {
  /** Display name for the account footer; falls back to the email when absent. */
  name: string | null;
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
  const { scopeFor } = useScope();

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
  // Brand target: the Hub for owner/admin; a member has no Hub access, so their
  // brand links to their own client (mirrors the header's memberLandingHref).
  const homeHref = memberClientId ? `/clients/${memberClientId}/workflows` : "/";
  const account: Account = {
    name,
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
    // Scope-aware hrefs (Phase W-1): both items point at the CURRENT workflow scope
    // read from context — Executions/Analytics of the selected workflow, or the list/
    // aggregate when scope is 'all'. Both sections live under /workflows/…, so the
    // active split keys off whether the path is an analytics route.
    const scope = scopeFor(clientId);
    const onWorkflows = pathname.startsWith(c("/workflows"));
    // WORKSPACE — the top-level places, exactly as the final design lists them:
    // Hub (the tenant lobby), Workflows (the client's workflow CONTEXT), Inbox.
    // Executions / Analytics / Settings are NOT rail items: they are surfaces INSIDE
    // a workflow, reached from the Workflows list and the header's scope switcher.
    // Putting them in the rail made workflow-only surfaces look like peers of Inbox
    // and CRM while sitting on a completely unrelated route.
    const workspace: NavItem[] = [
      { key: "hub", label: "Hub", href: "/", icon: Icon.hub, active: pathname === "/" },
      {
        key: "workflows",
        label: "Workflows",
        href: scopeHref(clientId, "executions", scope),
        icon: Icon.workflows,
        active: onWorkflows,
      },
    ];
    // Inbox only when the `inbox` module is enabled — hides the link, the badge, and
    // (no countEndpoint rendered) stops the pending-count polling.
    if (moduleKeys.includes("inbox")) {
      workspace.push({
        key: "inbox",
        label: "Inbox",
        href: c("/inbox"),
        icon: Icon.inbox,
        active: pathname.startsWith(c("/inbox")),
        countEndpoint: `/api/inbox/${clientId}/pending-count`,
      });
    }
    // TODO(nav): the target design's CRM group also lists "Tasks" and "Sites", and
    // SCHEDULING lists "Scheduling analytics". None of those routes exist in this
    // build, so they are deliberately NOT rendered — a rail item that 404s is worse
    // than an absent one. Confirm before I add them (each needs a real page first).
    // TODO(nav): the target puts "Users & access" inside CRM and drops "Modules"
    // entirely; here both live under ADMINISTRATION because they are owner/admin
    // client-administration surfaces, not CRM ones. Confirm before moving.
    // TODO(nav): the target has no "Custom fields" row; this build does, because
    // /contacts/fields is a real page. Confirm before hiding it.
    sections = [{ label: "Workspace", items: workspace }];
    if (moduleKeys.includes("crm")) {
      const onFields = pathname.startsWith(c("/contacts/fields"));
      const crm: NavItem[] = [
        {
          key: "contacts",
          label: "Contacts",
          href: c("/contacts"),
          icon: Icon.contacts,
          // Exclude the fields sub-route so exactly ONE row is ever active.
          active: pathname.startsWith(c("/contacts")) && !onFields,
        },
      ];
      // The only other REAL CRM route. The reference also shows Tasks and Sites —
      // neither exists in the app, so they are deliberately not invented here.
      if (!isMember) {
        crm.push({
          key: "contact-fields",
          label: "Custom fields",
          href: c("/contacts/fields"),
          icon: Icon.modules,
          active: onFields,
        });
      }
      sections.push({ label: "CRM", items: crm });
    }
    if (moduleKeys.includes("scheduling")) {
      const scheduling: NavItem[] = [
        { key: "agenda", label: "Agenda", href: c("/scheduling/agenda"), icon: Icon.agenda, active: pathname.startsWith(c("/scheduling/agenda")) },
      ];
      // STAFF (the roster) and Scheduling settings are both owner/admin only, and
      // never for the DEFAULT client (it can't have scheduling). The module gate
      // already ensured `scheduling` is enabled for this client.
      if (!isMember && clientId !== defaultClientId) {
        scheduling.push({
          key: "staff",
          label: "Staff",
          href: c("/scheduling/staff"),
          icon: Icon.team,
          active: pathname.startsWith(c("/scheduling/staff")),
        });
        scheduling.push({
          key: "scheduling-settings",
          label: "Scheduling settings",
          href: c("/scheduling/admin"),
          icon: Icon.schedulingAdmin,
          active: pathname.startsWith(c("/scheduling/admin")),
        });
      }
      sections.push({ label: "Scheduling", items: scheduling });
    }
    if (!isMember) {
      const admin: NavItem[] = [
        // The LABEL is "Users & access"; the key, the route and the components stay
        // `team` so no link, import or test id breaks. This row is logins and roles —
        // the barber roster is SCHEDULING → Staff.
        { key: "team", label: "Users & access", href: c("/team"), icon: Icon.team, active: pathname.startsWith(c("/team")) },
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
      {
        key: "analytics",
        label: "Analytics",
        href: scopeHref(memberClientId, "analytics", scopeFor(memberClientId)),
        icon: Icon.overview,
        active: false,
      },
    ];
    if (memberModules.includes("crm")) {
      items.push({ key: "contacts", label: "Contacts", href: m("/contacts"), icon: Icon.contacts, active: pathname.startsWith(m("/contacts")) });
    }
    if (memberModules.includes("scheduling")) {
      items.push({ key: "agenda", label: "Agenda", href: m("/scheduling/agenda"), icon: Icon.agenda, active: pathname.startsWith(m("/scheduling")) });
    }
    sections = [{ label: "Client", items }];
  } else {
    // Owner/admin tenant level (the Hub) — ONLY global surfaces. Scheduling is NOT
    // here: sites/services/staff/hours belong to a specific client and are
    // administered inside that client's workspace (SCHEDULING → Scheduling settings).
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
    ];
  }

  return (
    <>
      {/* DESKTOP rail — full (w-60) or collapsed icon-only (w-16). */}
      <aside
        data-collapsed={collapsed}
        style={collapsed ? undefined : { width: "var(--sidebar-width)" }}
        className={`hidden shrink-0 flex-col border-r border-sidebar-border bg-sidebar-bg transition-[width] duration-200 md:flex ${
          collapsed ? "w-16" : ""
        }`}
      >
        <RailBody sections={sections} collapsed={collapsed} account={account} homeHref={homeHref} />
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
            className="fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-sidebar-border bg-sidebar-bg"
          >
            <RailBody
              sections={sections}
              collapsed={false}
              account={account}
              homeHref={homeHref}
              onNavigate={() => setMobileOpen(false)}
            />
          </aside>
        </div>
      ) : null}
    </>
  );
}

"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { createPortal } from "react-dom";
import { useSidebar } from "@/components/SidebarContext";
import { useScope } from "@/components/ScopeProvider";
import { parseClientSurface } from "@/lib/clientSurface";
import { parseScopeSurface, scopeHref } from "@/lib/scopeSurface";
import { WorkflowSwitcherPanel } from "@/components/WorkflowSwitcherPanel";
import { AccountMenu } from "@/components/AccountMenu";

export interface HeaderClient {
  id: string;
  name: string;
  isDefault: boolean;
  logoUrl: string | null;
}
export interface HeaderWorkflow {
  /** n8n workflow id (the URL segment). */
  id: string;
  name: string | null;
  clientId: string;
  /** n8n active flag — drives the Active/Inactive grouping + status dot in the switcher. */
  active: boolean | null;
}

const AUTH_PREFIXES = ["/login", "/signup", "/logout", "/forgot-password", "/reset-password"];

/** Small client logo (uploaded image or monogram fallback) for breadcrumb + picker. */
function MiniLogo({ name, logoUrl, size = "size-5" }: { name: string; logoUrl: string | null; size?: string }) {
  if (logoUrl) {
    // eslint-disable-next-line @next/next/no-img-element -- tiny external logo from R2
    return <img src={logoUrl} alt="" aria-hidden className={`${size} shrink-0 rounded border border-line object-cover`} />;
  }
  return (
    <span
      aria-hidden
      className={`${size} flex shrink-0 items-center justify-center rounded border border-line bg-subtle text-[10px] font-semibold text-foreground`}
    >
      {name.trim()[0]?.toUpperCase() ?? "?"}
    </span>
  );
}

/** Home/hub glyph in the same square slot as MiniLogo — for the default client,
 * which is presented as "Hub" (the lobby) rather than its stored name. */
function HubBadge({ size = "size-5" }: { size?: string }) {
  return (
    <span
      aria-hidden
      className={`${size} flex shrink-0 items-center justify-center rounded border border-line bg-subtle text-faint`}
    >
      <svg viewBox="0 0 16 16" className="size-3" fill="none">
        <path
          d="M2.5 7.5 8 3l5.5 4.5M4 6.5V13h8V6.5"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

/** Stacked up/down chevron — the "this is a dropdown" affordance on the breadcrumb
 * picker segments (small + muted, both themes). */
function ChevronUpDown() {
  return (
    <svg viewBox="0 0 16 16" className="size-3.5 shrink-0 text-faint" aria-hidden fill="none">
      <path d="M5.5 7L8 4.5 10.5 7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5.5 9L8 11.5 10.5 9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Panel-left icon for the sidebar show/hide toggle. */
function PanelIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-4" aria-hidden fill="none">
      <rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <line x1="6.25" y1="3.4" x2="6.25" y2="12.6" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

/** Hamburger icon for the mobile drawer trigger. */
function MenuIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-4" aria-hidden fill="none">
      <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Dropdown panel portaled to <body> so it escapes any overflow/stacking context
 * and sits above the page (z-[60]). Positioned in page coordinates anchored under
 * the trigger (the header is non-sticky, so it scrolls naturally with content —
 * same approach as the clients ⋯ menus).
 */
function PortalPanel({
  anchorRef,
  align = "left",
  width = 256,
  children,
}: {
  anchorRef: React.RefObject<HTMLElement | null>;
  align?: "left" | "right";
  width?: number;
  children: React.ReactNode;
}) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const compute = () => {
      const r = anchor.getBoundingClientRect();
      let left = align === "right" ? r.right - width : r.left;
      left = Math.min(Math.max(8, left), window.innerWidth - width - 8);
      // position:fixed → VIEWPORT coordinates (no scrollY/X). Under the fixed shell
      // the body doesn't scroll, so fixed avoids clipping by body overflow-hidden,
      // and recomputing on scroll (capture — catches the content region / inner
      // columns) keeps the panel glued to a trigger inside a scrolling region.
      setPos({ top: r.bottom + 6, left });
    };
    compute();
    window.addEventListener("resize", compute);
    window.addEventListener("scroll", compute, true);
    return () => {
      window.removeEventListener("resize", compute);
      window.removeEventListener("scroll", compute, true);
    };
  }, [anchorRef, align, width]);

  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      data-menu-portal
      style={{
        position: "fixed",
        top: pos?.top ?? 0,
        left: pos?.left ?? 0,
        width,
        visibility: pos ? "visible" : "hidden",
      }}
      className="z-[60] overflow-hidden rounded-xl border border-black/10 bg-white shadow-xl dark:border-line-strong dark:bg-neutral-900"
    >
      {children}
    </div>,
    document.body,
  );
}

export function HeaderBar({
  email,
  name,
  clients,
  workflows,
  canSwitchClients,
  homeHref,
  role,
  clientLabel,
}: {
  email: string;
  name: string | null;
  clients: HeaderClient[];
  workflows: HeaderWorkflow[];
  /** false for a member (one client, no switcher) — also hides tenant-wide settings. */
  canSwitchClients: boolean;
  /** Logo / home target: "/" (Hub) for owner/admin, the member's client otherwise. */
  homeHref: string;
  /** The signed-in user's role (shown in the profile menu). */
  role: "owner" | "admin" | "member";
  /** A member's client name (so they always see where they're scoped); else null. */
  clientLabel: string | null;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { toggle: toggleSidebar, setMobileOpen } = useSidebar();
  const { scopeFor, setScope } = useScope();
  const [openMenu, setOpenMenu] = useState<null | "client" | "workflow" | "profile">(null);

  const clientBtn = useRef<HTMLButtonElement>(null);
  const workflowBtn = useRef<HTMLButtonElement>(null);
  const profileBtn = useRef<HTMLButtonElement>(null);

  // Close on outside-click (sparing the trigger + the portaled panel) or Escape.
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest("[data-menu-root]") && !t.closest("[data-menu-portal]")) setOpenMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenMenu(null);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, []);
  // A navigation closes any open menu. Adjust state DURING render when the route
  // changes (React's documented alternative to a setState-in-effect): compare against
  // the tracked path in state so it runs once per change and never loops.
  const [lastPath, setLastPath] = useState(pathname);
  if (lastPath !== pathname) {
    setLastPath(pathname);
    if (openMenu !== null) setOpenMenu(null);
  }

  // Auth screens stay clean (also covers a client-side nav to /logout).
  if (AUTH_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return null;
  }

  // The scope-bearing surface (Executions / Analytics / Inbox) drives the workflow
  // switcher; parseClientSurface labels the module pages (Team / Modules / Contacts / …).
  const surface = parseScopeSurface(pathname);
  const clientSurface = parseClientSurface(pathname);
  const pathClientId = surface?.clientId ?? clientSurface?.clientId ?? null;
  const currentClient = pathClientId ? clients.find((c) => c.id === pathClientId) ?? null : null;
  // The member breadcrumb (no client switcher) shows their ONE client — fall back to
  // the only client the scope-narrowed header was given.
  const soleClient = currentClient ?? clients[0] ?? null;

  // The remembered workflow SCOPE for this client (from context) — the switcher's
  // label + ✓, kept URL-accurate by ScopeSync so the header never shows a scope the
  // content doesn't. "All workflows" when scope is 'all'.
  const currentScope: "all" | string = pathClientId ? scopeFor(pathClientId) : "all";
  const scopeWorkflow =
    currentScope !== "all"
      ? workflows.find((w) => w.id === currentScope && w.clientId === pathClientId) ?? null
      : null;
  const scopeLabel = currentScope === "all" ? "All workflows" : scopeWorkflow?.name ?? currentScope;

  const byName = (a: HeaderWorkflow, b: HeaderWorkflow) =>
    (a.name ?? a.id).localeCompare(b.name ?? b.id);

  // Selecting a client goes to its Executions entry (the workflows list route), which
  // server-resolves THAT client's own remembered scope — redirecting to its workflow
  // when it has one, else rendering the list. So switching clients respects per-client
  // memory (and defaults to 'all') without the header guessing a target.
  const clientTarget = (clientId: string): string => `/clients/${clientId}/workflows`;

  const go = (href: string) => {
    setOpenMenu(null);
    router.push(href);
  };

  // Switcher select: remember the scope for this client (cookie + context), then
  // navigate keeping the current section (Executions / Analytics / Inbox).
  const onSelectScope = (scope: "all" | string) => {
    if (!surface) return;
    setOpenMenu(null);
    setScope(surface.clientId, scope);
    if (surface.section === "inbox") {
      // Inbox scope rides in ?workflow=; preserve the open conversation (?c=) — the
      // workspace closes it if it falls outside the new scope, and keeps it on 'all'.
      const p = new URLSearchParams(searchParams.toString());
      if (scope === "all") p.delete("workflow");
      else p.set("workflow", scope);
      const qs = p.toString();
      router.push(`/clients/${encodeURIComponent(surface.clientId)}/inbox${qs ? `?${qs}` : ""}`);
    } else {
      router.push(scopeHref(surface.clientId, surface.section, scope));
    }
  };

  const clientWorkflows = currentClient
    ? workflows.filter((w) => w.clientId === currentClient.id).sort(byName)
    : [];

  const initial = (name?.trim()[0] ?? email.trim()[0] ?? "?").toUpperCase();

  return (
    <header className="flex shrink-0 items-center justify-between gap-3 border-b border-black/10 px-4 py-2.5 dark:border-line">
      {/* LEFT — sidebar controls + text logo → home */}
      <div className="flex shrink-0 items-center gap-2">
        {/* Mobile: opens the sidebar as a drawer. */}
        <button
          type="button"
          onClick={() => setMobileOpen(true)}
          aria-label="Open menu"
          title="Open menu"
          className="inline-flex rounded-lg p-1.5 text-muted transition-colors hover:bg-black/[0.05] hover:text-foreground md:hidden dark:hover:bg-subtle"
        >
          <MenuIcon />
        </button>
        {/* Desktop: collapse / expand the sidebar rail. */}
        <button
          type="button"
          onClick={toggleSidebar}
          aria-label="Toggle sidebar"
          title="Toggle sidebar"
          className="hidden rounded-lg p-1.5 text-muted transition-colors hover:bg-black/[0.05] hover:text-foreground md:inline-flex dark:hover:bg-subtle"
        >
          <PanelIcon />
        </button>
        <Link
          href={homeHref}
          className="font-semibold tracking-tight text-foreground transition-opacity hover:opacity-70"
        >
          Observability
        </Link>
      </div>

      {/* CENTER — route-aware breadcrumb */}
      <nav className="flex min-w-0 flex-1 items-center justify-center gap-1 text-sm">
        {/* Client segment — a picker for owner/admin; static text for a member */}
        {canSwitchClients ? (
        <div className="contents">
          <button
            ref={clientBtn}
            type="button"
            data-menu-root
            onClick={() => setOpenMenu(openMenu === "client" ? null : "client")}
            aria-expanded={openMenu === "client"}
            className="inline-flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-foreground transition-colors hover:bg-black/[0.05] dark:hover:bg-subtle"
          >
            {currentClient ? (
              currentClient.isDefault ? (
                <>
                  <HubBadge />
                  <span className="truncate font-medium">Hub</span>
                </>
              ) : (
                <>
                  <MiniLogo name={currentClient.name} logoUrl={currentClient.logoUrl} />
                  <span className="truncate font-medium">{currentClient.name}</span>
                </>
              )
            ) : (
              <span className="text-muted">Select a client</span>
            )}
            <ChevronUpDown />
          </button>
          {openMenu === "client" ? (
            <PortalPanel anchorRef={clientBtn} align="left" width={264}>
              <p className="px-3 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-neutral-500">
                Clients
              </p>
              <div className="max-h-72 overflow-y-auto pb-1">
                {clients.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => go(c.isDefault ? "/" : clientTarget(c.id))}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors hover:bg-black/[0.04] dark:hover:bg-subtle"
                  >
                    {c.isDefault ? (
                      <HubBadge size="size-6" />
                    ) : (
                      <MiniLogo name={c.name} logoUrl={c.logoUrl} size="size-6" />
                    )}
                    <span className="truncate">{c.isDefault ? "Hub" : c.name}</span>
                    {c.id === currentClient?.id ? (
                      <span aria-hidden className="ml-auto text-xs text-accent">✓</span>
                    ) : null}
                  </button>
                ))}
              </div>
            </PortalPanel>
          ) : null}
        </div>
        ) : soleClient ? (
          // Member: their single client, shown as static text (no switcher).
          <span className="inline-flex min-w-0 items-center gap-1.5 px-2 py-1 text-foreground">
            <MiniLogo name={soleClient.name} logoUrl={soleClient.logoUrl} />
            <span className="truncate font-medium">{soleClient.name}</span>
          </span>
        ) : null}

        {/* Client-surface segment ("Client / Team", "Client / Modules", "Client / Inbox").
            Shown for the module pages, and kept alongside the switcher on Inbox; it's
            suppressed on the workflow scope surfaces (Executions/Analytics + the list)
            since the switcher itself carries that identity. */}
        {clientSurface && (!surface || surface.section === "inbox") ? (
          <>
            <span aria-hidden className="text-faint">/</span>
            <span className="inline-flex items-center px-2 py-1 font-medium text-foreground">
              {clientSurface.label}
            </span>
          </>
        ) : null}

        {/* Workflow SCOPE switcher — on every scope surface (Executions / Analytics /
            Inbox). Shows the remembered scope; selecting one remembers it + navigates
            keeping the section. Hidden on the module pages (no scope surface). */}
        {surface ? (
          <>
            <span aria-hidden className="text-faint">/</span>
            <div className="contents">
              <button
                ref={workflowBtn}
                type="button"
                data-menu-root
                onClick={() => setOpenMenu(openMenu === "workflow" ? null : "workflow")}
                aria-haspopup="listbox"
                aria-expanded={openMenu === "workflow"}
                className="inline-flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-foreground transition-colors hover:bg-black/[0.05] dark:hover:bg-subtle"
              >
                <span className="truncate font-medium">{scopeLabel}</span>
                <ChevronUpDown />
              </button>
              {openMenu === "workflow" ? (
                <PortalPanel anchorRef={workflowBtn} align="left" width={280}>
                  <WorkflowSwitcherPanel
                    clientName={currentClient?.name ?? null}
                    workflows={clientWorkflows.map((w) => ({ id: w.id, name: w.name, active: w.active }))}
                    currentScope={currentScope}
                    onSelect={onSelectScope}
                  />
                </PortalPanel>
              ) : null}
            </div>
          </>
        ) : null}
      </nav>

      {/* RIGHT — profile menu */}
      <div className="contents">
        <button
          ref={profileBtn}
          type="button"
          data-menu-root
          onClick={() => setOpenMenu(openMenu === "profile" ? null : "profile")}
          aria-label="Account"
          aria-expanded={openMenu === "profile"}
          className="flex size-8 shrink-0 items-center justify-center rounded-full border border-line-strong bg-subtle text-sm font-semibold text-foreground transition-colors hover:bg-subtle"
        >
          {initial}
        </button>
        {openMenu === "profile" ? (
          <PortalPanel anchorRef={profileBtn} align="right" width={232}>
            <AccountMenu
              email={email}
              role={role}
              clientLabel={clientLabel}
              canSwitchClients={canSwitchClients}
              onNavigate={() => setOpenMenu(null)}
            />
          </PortalPanel>
        ) : null}
      </div>
    </header>
  );
}

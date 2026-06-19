"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { createPortal } from "react-dom";
import { useTheme } from "next-themes";

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
}

const AUTH_PREFIXES = ["/login", "/signup", "/logout"];

/** Parse the client + workflow ids out of a /clients/<c>/workflows/<w>/… path. */
function parseWorkflowRoute(pathname: string): { clientId: string; workflowId: string } | null {
  const m = pathname.match(/^\/clients\/([^/]+)\/workflows\/([^/]+)(?:\/|$)/);
  if (!m) return null;
  return { clientId: decodeURIComponent(m[1]), workflowId: decodeURIComponent(m[2]) };
}

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

function Caret() {
  return (
    <svg viewBox="0 0 16 16" className="size-3 shrink-0 text-neutral-500" aria-hidden>
      <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
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
      setPos({ top: r.bottom + 6 + window.scrollY, left: left + window.scrollX });
    };
    compute();
    window.addEventListener("resize", compute);
    return () => window.removeEventListener("resize", compute);
  }, [anchorRef, align, width]);

  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      data-menu-portal
      style={{
        position: "absolute",
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
  const { theme, setTheme } = useTheme();
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
  // A navigation closes any open menu.
  useEffect(() => setOpenMenu(null), [pathname]);

  // Auth screens stay clean (also covers a client-side nav to /logout).
  if (AUTH_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return null;
  }

  const route = parseWorkflowRoute(pathname);
  // The client-level Team route (/clients/[c]/team) — a non-workflow client surface.
  const teamMatch = pathname.match(/^\/clients\/([^/]+)\/team/);
  const teamClientId = teamMatch ? decodeURIComponent(teamMatch[1]) : null;
  const currentClient = route
    ? clients.find((c) => c.id === route.clientId) ?? null
    : teamClientId
      ? clients.find((c) => c.id === teamClientId) ?? null
      : null;
  const currentWorkflow = route
    ? workflows.find((w) => w.id === route.workflowId && w.clientId === route.clientId) ?? null
    : null;
  // The member breadcrumb (no switcher) shows their ONE client even off a workflow
  // route (e.g. /executions/[id], where `route` is null) — fall back to the only
  // client the scope-narrowed header was given.
  const soleClient = currentClient ?? clients[0] ?? null;
  const atWorkflow = Boolean(route);
  const isAnalytics = pathname.includes("/analytics");
  const isAll = route?.workflowId === "all";
  const tab = isAnalytics ? "analytics" : pathname.includes("/conversations") ? "conversations" : "executions";
  // The workflow to "remember" when jumping to the client's All-workflows view:
  // the one being viewed (or, if already on "all", whatever ?from carries).
  const currentFrom = isAll ? searchParams.get("from") : route?.workflowId ?? null;
  const allAnalyticsHref = route
    ? `/clients/${route.clientId}/workflows/all/analytics${
        currentFrom ? `?from=${encodeURIComponent(currentFrom)}` : ""
      }`
    : "/";

  const byName = (a: HeaderWorkflow, b: HeaderWorkflow) =>
    (a.name ?? a.id).localeCompare(b.name ?? b.id);

  /** Where selecting a client sends you: its first workflow, else the folder view. */
  const clientTarget = (clientId: string): string => {
    const first = workflows.filter((w) => w.clientId === clientId).sort(byName)[0];
    return first
      ? `/clients/${clientId}/workflows/${encodeURIComponent(first.id)}/executions`
      : "/clients";
  };
  const workflowTarget = (clientId: string, workflowId: string): string =>
    `/clients/${clientId}/workflows/${encodeURIComponent(workflowId)}/${tab}`;

  const go = (href: string) => {
    setOpenMenu(null);
    router.push(href);
  };

  const clientWorkflows = currentClient
    ? workflows.filter((w) => w.clientId === currentClient.id).sort(byName)
    : [];

  const initial = (name?.trim()[0] ?? email.trim()[0] ?? "?").toUpperCase();

  return (
    <header className="flex items-center justify-between gap-3 border-b border-black/10 px-4 py-2.5 dark:border-line">
      {/* LEFT — text logo → home (the Hub for owner/admin; the member's client) */}
      <Link
        href={homeHref}
        className="shrink-0 font-semibold tracking-tight text-foreground transition-opacity hover:opacity-70"
      >
        Observability
      </Link>

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
            <Caret />
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

        {/* Team segment (the client-level Team route → "Client / Team") */}
        {teamClientId ? (
          <>
            <span aria-hidden className="text-faint">/</span>
            <span className="inline-flex items-center px-2 py-1 font-medium text-foreground">Team</span>
          </>
        ) : null}

        {/* Workflow segment (only at workflow level) */}
        {atWorkflow ? (
          <>
            <span aria-hidden className="text-faint">/</span>
            <div className="contents">
              <button
                ref={workflowBtn}
                type="button"
                data-menu-root
                onClick={() => setOpenMenu(openMenu === "workflow" ? null : "workflow")}
                aria-expanded={openMenu === "workflow"}
                className="inline-flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-foreground transition-colors hover:bg-black/[0.05] dark:hover:bg-subtle"
              >
                <span className="truncate font-medium">
                  {isAll ? "All workflows" : currentWorkflow?.name ?? route?.workflowId ?? "Workflow"}
                </span>
                <Caret />
              </button>
              {openMenu === "workflow" ? (
                <PortalPanel anchorRef={workflowBtn} align="left" width={264}>
                  <p className="px-3 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-neutral-500">
                    {currentClient ? `Workflows in ${currentClient.name}` : "Workflows"}
                  </p>
                  <div className="max-h-72 overflow-y-auto pb-1">
                    {/* On analytics routes, "All workflows" = the client-aggregate view. */}
                    {isAnalytics ? (
                      <button
                        type="button"
                        onClick={() => go(allAnalyticsHref)}
                        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors hover:bg-black/[0.04] dark:hover:bg-subtle"
                      >
                        <span className="truncate font-medium">All workflows</span>
                        {isAll ? <span aria-hidden className="ml-auto text-xs text-accent">✓</span> : null}
                      </button>
                    ) : null}
                    {clientWorkflows.length === 0 ? (
                      <p className="px-3 py-2 text-xs text-neutral-500">No workflows in this client.</p>
                    ) : (
                      clientWorkflows.map((w) => (
                        <button
                          key={w.id}
                          type="button"
                          onClick={() => go(workflowTarget(w.clientId, w.id))}
                          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors hover:bg-black/[0.04] dark:hover:bg-subtle"
                        >
                          <span className="truncate">{w.name ?? w.id}</span>
                          {!isAll && w.id === currentWorkflow?.id ? (
                            <span aria-hidden className="ml-auto text-xs text-accent">✓</span>
                          ) : null}
                        </button>
                      ))
                    )}
                  </div>
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
            <div className="border-b border-line px-3 py-2">
              <p className="text-[10px] font-medium uppercase tracking-wider text-faint">Signed in as</p>
              <p className="truncate text-sm text-foreground">{email}</p>
              <p className="mt-0.5 truncate text-xs capitalize text-muted">
                {role}
                {clientLabel ? <span className="text-faint"> · {clientLabel}</span> : null}
              </p>
            </div>
            <div className="border-b border-line px-3 py-2.5">
              <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-faint">Theme</p>
              <div className="flex gap-0.5 rounded-lg border border-line p-0.5">
                {(["light", "dark", "system"] as const).map((opt) => (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => setTheme(opt)}
                    aria-pressed={theme === opt}
                    className={`flex-1 rounded-md px-2 py-1 text-xs capitalize transition-colors ${
                      theme === opt
                        ? "bg-subtle font-medium text-foreground"
                        : "text-muted hover:text-foreground"
                    }`}
                  >
                    {opt}
                  </button>
                ))}
              </div>
            </div>
            <div className="py-1">
              {/* Owner/admin-only management — hidden for a member (they'd be bounced). */}
              {canSwitchClients ? (
                <>
                  <Link
                    href="/settings/team"
                    onClick={() => setOpenMenu(null)}
                    className="flex w-full items-center px-3 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-black/[0.04] dark:hover:bg-subtle"
                  >
                    Team
                  </Link>
                  <Link
                    href="/settings/connections"
                    onClick={() => setOpenMenu(null)}
                    className="flex w-full items-center px-3 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-black/[0.04] dark:hover:bg-subtle"
                  >
                    n8n connections
                  </Link>
                </>
              ) : null}
              <Link
                href="/logout"
                onClick={() => setOpenMenu(null)}
                className="flex w-full items-center px-3 py-1.5 text-left text-sm text-danger transition-colors hover:bg-red-500/10"
              >
                Log out
              </Link>
            </div>
          </PortalPanel>
        ) : null}
      </div>
    </header>
  );
}

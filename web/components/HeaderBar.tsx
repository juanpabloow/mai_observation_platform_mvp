"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createPortal } from "react-dom";

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
    return <img src={logoUrl} alt="" aria-hidden className={`${size} shrink-0 rounded border border-white/10 object-cover`} />;
  }
  return (
    <span
      aria-hidden
      className={`${size} flex shrink-0 items-center justify-center rounded border border-white/10 bg-white/[0.06] text-[10px] font-semibold text-neutral-300`}
    >
      {name.trim()[0]?.toUpperCase() ?? "?"}
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
      className="z-[60] overflow-hidden rounded-xl border border-black/10 bg-white shadow-xl dark:border-white/15 dark:bg-neutral-900"
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
}: {
  email: string;
  name: string | null;
  clients: HeaderClient[];
  workflows: HeaderWorkflow[];
}) {
  const pathname = usePathname();
  const router = useRouter();
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
  const currentClient = route ? clients.find((c) => c.id === route.clientId) ?? null : null;
  const currentWorkflow = route
    ? workflows.find((w) => w.id === route.workflowId && w.clientId === route.clientId) ?? null
    : null;
  const atWorkflow = Boolean(route);
  const tab = pathname.includes("/conversations") ? "conversations" : "executions";

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
    <header className="flex items-center justify-between gap-3 border-b border-black/10 px-4 py-2.5 dark:border-white/10">
      {/* LEFT — text logo → tenant home */}
      <Link
        href="/clients"
        className="shrink-0 font-semibold tracking-tight text-neutral-200 transition-colors hover:text-white"
      >
        Observability
      </Link>

      {/* CENTER — route-aware breadcrumb */}
      <nav className="flex min-w-0 flex-1 items-center justify-center gap-1 text-sm">
        {/* Client segment (a picker) */}
        <div className="contents">
          <button
            ref={clientBtn}
            type="button"
            data-menu-root
            onClick={() => setOpenMenu(openMenu === "client" ? null : "client")}
            aria-expanded={openMenu === "client"}
            className="inline-flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-neutral-200 transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.06]"
          >
            {currentClient ? (
              <>
                <MiniLogo name={currentClient.name} logoUrl={currentClient.logoUrl} />
                <span className="truncate font-medium">{currentClient.name}</span>
              </>
            ) : (
              <span className="text-neutral-400">Select a client</span>
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
                    onClick={() => go(clientTarget(c.id))}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
                  >
                    <MiniLogo name={c.name} logoUrl={c.logoUrl} size="size-6" />
                    <span className="truncate">{c.name}</span>
                    {c.id === currentClient?.id ? (
                      <span aria-hidden className="ml-auto text-xs text-emerald-400">✓</span>
                    ) : null}
                  </button>
                ))}
              </div>
            </PortalPanel>
          ) : null}
        </div>

        {/* Workflow segment (only at workflow level) */}
        {atWorkflow ? (
          <>
            <span aria-hidden className="text-neutral-600">/</span>
            <div className="contents">
              <button
                ref={workflowBtn}
                type="button"
                data-menu-root
                onClick={() => setOpenMenu(openMenu === "workflow" ? null : "workflow")}
                aria-expanded={openMenu === "workflow"}
                className="inline-flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-neutral-200 transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.06]"
              >
                <span className="truncate font-medium">
                  {currentWorkflow?.name ?? route?.workflowId ?? "Workflow"}
                </span>
                <Caret />
              </button>
              {openMenu === "workflow" ? (
                <PortalPanel anchorRef={workflowBtn} align="left" width={264}>
                  <p className="px-3 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-neutral-500">
                    {currentClient ? `Workflows in ${currentClient.name}` : "Workflows"}
                  </p>
                  <div className="max-h-72 overflow-y-auto pb-1">
                    {clientWorkflows.length === 0 ? (
                      <p className="px-3 py-2 text-xs text-neutral-500">No workflows in this client.</p>
                    ) : (
                      clientWorkflows.map((w) => (
                        <button
                          key={w.id}
                          type="button"
                          onClick={() => go(workflowTarget(w.clientId, w.id))}
                          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
                        >
                          <span className="truncate">{w.name ?? w.id}</span>
                          {w.id === currentWorkflow?.id ? (
                            <span aria-hidden className="ml-auto text-xs text-emerald-400">✓</span>
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
          className="flex size-8 shrink-0 items-center justify-center rounded-full border border-white/15 bg-white/[0.06] text-sm font-semibold text-neutral-200 transition-colors hover:bg-white/[0.12]"
        >
          {initial}
        </button>
        {openMenu === "profile" ? (
          <PortalPanel anchorRef={profileBtn} align="right" width={232}>
            <div className="border-b border-black/5 px-3 py-2 dark:border-white/10">
              <p className="text-[10px] font-medium uppercase tracking-wider text-neutral-500">Signed in as</p>
              <p className="truncate text-sm text-neutral-200">{email}</p>
            </div>
            <div className="py-1">
              <Link
                href="/settings/connections"
                onClick={() => setOpenMenu(null)}
                className="flex w-full items-center px-3 py-1.5 text-left text-sm text-neutral-200 transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
              >
                n8n connections
              </Link>
              <Link
                href="/logout"
                onClick={() => setOpenMenu(null)}
                className="flex w-full items-center px-3 py-1.5 text-left text-sm text-red-400 transition-colors hover:bg-red-500/10"
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

"use client";

import { createContext, useCallback, useContext, useState } from "react";
import { LEGACY_SIDEBAR_COLLAPSED_KEY, sidebarCollapsedCookie } from "@/lib/sidebarCollapsed";

/**
 * Shared sidebar UI state. Two independent axes:
 *  - `collapsed` (DESKTOP): the rail is a narrow icon-only strip vs the full width.
 *    Persisted in the `sidebar-collapsed` COOKIE (lib/sidebarCollapsed.ts), which the
 *    root layout reads during SSR and passes in as `initialCollapsed` — so the server
 *    HTML and the first client render are the same, with no effect re-syncing it after
 *    mount (that effect is what used to break hydration of the streamed rail).
 *  - `mobileOpen` (MOBILE): the rail is off-canvas and slides in as a drawer over a
 *    backdrop. NOT persisted (always starts closed); the header's hamburger opens it,
 *    and a nav click / backdrop / Escape closes it.
 * The header's controls and the sidebar live in separate subtrees, so the state
 * lives in a client context wrapping the whole shell.
 */

interface SidebarState {
  collapsed: boolean;
  toggle: () => void;
  /** Set (and persist) the collapsed state — used once to adopt the legacy value. */
  setCollapsed: (collapsed: boolean) => void;
  mobileOpen: boolean;
  setMobileOpen: (open: boolean) => void;
}

const SidebarContext = createContext<SidebarState>({
  collapsed: false,
  toggle: () => {},
  setCollapsed: () => {},
  mobileOpen: false,
  setMobileOpen: () => {},
});

function persist(collapsed: boolean): void {
  document.cookie = sidebarCollapsedCookie(collapsed);
  // Kept in sync so an older tab of the app (still reading localStorage) agrees.
  try {
    window.localStorage.setItem(LEGACY_SIDEBAR_COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {
    /* storage unavailable (private mode) — the cookie is the source of truth */
  }
}

export function SidebarProvider({
  children,
  initialCollapsed = false,
}: {
  children: React.ReactNode;
  /** The server-read cookie value (app/layout.tsx), so SSR and hydration agree. */
  initialCollapsed?: boolean;
}) {
  const [collapsed, setCollapsedState] = useState(initialCollapsed);
  const [mobileOpen, setMobileOpen] = useState(false);

  const setCollapsed = useCallback((next: boolean) => {
    setCollapsedState(next);
    persist(next);
  }, []);
  // No side effect inside a state updater (React may call it twice): read, then set.
  const toggle = useCallback(() => setCollapsed(!collapsed), [collapsed, setCollapsed]);

  return (
    <SidebarContext.Provider value={{ collapsed, toggle, setCollapsed, mobileOpen, setMobileOpen }}>
      {children}
    </SidebarContext.Provider>
  );
}

export function useSidebar(): SidebarState {
  return useContext(SidebarContext);
}

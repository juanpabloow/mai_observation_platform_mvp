"use client";

import { createContext, useContext, useEffect, useState } from "react";

/**
 * Shared sidebar UI state. Two independent axes:
 *  - `collapsed` (DESKTOP): the rail is a narrow icon-only strip vs the full width.
 *    Persisted to localStorage; the header's toggle flips it.
 *  - `mobileOpen` (MOBILE): the rail is off-canvas and slides in as a drawer over a
 *    backdrop. NOT persisted (always starts closed); the header's hamburger opens it,
 *    and a nav click / backdrop / Escape closes it.
 * The header's controls and the sidebar live in separate subtrees, so the state
 * lives in a client context wrapping the whole shell.
 *
 * SSR + first client render use `collapsed = false` (expanded) to avoid a hydration
 * mismatch; the stored preference is applied in an effect right after mount (so a
 * user who collapsed it sees at most a brief expanded frame, never a mismatch).
 */
const STORAGE_KEY = "sidebarCollapsed";

interface SidebarState {
  collapsed: boolean;
  toggle: () => void;
  mobileOpen: boolean;
  setMobileOpen: (open: boolean) => void;
}

const SidebarContext = createContext<SidebarState>({
  collapsed: false,
  toggle: () => {},
  mobileOpen: false,
  setMobileOpen: () => {},
});

export function SidebarProvider({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    // Apply the stored preference AFTER mount (SSR/first render use false) so the
    // localStorage read never causes a hydration mismatch — this is intentional.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (window.localStorage.getItem(STORAGE_KEY) === "1") setCollapsed(true);
  }, []);

  const toggle = () => {
    setCollapsed((c) => {
      const next = !c;
      window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
      return next;
    });
  };

  return (
    <SidebarContext.Provider value={{ collapsed, toggle, mobileOpen, setMobileOpen }}>
      {children}
    </SidebarContext.Provider>
  );
}

export function useSidebar(): SidebarState {
  return useContext(SidebarContext);
}

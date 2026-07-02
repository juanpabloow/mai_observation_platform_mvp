"use client";

import { createContext, useContext, useEffect, useState } from "react";

/**
 * Shared collapse state for the left sidebar. The header's toggle and the sidebar
 * itself live in separate component subtrees, so the state lives in a client
 * context wrapping the whole shell. Persisted to localStorage.
 *
 * SSR + first client render use `false` (expanded) to avoid a hydration mismatch;
 * the stored preference is applied in an effect right after mount (so a user who
 * collapsed it sees at most a brief expanded frame, never a mismatch warning).
 */
const STORAGE_KEY = "sidebarCollapsed";

interface SidebarState {
  collapsed: boolean;
  toggle: () => void;
}

const SidebarContext = createContext<SidebarState>({ collapsed: false, toggle: () => {} });

export function SidebarProvider({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    if (window.localStorage.getItem(STORAGE_KEY) === "1") setCollapsed(true);
  }, []);

  const toggle = () => {
    setCollapsed((c) => {
      const next = !c;
      window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
      return next;
    });
  };

  return <SidebarContext.Provider value={{ collapsed, toggle }}>{children}</SidebarContext.Provider>;
}

export function useSidebar(): SidebarState {
  return useContext(SidebarContext);
}

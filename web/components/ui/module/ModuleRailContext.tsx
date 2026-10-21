"use client";

import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { moduleRailCookie } from "@/lib/moduleRail";

/**
 * Shared open/folded state of the module side menu (lib/moduleRail.ts). The root layout
 * reads the cookie and passes it in, so SSR and hydration render the same rail.
 */
const ModuleRailContext = createContext<{ open: boolean; toggle: () => void }>({ open: true, toggle: () => {} });

export function ModuleRailProvider({ initialOpen = true, children }: { initialOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(initialOpen);
  const toggle = useCallback(() => {
    const next = !open;
    setOpen(next);
    document.cookie = moduleRailCookie(next);
  }, [open]);
  return <ModuleRailContext.Provider value={{ open, toggle }}>{children}</ModuleRailContext.Provider>;
}

export function useModuleRail() {
  return useContext(ModuleRailContext);
}

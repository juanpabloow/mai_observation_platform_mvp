"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import {
  SCOPE_COOKIE,
  SCOPE_MAX_AGE,
  sameScopeMap,
  serializeScopeMap,
  setScopeEntry,
  type ScopeMap,
} from "@/lib/scopeCookieShared";

/**
 * Client-side holder of the per-client "current workflow" scope (Phase W-1). This is
 * the ANTI-STALENESS core (the H-8.1 lesson): the sidebar hrefs and the header
 * switcher read the scope from THIS context, never from a value captured at server
 * layout render, so they stay correct across client-side navigation.
 *
 * It is SEEDED from the server-resolved value (ScopeProviderServer) and then kept
 * fresh entirely on the client:
 *   - the header switcher calls setScope(...) (writes the cookie, updates context)
 *     and then navigates;
 *   - ScopeSync calls setScope(...) whenever the URL itself dictates a scope
 *     (URL wins), so the header can never show a scope different from the content.
 *
 * The cookie is written HERE (client-side) — a server component render cannot set a
 * cookie. `setScope` is a no-op when nothing changes, so the URL-wins sync doesn't
 * churn the cookie or trigger renders.
 */

interface ScopeContextValue {
  /** The remembered scope for a client — a workflow id, or "all". */
  scopeFor: (clientId: string) => "all" | string;
  /** Set (or, with "all", clear) a client's scope: writes the cookie + updates context. */
  setScope: (clientId: string, scope: "all" | string) => void;
}

const ScopeContext = createContext<ScopeContextValue>({
  scopeFor: () => "all",
  setScope: () => {},
});

function writeScopeCookie(map: ScopeMap): void {
  // path=/ so every route sees it; SameSite=Lax; ~30d. serializeScopeMap yields a
  // cookie-safe value (ids are URL-safe, no ';'/','), so no extra encoding is needed.
  document.cookie = `${SCOPE_COOKIE}=${serializeScopeMap(map)}; path=/; max-age=${SCOPE_MAX_AGE}; SameSite=Lax`;
}

export function ScopeProvider({
  initial,
  children,
}: {
  initial: ScopeMap;
  children: React.ReactNode;
}) {
  const [map, setMap] = useState<ScopeMap>(initial);
  // A ref mirrors state so setScope can be a STABLE callback (no `map` dependency)
  // yet always compute from the latest value — important because ScopeSync calls it
  // from an effect and a changing identity there could loop.
  const mapRef = useRef(map);
  mapRef.current = map;

  const setScope = useCallback((clientId: string, scope: "all" | string) => {
    const next = setScopeEntry(mapRef.current, clientId, scope === "all" ? null : scope);
    // ALWAYS persist the cookie — even when the in-memory map already matches. On a
    // hard-load the server SEED reflects the URL (URL wins), so context can already be
    // right while the COOKIE is still stale/'all'; writing here is what actually
    // remembers a URL-won scope for next time. It's a cheap, idempotent document.cookie
    // set. Skip only the state update (re-render) when nothing changed.
    writeScopeCookie(next);
    if (sameScopeMap(next, mapRef.current)) return;
    mapRef.current = next;
    setMap(next);
  }, []);

  const scopeFor = useCallback((clientId: string): "all" | string => map[clientId] ?? "all", [map]);

  const value = useMemo<ScopeContextValue>(() => ({ scopeFor, setScope }), [scopeFor, setScope]);
  return <ScopeContext.Provider value={value}>{children}</ScopeContext.Provider>;
}

export function useScope(): ScopeContextValue {
  return useContext(ScopeContext);
}

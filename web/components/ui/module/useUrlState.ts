"use client";

import { useCallback } from "react";
import { useSearchParams } from "next/navigation";

/**
 * A list filter that lives in the URL (`?filtro=archivados&q=barba`), so it survives
 * Back/Forward, a reload and a shared link. Written with history.replaceState, which the
 * Next.js router syncs into useSearchParams without a server round-trip, and without
 * adding a history entry per keystroke. Other markers in the history state (a leave
 * guard's) are kept.
 */
export function useUrlState(key: string, fallback = ""): [string, (next: string) => void] {
  const params = useSearchParams();
  const value = params.get(key) ?? fallback;
  const set = useCallback(
    (next: string) => {
      const url = new URL(window.location.href);
      if (!next || next === fallback) url.searchParams.delete(key);
      else url.searchParams.set(key, next);
      // Hand Next.js the state WITHOUT its own internals: a state that already carries
      // `__NA` is treated as the router's own write and is NOT synced into
      // useSearchParams. The router copies its internals back in; any other marker
      // (a leave guard's) is kept.
      const { __NA: _na, __PRIVATE_NEXTJS_INTERNALS_TREE: _tree, ...rest } = (window.history.state ?? {}) as Record<string, unknown>;
      void _na;
      void _tree;
      window.history.replaceState(rest, "", `${url.pathname}${url.search}${url.hash}`);
    },
    [key, fallback],
  );
  return [value, set];
}

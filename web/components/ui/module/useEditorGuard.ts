"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useLeaveGuard } from "@/components/ui/useLeaveGuard";
import { createPageFormGuard, type PageFormGuard } from "@/lib/pageFormGuard";

/**
 * While `dirty`: a link anywhere in the app asks first (the sidebar stays usable next to
 * an in-page form, so it must not drop a draft), and reload / closing the tab gets the
 * browser's own prompt. `onAsk` is told when a link was intercepted; `follow()` then
 * finishes that navigation (after «Descartar»), `forget()` stays (after «Seguir editando»).
 *
 * Used directly by settings forms that are part of the page (no history marker), and by
 * useEditorGuard for in-page editors.
 */
export function useNavigationGuard({ dirty, onAsk }: { dirty: boolean; onAsk: () => void }) {
  const router = useRouter();
  const pendingHref = useRef<string | null>(null);
  const askRef = useRef(onAsk);
  useEffect(() => {
    askRef.current = onAsk;
  });

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    // Capture on WINDOW: it runs before the framework's own link handler, so stopping the
    // event here keeps the navigation from starting.
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || (a.target && a.target !== "_self") || a.hasAttribute("download")) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      // In-page anchors (an editor's own index) are not a way out.
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      e.preventDefault();
      e.stopPropagation();
      pendingHref.current = `${url.pathname}${url.search}${url.hash}`;
      askRef.current();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("click", onClick, true);
    };
  }, [dirty]);

  const follow = useCallback(() => {
    const href = pendingHref.current;
    pendingHref.current = null;
    if (href) router.push(href);
  }, [router]);
  const forget = useCallback(() => {
    pendingHref.current = null;
  }, []);
  return { follow, forget, hasPending: () => pendingHref.current !== null };
}

/**
 * Leaving an IN-PAGE editor with unsaved changes asks first, whichever way you leave:
 *
 *   Cancelar / ‹ back / Escape   → requestLeave (useLeaveGuard)
 *   browser or system BACK       → the guard's history marker (useLeaveGuard)
 *   a link anywhere in the app   → useNavigationGuard
 *   reload / closing the tab     → the browser's own beforeunload prompt
 *
 * «Descartar» after a link click finishes that navigation; «Seguir editando» stays.
 */
export function useEditorGuard({ dirty, onLeave }: { dirty: boolean; onLeave: () => void }) {
  const followRef = useRef<() => void>(() => {});
  const guard = useLeaveGuard({
    dirty,
    onLeave: () => {
      onLeave();
      followRef.current();
    },
  });
  const requestLeave = guard.requestLeave;
  const nav = useNavigationGuard({ dirty, onAsk: requestLeave });
  useEffect(() => {
    followRef.current = nav.follow;
  });

  return {
    asking: guard.asking,
    requestLeave,
    onEscape: guard.onEscape,
    keepEditing: () => {
      nav.forget();
      guard.keepEditing();
    },
    discard: guard.discard,
    /** After a successful save: leave without asking. */
    leave: guard.leave,
  };
}

/**
 * The page-form version (the form IS the page): while `dirty`, asks before ANY way out
 * drops the draft — a link (useNavigationGuard), a reload (beforeunload) and the
 * browser / system BACK (a one-entry history marker, only while there are changes).
 * «Seguir editando» keeps the draft; «Descartar» finishes the navigation that was asked
 * for, exactly once (back, or the link). Render <DiscardChanges> while `asking`.
 *
 * The behaviour lives in lib/pageFormGuard (unit-tested against a fake history); this
 * hook only feeds it the form's state and the router.
 */
export function usePageFormGuard(dirty: boolean) {
  const [asking, setAsking] = useState(false);
  const guardRef = useRef<PageFormGuard | null>(null);
  const nav = useNavigationGuard({
    dirty,
    onAsk: () => {
      guardRef.current?.askLink();
    },
  });
  const followRef = useRef(nav.follow);
  useEffect(() => {
    followRef.current = nav.follow;
  });

  useEffect(() => {
    const guard = createPageFormGuard({
      history: window.history,
      events: window,
      pathname: () => window.location.pathname,
      onAsk: () => setAsking(true),
      followLink: () => followRef.current(),
    });
    guardRef.current = guard;
    return () => {
      guard.dispose();
      if (guardRef.current === guard) guardRef.current = null;
    };
  }, []);
  useEffect(() => {
    guardRef.current?.setDirty(dirty);
  }, [dirty]);

  return {
    asking,
    keepEditing: () => {
      guardRef.current?.keepEditing();
      nav.forget();
      setAsking(false);
    },
    discard: () => {
      setAsking(false);
      guardRef.current?.discard();
    },
  };
}

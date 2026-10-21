"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useLeaveGuard } from "@/components/ui/useLeaveGuard";
import { createLeaveGuard, type LeaveGuard } from "@/lib/leaveGuard";

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
 * browser / system BACK. For Back it arms the same one-entry history marker as the
 * in-page editors (lib/leaveGuard), but only while there are changes, so a clean page
 * adds nothing to the history. «Seguir editando» keeps the draft; «Descartar» finishes
 * the navigation that was asked for, exactly once (back, or the link). Render
 * <DiscardChanges> while `asking`.
 */
export function usePageFormGuard(dirty: boolean) {
  const [asking, setAsking] = useState(false);
  const reason = useRef<"link" | "back" | null>(null);
  const dirtyRef = useRef(dirty);
  useEffect(() => {
    dirtyRef.current = dirty;
  });
  const nav = useNavigationGuard({
    dirty,
    onAsk: () => {
      reason.current = "link";
      setAsking(true);
    },
  });
  const followRef = useRef(nav.follow);
  useEffect(() => {
    followRef.current = nav.follow;
  });

  const left = useRef(false);

  const guardRef = useRef<LeaveGuard | null>(null);
  useEffect(() => {
    if (!dirty) return;
    left.current = false;
    // Where the marker was added: if we are still on this path when the guard goes (saved,
    // reset, or the form remounted for another site), the marker entry is ours to drop.
    const armedPath = window.location.pathname;
    const guard = createLeaveGuard({
      history: window.history,
      events: window,
      key: "__pageFormGuard",
      isDirty: () => dirtyRef.current,
      onAsk: () => {
        reason.current = "back";
        setAsking(true);
      },
      // Runs after the marker is gone: complete what the person was doing.
      onLeave: () => {
        left.current = true;
        const why = reason.current;
        reason.current = null;
        if (why === "back") window.history.back();
        else if (why === "link") followRef.current();
      },
    });
    guard.arm();
    guardRef.current = guard;
    return () => {
      // Saved, reset or switched site: drop the marker entry. dispose() does it when the
      // entry still carries our key; a save's router refresh rewrites the state and drops
      // the key, so while we are still on the same page we pop the (same-URL) entry
      // ourselves — otherwise the next Back would land on a ghost copy of this page. After
      // a real navigation the path differs and the history is left alone.
      const carriesKey = Boolean((window.history.state as Record<string, unknown> | null)?.__pageFormGuard);
      guard.dispose();
      if (!carriesKey && !left.current && window.location.pathname === armedPath) window.history.back();
      if (guardRef.current === guard) guardRef.current = null;
    };
  }, [dirty]);

  return {
    asking,
    keepEditing: () => {
      reason.current = null;
      nav.forget();
      setAsking(false);
    },
    discard: () => {
      setAsking(false);
      const guard = guardRef.current;
      if (guard) guard.leave();
      else if (reason.current === "link") nav.follow();
    },
  };
}

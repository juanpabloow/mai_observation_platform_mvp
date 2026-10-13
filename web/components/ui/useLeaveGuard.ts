"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createLeaveGuard, type LeaveGuard } from "@/lib/leaveGuard";

/**
 * React wrapper for lib/leaveGuard: one guard per open form, armed on mount.
 *
 *   requestLeave  Cancelar / Cerrar / scrim — asks when `dirty`, else leaves.
 *   onEscape      Escape — closes the question first if it is open, else requestLeave.
 *   keepEditing   "Seguir editando": closes the question, the draft is untouched.
 *   discard       "Descartar": leaves without saving anything.
 *   leave         after a successful save: leaves without asking.
 *
 * StrictMode mounts effects twice in development. Disposing is deferred one tick and
 * cancelled by the re-mount, so the double mount reuses ONE guard and ONE history entry
 * instead of pushing, popping and pushing again.
 */
export function useLeaveGuard({ dirty, onLeave }: { dirty: boolean; onLeave: () => void }) {
  const [asking, setAsking] = useState(false);
  const dirtyRef = useRef(dirty);
  const onLeaveRef = useRef(onLeave);
  useEffect(() => {
    dirtyRef.current = dirty;
    onLeaveRef.current = onLeave;
  });

  const guardRef = useRef<LeaveGuard | null>(null);
  const pendingDispose = useRef<number | null>(null);
  useEffect(() => {
    if (pendingDispose.current !== null) {
      window.clearTimeout(pendingDispose.current);
      pendingDispose.current = null;
    }
    let guard = guardRef.current;
    if (!guard) {
      guard = createLeaveGuard({
        history: window.history,
        events: window,
        isDirty: () => dirtyRef.current,
        onAsk: () => setAsking(true),
        onLeave: () => onLeaveRef.current(),
      });
      guard.arm();
      guardRef.current = guard;
    }
    const current = guard;
    return () => {
      pendingDispose.current = window.setTimeout(() => {
        current.dispose();
        if (guardRef.current === current) guardRef.current = null;
        pendingDispose.current = null;
      }, 0);
    };
  }, []);

  const requestLeave = useCallback(() => guardRef.current?.requestLeave(), []);
  const keepEditing = useCallback(() => setAsking(false), []);
  const discard = useCallback(() => {
    setAsking(false);
    guardRef.current?.leave();
  }, []);
  const leave = useCallback(() => guardRef.current?.leave(), []);
  const askingRef = useRef(asking);
  useEffect(() => {
    askingRef.current = asking;
  });
  const onEscape = useCallback(() => {
    if (askingRef.current) setAsking(false);
    else guardRef.current?.requestLeave();
  }, []);

  return { asking, requestLeave, onEscape, keepEditing, discard, leave };
}

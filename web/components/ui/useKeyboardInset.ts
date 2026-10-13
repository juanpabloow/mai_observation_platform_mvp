"use client";

import { useEffect, useState, type RefObject } from "react";
import { keyboardInset } from "@/lib/keyboardInset";

/**
 * Track the keyboard inset, and keep the focused field visible inside `scrollRoot` when
 * the keyboard opens. No-ops where VisualViewport is missing.
 */
export function useKeyboardInset(scrollRoot?: RefObject<HTMLElement | null>): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const sync = () => setInset(keyboardInset(window.innerHeight, vv.height, vv.offsetTop));
    sync();
    vv.addEventListener("resize", sync);
    vv.addEventListener("scroll", sync);
    return () => {
      vv.removeEventListener("resize", sync);
      vv.removeEventListener("scroll", sync);
    };
  }, []);
  useEffect(() => {
    const root = scrollRoot?.current;
    if (!root || inset === 0) return;
    const el = document.activeElement;
    if (el instanceof HTMLElement && root.contains(el)) el.scrollIntoView({ block: "nearest" });
  }, [inset, scrollRoot]);
  return inset;
}

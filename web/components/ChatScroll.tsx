"use client";

import { useEffect, useRef } from "react";

/**
 * Scrollable chat container. The transcript itself is server-rendered and passed
 * as children; this thin client wrapper only manages the initial scroll on open:
 *
 * - With `focusSelector`, it centers the first matching element (used by the
 *   execution-detail panel to reveal THIS execution's turn, which may be
 *   mid-history).
 * - Otherwise it jumps to the BOTTOM (newest), like opening a real chat.
 */
export function ChatScroll({
  children,
  className,
  focusSelector,
}: {
  children: React.ReactNode;
  className?: string;
  focusSelector?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    if (focusSelector) {
      const target = el.querySelector<HTMLElement>(focusSelector);
      if (target) {
        // Center the target within the container (getBoundingClientRect avoids
        // any offsetParent assumptions). Browser clamps out-of-range scrollTop.
        const cRect = el.getBoundingClientRect();
        const tRect = target.getBoundingClientRect();
        el.scrollTop += tRect.top - cRect.top - (el.clientHeight / 2 - target.clientHeight / 2);
        return;
      }
    }

    // Default / fallback: start at the bottom (most recent messages).
    el.scrollTop = el.scrollHeight;
  }, [focusSelector]);

  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}

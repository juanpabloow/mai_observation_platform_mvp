"use client";

import { useEffect, useRef } from "react";

/**
 * Scrollable chat container that opens scrolled to the BOTTOM (the most recent
 * messages), like opening a real chat — full history is available by scrolling
 * up. The transcript itself is server-rendered and passed as children; this is a
 * thin client wrapper that only manages the initial scroll position.
 */
export function ChatScroll({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (el) {
      // Jump (no smooth animation) so it simply starts at the bottom.
      el.scrollTop = el.scrollHeight;
    }
  }, []);

  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}

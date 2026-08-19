"use client";

import { useEffect, useRef, useState, type RefObject } from "react";

/**
 * OVERLAY BEHAVIOUR — one definition for every panel that COVERS content instead of
 * sitting beside it.
 *
 * Beside-content panels (the desktop staff drawer, the desktop customer column) need
 * nothing from this file: a hairline against the canvas already says where they start
 * and end, which is why this system does not use shadows for depth.
 *
 * A panel that covers content is a different object, and it owes the reader three
 * things a hairline cannot give:
 *   1. a SCRIM — the thing underneath must visibly recede, or the panel reads as part
 *      of the page rather than on top of it;
 *   2. an ESCAPE — tapping the scrim or pressing Esc closes it, because there is no
 *      surrounding page left to click;
 *   3. a FOCUS TRAP — keyboard focus must not wander into content the reader cannot
 *      see, and must come back where it started when the panel closes.
 *
 * The Inbox's mobile customer drawer had (1) and half of (2); the staff drawer had
 * none of them. Both use this now, so they behave the same way.
 */

/** The scrim's own classes. Rendered as a <button> or a <Link> by the caller, because
 *  "close" is a state change in one place and a navigation in the other. */
export const OVERLAY_SCRIM = "fixed inset-0 z-40 bg-black/40";

/** True while the viewport is NARROWER than the panel's beside-breakpoint, i.e. while a
 *  panel that is a column on desktop is an overlay here. Defaults to Tailwind's `lg`
 *  (1023.98px) — the staff drawer's breakpoint; the contacts panel is wider so it beside-s
 *  only from `xl` and passes 1279.98. Pass the value that matches the component's own
 *  `<bp>:` classes. SSR-safe: false until mounted, which is the desktop assumption and
 *  matches what the server rendered. */
export function useIsOverlayWidth(maxWidthPx = 1023.98): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${maxWidthPx}px)`);
    const sync = () => setNarrow(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, [maxWidthPx]);
  return narrow;
}

/**
 * Trap focus inside `ref` while `active`, close on Escape, and restore focus to
 * whatever had it when the trap engaged.
 *
 * Deliberately NOT active for the desktop layouts: trapping focus in a panel the
 * reader can see beside the content would make the rest of the screen unreachable by
 * keyboard for no reason.
 */
export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  { active, onClose }: { active: boolean; onClose: () => void },
): void {
  useEffect(() => {
    if (!active) return;
    const node = ref.current;
    if (!node) return;
    const restoreTo = document.activeElement as HTMLElement | null;

    const focusable = (): HTMLElement[] =>
      Array.from(
        node.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => el.offsetParent !== null);

    // Move focus in, so the first Tab lands inside rather than back in the page.
    (focusable()[0] ?? node).focus({ preventScroll: true });

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusable();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      // Wrap at both ends — the trap is these two lines.
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      restoreTo?.focus?.({ preventScroll: true });
    };
  }, [active, onClose, ref]);
}

/** A ref you can hand to a panel that needs the trap, without wiring useRef at every
 *  call site. Returns the ref to spread onto the panel element. */
export function useTrappedPanel({
  active,
  onClose,
}: {
  active: boolean;
  onClose: () => void;
}): RefObject<HTMLElement | null> {
  const ref = useRef<HTMLElement | null>(null);
  useFocusTrap(ref, { active, onClose });
  return ref;
}

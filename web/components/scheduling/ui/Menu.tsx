"use client";

import Link from "next/link";
import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { POPOVER } from "./system";

/**
 * A disclosure MENU (the "⋯" / "Acciones" / state pickers of Scheduling): a trigger and
 * a list that closes on outside click, on Escape and after a choice. Opening it never
 * saves anything — only a chosen item acts. The list is a floating card; items are
 * controls (12px, 44px tall on touch widths).
 *
 * `floating` mode renders the list in a PORTAL (into <body>, `position: fixed`) so it is
 * never clipped by a scrolling/`overflow-hidden` ancestor — e.g. the last card of a tall
 * pipeline column. It is anchored to the trigger, measured after it mounts, and FLIPS
 * above the trigger when there isn't room below (and clamped to the viewport, scrolling
 * its own items if it still doesn't fit). Keyboard/touch stay the same: because the list
 * leaves the trigger's DOM position, focus moves into it on open and Escape returns focus
 * to the trigger, so it is still reachable by keyboard; outside-click still counts the
 * portaled list as "inside". The default (non-floating) path is unchanged.
 */
export function Menu({
  label,
  open,
  onToggle,
  onClose,
  trigger,
  align = "right",
  disabled,
  floating = false,
  children,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  /** Visible trigger content. Omitted → the "⋯" icon button. */
  trigger?: ReactNode;
  /** Which edge of the trigger the list lines up with. */
  align?: "left" | "right";
  disabled?: boolean;
  /** Portal the list into <body> and flip it above the trigger when it won't fit below. */
  floating?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState<{ left: number; top: number; maxHeight: number } | null>(null);
  const focusedRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      // The portaled list lives outside `ref`, so it is counted "inside" explicitly.
      if (ref.current?.contains(t) || listRef.current?.contains(t)) return;
      onClose();
    };
    // Outside a focus-trapped panel (which peels Escape itself), Escape closes the menu.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (floating) triggerRef.current?.focus();
        onClose();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose, floating]);

  // Anchor the portaled list to the trigger and flip it up when there's no room below.
  useLayoutEffect(() => {
    if (!open || !floating) return;
    const place = () => {
      const trigger = triggerRef.current;
      const list = listRef.current;
      if (!trigger || !list) return;
      const r = trigger.getBoundingClientRect();
      const gap = 6;
      const margin = 8;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const naturalH = list.scrollHeight; // full content, ignoring any maxHeight clamp
      const w = list.offsetWidth;
      const spaceBelow = vh - r.bottom - margin;
      const spaceAbove = r.top - margin;
      const up = spaceBelow < naturalH + gap && spaceAbove > spaceBelow;
      const maxHeight = Math.max(140, (up ? spaceAbove : spaceBelow) - gap);
      const usedH = Math.min(naturalH, maxHeight);
      const top = up ? Math.max(margin, r.top - gap - usedH) : r.bottom + gap;
      let left = align === "right" ? r.right - w : r.left;
      left = Math.min(Math.max(margin, left), vw - w - margin);
      setCoords({ left, top, maxHeight });
    };
    place();
    window.addEventListener("scroll", place, true); // capture → also the inner column scroll
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, floating, align]);

  // A portaled list is no longer next to its trigger in the DOM: move focus into it on
  // open (once it's placed and visible) so keyboard users can reach the items.
  useEffect(() => {
    if (!open || !floating || !coords || focusedRef.current) return;
    focusedRef.current = true;
    listRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open, floating, coords]);

  // Re-arm the open-focus for the next time it opens. (coords is re-measured synchronously
  // in the layout effect before paint on reopen, so there's nothing to reset there.)
  useEffect(() => {
    if (!open) focusedRef.current = false;
  }, [open]);

  const list = (
    <div
      ref={listRef}
      role="menu"
      aria-label={label}
      onClick={(e) => e.stopPropagation()}
      className={
        floating
          ? `fixed z-[60] flex min-w-[13.5rem] flex-col overflow-y-auto p-1.5 ${POPOVER}`
          : `absolute ${align === "left" ? "left-0" : "right-0"} top-[calc(100%+6px)] z-20 flex min-w-[13.5rem] flex-col p-1.5 ${POPOVER}`
      }
      style={
        floating
          ? { left: coords?.left ?? -9999, top: coords?.top ?? -9999, maxHeight: coords?.maxHeight, visibility: coords ? "visible" : "hidden" }
          : undefined
      }
    >
      {children}
    </div>
  );

  return (
    <div ref={ref} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={trigger ? label : undefined}
        title={trigger ? undefined : label}
        onClick={onToggle}
        disabled={disabled}
        className={
          trigger
            ? "u-focus rounded-full disabled:opacity-50"
            : "u-focus inline-flex size-[44px] items-center justify-center rounded-sch-control text-muted transition-colors hover:bg-subtle hover:text-foreground aria-expanded:bg-subtle aria-expanded:text-foreground lg:size-[36px]"
        }
      >
        {trigger ?? (
          <>
            <span className="sr-only">{label}</span>
            <svg aria-hidden viewBox="0 0 16 16" className="size-4" fill="currentColor">
              <circle cx="3.5" cy="8" r="1.25" />
              <circle cx="8" cy="8" r="1.25" />
              <circle cx="12.5" cy="8" r="1.25" />
            </svg>
          </>
        )}
      </button>
      {open ? (floating ? (typeof document !== "undefined" ? createPortal(list, document.body) : null) : list) : null}
    </div>
  );
}

const ITEM =
  "u-focus flex h-[44px] w-full items-center gap-2.5 rounded-sch-control px-3 text-left text-sm transition-colors hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-50 lg:h-[40px]";

export function MenuButton({ onClick, disabled, danger, children }: { onClick: () => void; disabled?: boolean; danger?: boolean; children: ReactNode }) {
  return (
    <button type="button" role="menuitem" onClick={onClick} disabled={disabled} className={`${ITEM} ${danger ? "text-danger" : "text-foreground"}`}>
      {children}
    </button>
  );
}

export function MenuLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link role="menuitem" href={href} className={`${ITEM} text-foreground`}>
      {children}
    </Link>
  );
}

/** A hairline between groups of items (e.g. before the destructive ones). */
export function MenuSeparator() {
  return <div role="separator" className="my-1 h-px bg-line" />;
}

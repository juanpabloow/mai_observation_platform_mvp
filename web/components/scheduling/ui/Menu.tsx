"use client";

import Link from "next/link";
import { useEffect, useRef, type ReactNode } from "react";
import { POPOVER } from "./system";

/**
 * A disclosure MENU (the "⋯" / "Acciones" / state pickers of Scheduling): a trigger and
 * a list that closes on outside click, on Escape and after a choice. Opening it never
 * saves anything — only a chosen item acts. The list is a floating card; items are
 * controls (12px, 44px tall on touch widths).
 */
export function Menu({
  label,
  open,
  onToggle,
  onClose,
  trigger,
  align = "right",
  disabled,
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
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    // Outside a focus-trapped panel (which peels Escape itself), Escape closes the menu.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);
  return (
    <div ref={ref} className="relative">
      <button
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
      {open ? (
        <div
          role="menu"
          aria-label={label}
          className={`absolute ${align === "left" ? "left-0" : "right-0"} top-[calc(100%+6px)] z-20 flex min-w-[13.5rem] flex-col p-1.5 ${POPOVER}`}
          onClick={(e) => e.stopPropagation()}
        >
          {children}
        </div>
      ) : null}
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

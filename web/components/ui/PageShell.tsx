import type { ReactNode } from "react";

/**
 * THE page shell — the single floating surface every operative screen renders into.
 *
 * WHY THIS EXISTS. The shell's gutter has always been correct: app/layout.tsx's
 * scroll container pads the content region by --content-pad, so a page's root box
 * already sits 16px inside the viewport with the canvas showing on all four sides.
 * What was missing was the SURFACE. "White card, 1px hairline, 6px radius, grows to
 * the bottom of the viewport" was never a component — it was a class string
 * hand-copied into the Contacts page and the Agenda view, and simply absent from the
 * Inbox, whose columns were transparent and therefore painted the canvas grey right
 * through the middle of the screen. The `Panel` primitive next door could not be
 * reused for it: Panel is a STATIC card (fill + hairline + radius) with no height
 * contract, so it cannot grow to the viewport bottom.
 *
 * The contract, in one place:
 *   - fill --surface, 1px --line hairline, 12px radius (the reference's card radius;
 *     at 6px it read as a table with rounded corners, not as a floating card);
 *   - flex + min-h-0 + flex-1, so it grows to the bottom of the scrolling region
 *     (the area under the last row is panel, never canvas);
 *   - overflow-hidden, so children clip to the rounded corners instead of squaring
 *     them off — this is what makes the radius survive a full-bleed table or a
 *     column that draws its own edge-to-edge dividers.
 *
 * Pages own only what goes INSIDE. Anything that needs to sit outside the card (a
 * callout above it, say) stays a sibling in the page's own <main>.
 */
export function PageShell({
  children,
  className = "",
  row = false,
  as: As = "section",
  ariaLabel,
}: {
  children: ReactNode;
  className?: string;
  /** Lay the card's own children out as COLUMNS (the Inbox's three panes). */
  row?: boolean;
  as?: "section" | "main" | "div";
  ariaLabel?: string;
}) {
  return (
    <As
      aria-label={ariaLabel}
      className={`flex min-h-0 min-w-0 flex-1 overflow-hidden rounded-xl border border-line bg-surface ${
        row ? "flex-row" : "flex-col"
      } ${className}`}
    >
      {children}
    </As>
  );
}

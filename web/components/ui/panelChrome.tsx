import type { ReactNode } from "react";

/**
 * THE detail-panel chrome — the frame, the close control, the footer buttons.
 *
 * Every screen in this app that opens a panel beside its list uses the same one: a card
 * that matches PageShell class for class, a quiet close glyph, and a footer whose
 * primary action never scrolls out of reach. It lives in `ui/` and not beside the
 * contact form it was written for because the staff roster draws the identical chrome,
 * and a screen should not have to import from another screen to get a button.
 *
 * READING vs CHANGING. The one distinction this chrome deliberately preserves: a panel
 * that only READS has no footer, and a panel that WRITES has one. That difference is
 * what tells the operator whether they are looking at something or changing it, so it is
 * expressed by the presence of the bar, never by a different card.
 */

/**
 * The panel card's INTERIOR half — fill, clip, column flow. Separated from the EDGE
 * because a panel that is a column at one width and a full-bleed overlay at another must
 * drop its radius and border below the breakpoint, and "PANEL_FRAME plus rounded-none"
 * does not work: two border-radius utilities of equal specificity are resolved by
 * Tailwind's OUTPUT order, not by the order they appear in the string, so the override
 * silently wins or loses depending on what else the build emitted.
 */
export const PANEL_SURFACE = "flex min-h-0 flex-col overflow-hidden bg-surface";

/** The card's EDGE — radius, hairline, lift. PageShell's own values. */
export const PANEL_EDGE = "rounded-xl border border-line shadow-[var(--shadow-card)]";

/** The same edge, applied only from `lg` — for a panel that is full-bleed below it. */
export const PANEL_EDGE_LG = "lg:rounded-xl lg:border lg:border-line lg:shadow-[var(--shadow-card)]";

/**
 * The panel card: fill, hairline, radius, clip — PageShell's own values, so a panel is
 * the same KIND of object as the cards it sits beside. It omits `flex-1`/`min-w-0`
 * because the axis is the caller's: as a row child `flex-1` makes a panel grow
 * horizontally and swallow its own width.
 */
export const PANEL_FRAME = `${PANEL_SURFACE} ${PANEL_EDGE}`;

/**
 * The close control's look. It is a Link on a panel whose selection lives in the URL
 * (closing is a navigation there, so Back works) and a button when the panel is state,
 * so only the styling can be shared — not the element.
 */
export const PANEL_CLOSE_CLS =
  "-mr-1 shrink-0 rounded-md p-1 text-faint transition-colors hover:bg-subtle hover:text-foreground";

export function PanelCloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

/**
 * Footer buttons. `nowrap` on every one of them: these labels are long ("Guardar
 * cambios", "Add staff member") and a two-line button is the first thing that breaks
 * when a panel narrows.
 *
 * The primary is INK. Red is reserved for `Agendar cita` and two other markers — see
 * the note on --ink in globals.css — so "save this form" is deliberately the same
 * colour as "create a contact" and every other primary in the app.
 */
export const BTN_PRIMARY =
  "inline-flex h-9 shrink-0 items-center whitespace-nowrap rounded-md bg-ink px-3.5 text-sm font-semibold text-ink-fg transition-colors hover:bg-ink-hover disabled:cursor-not-allowed disabled:opacity-45";
export const BTN_SECONDARY =
  "inline-flex h-9 shrink-0 items-center whitespace-nowrap rounded-md border border-line-strong bg-surface px-3 text-sm text-foreground transition-colors hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-45";
export const BTN_QUIET =
  "inline-flex h-9 shrink-0 items-center whitespace-nowrap rounded-md px-2 text-sm text-muted transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45";
export const BTN_DANGER =
  "inline-flex h-9 shrink-0 items-center whitespace-nowrap rounded-md px-2 text-sm text-danger transition-colors hover:bg-danger/8 disabled:cursor-not-allowed disabled:opacity-45";

/**
 * The HEADER action row's buttons — `rounded-lg`, one step softer than the footer's, and
 * a size smaller. The primary TAKES the leftover width and the secondaries size to their
 * labels, which is what makes the thing you most often do here unmissable.
 */
export const ACT_PRIMARY =
  "inline-flex h-9 min-w-0 flex-1 items-center justify-center whitespace-nowrap rounded-lg bg-ink px-3 text-xs font-semibold text-ink-fg transition-colors hover:bg-ink-hover";
export const ACT_SECONDARY =
  "inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border border-line-strong bg-surface px-3 text-xs transition-colors hover:bg-hover";

/**
 * The banner strip above a form. Three tones, all informational — `warn` is the
 * duplicate/conflict case and is deliberately NOT `danger`, because it does not stop a
 * save; `danger` is reserved for the thing that does.
 */
export function PanelBanner({
  tone,
  children,
}: {
  tone: "success" | "warn" | "muted" | "danger";
  children: ReactNode;
}) {
  const cls =
    tone === "success"
      ? "border-success/35 bg-success/10 text-success"
      : tone === "warn"
        ? "border-warn/35 bg-warn-soft text-warn"
        : tone === "danger"
          ? "border-danger/35 bg-danger/12 text-danger"
          : "border-line bg-card text-muted";
  const glyph = tone === "success" ? "✓" : tone === "warn" || tone === "danger" ? "⚠" : null;
  return (
    <p role={tone === "danger" ? "alert" : undefined} className={`flex items-start gap-1.5 rounded-lg border px-2.5 py-2 text-xs leading-4 ${cls}`}>
      {glyph ? (
        <span aria-hidden className="mt-px">
          {glyph}
        </span>
      ) : null}
      <span className="min-w-0">{children}</span>
    </p>
  );
}

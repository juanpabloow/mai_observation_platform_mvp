import type { ReactNode } from "react";

/**
 * THE page title band — the first row inside a screen's card.
 *
 * The app had three different answers to "what is this screen called": Customers set
 * a 19px title, the Inbox a 15px one, and the Agenda none at all (its date stepper
 * was doing the job). That is two legitimate ROLES tangled together, so this pins
 * them down:
 *
 *   PAGE TITLE (this component) — screens that are one thing: Customers, Agenda.
 *     Title, an optional count, and the scope you are looking at on the right.
 *   PANE LABEL (not this) — a column inside a workspace, like the Inbox's queue.
 *     It labels one of three panes, not the screen, so it stays a step smaller and
 *     lives inside its own column. Giving the Inbox a page band as well would have
 *     titled the same screen twice.
 *
 * `context` is the scope line ("Gallery Barber Club · 1 site") — always real, never
 * decoration: it answers "whose data am I looking at", which matters the moment an
 * operator has more than one client or site.
 */
export function PageTitle({
  title,
  count,
  context,
  children,
  actions,
}: {
  title: string;
  /** A whole-set counter, shown as a chip beside the title. */
  count?: number | string;
  /** Right-aligned scope line. */
  context?: ReactNode;
  /** Extra content, right of the title and left of the context (counters, chips). */
  children?: ReactNode;
  /** The screen's primary action — always the far right of the band. */
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      {/* 19px, in PIXELS on purpose. The reference's type is specified against a
          16px root; this app runs a 90% root (see globals.css), so `text-xl` rendered
          at 18px and the pane label at 13.5px — everything landed a notch small. The
          shell geometry tokens already take the same exemption. */}
      <h1 className="text-[19px] font-semibold tracking-tight text-foreground">{title}</h1>
      {count !== undefined ? (
        <span className="u-mono rounded-full bg-chip px-2 py-0.5 text-[0.6875rem] font-medium text-muted">
          {count}
        </span>
      ) : null}
      {children}
      {context ? <span className="ml-auto text-xs text-muted">{context}</span> : null}
      {actions ? <span className={`flex shrink-0 items-center gap-2 ${context ? "" : "ml-auto"}`}>{actions}</span> : null}
    </div>
  );
}

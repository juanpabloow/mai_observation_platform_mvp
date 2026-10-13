import type { ReactNode } from "react";
import { PageShell } from "@/components/ui/PageShell";
import { PageHeading } from "@/components/ui/PageTitle";

/**
 * The shared operative-module header.
 *
 * Agenda established the useful hierarchy: a stable title on the left, the control
 * that drives the screen in the flexible centre, and the module's actions on the
 * right. On narrow screens the centre moves to a second row instead of squeezing the
 * title or hiding the primary action. The contents stay module-specific; only the
 * geometry and surface are shared.
 */
export function ModuleHeader({
  title,
  count,
  status,
  center,
  actions,
  primary,
  className = "",
}: {
  title: string;
  count?: number | string;
  /** A short live state beside the title, never a second toolbar. */
  status?: ReactNode;
  /** Usually search, date navigation, or the module's principal view control. */
  center?: ReactNode;
  /** Filters and the primary action, in that order. */
  actions?: ReactNode;
  /**
   * OPT-IN phone layout (Contacts). When given, the screen's primary action is passed
   * here instead of inside `actions`, and below `md` the header becomes two clean rows:
   * title + count + primary, then search + the remaining actions — at 360–430px the
   * single grid row put `Filtrar` over the title. Controls are 44px there (real touch
   * targets) through tablet, and the 34px Agenda rhythm from `lg` up. Screens that do not pass it render
   * exactly the markup below, unchanged.
   */
  primary?: ReactNode;
  className?: string;
}) {
  if (primary !== undefined) {
    // Keep real touch targets on phones AND tablets; desktop headers keep 34px.
    const CTRL = "[&>a]:!h-[44px] [&>button]:!h-[44px] [&>details>summary]:!h-[44px] lg:[&>a]:!h-[34px] lg:[&>button]:!h-[34px] lg:[&>details>summary]:!h-[34px]";
    return (
      <PageShell grow={false} clip={false} className={className}>
        <div className="flex min-h-[var(--topbar-height)] flex-wrap items-center gap-x-2.5 gap-y-2 px-3 py-2.5 sm:px-4 md:flex-nowrap">
          <div className="order-1 flex min-w-0 flex-1 items-center gap-2.5 md:flex-none">
            <PageHeading title={title} count={count} />
            {status ? <span className="min-w-0 truncate text-xs text-muted">{status}</span> : null}
          </div>
          <div className={`order-2 flex shrink-0 items-center md:order-5 ${CTRL}`}>{primary}</div>
          {/* The row break: below md, search and actions always start a second row. */}
          <span aria-hidden className="order-3 h-0 basis-full md:hidden" />
          {center ? <div className="order-4 min-w-0 flex-1 md:order-2">{center}</div> : null}
          {actions ? (
            <div className={`order-5 flex shrink-0 items-center gap-1.5 md:order-3 md:ml-auto ${CTRL}`}>{actions}</div>
          ) : null}
        </div>
      </PageShell>
    );
  }
  return (
    <PageShell grow={false} clip={false} className={className}>
      <div className="grid min-h-[var(--topbar-height)] grid-cols-[minmax(0,1fr)_auto] items-center gap-2.5 px-3 py-2.5 sm:px-4 md:grid-cols-[auto_minmax(15rem,1fr)_auto]">
        <div className="flex min-w-0 shrink-0 items-center gap-2.5">
          <PageHeading title={title} count={count} />
          {status ? <span className="min-w-0 truncate text-xs text-muted">{status}</span> : null}
        </div>

        {center ? (
          <div className="order-3 col-span-2 min-w-0 md:order-none md:col-span-1">{center}</div>
        ) : (
          <span className="hidden md:block" />
        )}

        {actions ? (
          <div className="ml-auto flex shrink-0 items-center gap-1.5 [&>a]:!h-[34px] [&>button]:!h-[34px] [&>details>summary]:!h-[34px]">
            {actions}
          </div>
        ) : null}
      </div>
    </PageShell>
  );
}

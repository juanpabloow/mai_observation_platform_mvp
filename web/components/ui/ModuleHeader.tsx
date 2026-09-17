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
  className?: string;
}) {
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

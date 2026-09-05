import type { ReactNode } from "react";
import { PageShell } from "@/components/ui/PageShell";
import { PageHeading } from "@/components/ui/PageTitle";

/**
 * THE roster's header card — ONE LINE: the title, the search, the primary action.
 *
 * It arrived here in three steps. It was three bands (title + count + scope + presence
 * counters / a tab strip / search + three facets + primary). Then two, with everything
 * that FILTERS moved down into the list card beside the rows it acts on. Now one, because
 * the tab strip is gone: two of its three tabs were stubs, and a tab that opens an empty
 * panel spends a click to say the feature does not exist (see StaffWorkspace).
 *
 * WHAT WAS REMOVED ALONG THE WAY, deliberately:
 *   - the COUNT chip beside the title. It is the "Todos N" facet pill in the list card,
 *     one row down, and clickable.
 *   - the SCOPE line ("Gallery"). The breadcrumb two rows up names the client, and does so
 *     on every screen in the app.
 *   - the presence COUNTERS. They became those pills — the number is now the control
 *     rather than a statistic sitting beside one.
 *   - the TAB STRIP. See above.
 * None of those facts is lost; each is stated exactly once, where it can be acted on.
 *
 * The geometry is Contacts' title row, class for class, so the product's two list screens
 * open the same way.
 */
export interface StaffHeaderSlots {
  title: string;
}

export function StaffHeaderCard({
  slots,
  controls,
}: {
  slots: StaffHeaderSlots;
  /**
   * The row's right-hand side: the search and the primary action, in that order. Absent
   * when there is nothing to list — the card is then the title alone, which is what keeps
   * the empty state from losing the screen's name.
   */
  controls?: ReactNode;
}) {
  return (
    // grow={false}: this card sizes to its content and the roster below absorbs the
    // leftover height — the same division of the region Contacts uses.
    <PageShell grow={false}>
      <div className="flex flex-wrap items-center gap-2.5 px-3 py-2">
        <PageHeading title={slots.title} className="px-1.5" />
        {controls}
      </div>
    </PageShell>
  );
}

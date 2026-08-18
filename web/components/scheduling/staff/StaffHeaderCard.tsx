import type { ReactNode } from "react";
import { PageShell } from "@/components/ui/PageShell";
import { PageTitle } from "@/components/ui/PageTitle";

/**
 * THE roster's header card — the same three-band arrangement Contacts uses, so the two
 * list screens read as one product.
 *
 * WHAT THIS CHANGED. Staff drew its own card (a hand-rolled `rounded-2xl
 * border-line-strong` div) with three bands of its own invention: title + primary
 * action, then the tabs, then filters with the presence legend pushed to the right on an
 * `ml-auto`. Contacts had already settled the arrangement, and it settled it for a
 * reason: the title band is WHAT you are looking at (name, count, scope, counters) and
 * the band below it is what you can DO (search, facets, and the one primary action at
 * the far right). Mixing the two is what left Staff with a legend floating in the
 * control row and an "Add staff member" button up on the title line, three bands where
 * Contacts needs two.
 *
 * The TAB STRIP is the one band Contacts has no equivalent for, so it keeps the
 * treatment the app already uses for tabs inside a card (the contact panel's): flush to
 * the card's edges, drawing the rule that separates identity from controls. It sits
 * BETWEEN them rather than above the title, because the tabs switch what the controls
 * below act on.
 *
 * Only the geometry is shared. Every string, count, facet and action still comes from
 * the caller — nothing on this screen was added, removed or renamed.
 */
export interface StaffHeaderSlots {
  title: string;
  /** The scope line — which client's roster this is. */
  context: ReactNode;
  /** Whole-set count beside the title. Absent on the tabs that have nothing to count. */
  count?: number;
  /** The tab strip. The page owns it (it switches the page's tab), so it is passed in. */
  tabs: ReactNode;
}

export function StaffHeaderCard({
  slots,
  counters,
  controls,
}: {
  slots: StaffHeaderSlots;
  /** Title-band counters — SummaryBit, same as Contacts. Only the roster has any. */
  counters?: ReactNode;
  /** The control band: search, facets, primary action. Absent on a stub tab, which has
   *  nothing to filter — the card then ends at the tab strip's rule. */
  controls?: ReactNode;
}) {
  return (
    // grow={false}: this card sizes to its content and the roster below absorbs the
    // leftover height — the same division of the region Contacts uses.
    <PageShell grow={false}>
      <div className="px-[var(--panel-pad)] pb-2.5 pt-3">
        <PageTitle title={slots.title} count={slots.count} context={slots.context}>
          {counters}
        </PageTitle>
      </div>
      {slots.tabs}
      {controls ? (
        <div className="flex flex-wrap items-center gap-2 px-[var(--panel-pad)] py-3">{controls}</div>
      ) : null}
    </PageShell>
  );
}

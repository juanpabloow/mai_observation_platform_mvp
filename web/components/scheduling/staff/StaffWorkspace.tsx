"use client";

import { useState, type ReactNode } from "react";
import { PageShell } from "@/components/ui/PageShell";
import { StaffHeaderCard, type StaffHeaderSlots } from "./StaffHeaderCard";
import { StaffTab, type StaffTabProps } from "./StaffTab";

/**
 * STAFF — the operational roster, under SCHEDULING.
 *
 * It briefly lived inside Team, which was the wrong home: Team answers "who can log
 * into the platform and with what role", and a barber is not a user — they are a
 * bookable resource with hours, services and a performance record. Everything that
 * hangs off this screen (the agenda lane, working_hours, staff_services,
 * schedule_exceptions) is scheduling data, so the screen belongs beside the agenda.
 * Nothing was rebuilt in the move; the components are the same ones.
 *
 * TODO(staff): Shifts and Time off are STUBS. Shifts needs a published-rota model
 *   (today a barber has weekly `working_hours`, not shifts); Time off needs a request
 *   and approval flow on top of `schedule_exceptions`, which only stores blocked time
 *   with no requester, state or decision. Neither is faked with a count.
 */
const TABS = [
  { key: "staff", label: "Staff" },
  { key: "shifts", label: "Shifts" },
  { key: "timeoff", label: "Time off" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

export function StaffWorkspace({
  clientId,
  clientLabel,
  activeTab,
  staff,
}: {
  clientId: string;
  clientLabel: string;
  activeTab: string;
  /** null when the client has no site — a barber belongs to one. */
  staff: StaffTabProps | null;
}) {
  const [tab, setTab] = useState<TabKey>(
    (TABS.find((t) => t.key === activeTab)?.key ?? "staff") as TabKey,
  );

  // The title band's pieces and the tab strip. They belong to the PAGE, but they are
  // drawn inside StaffHeaderCard so the card is one box; the roster fills in the
  // counters and the controls, which are the parts only it knows.
  //
  // The count moved OFF the tab and onto the title, beside the screen's name, which is
  // where Contacts puts it. Only Staff has a number at all: Shifts and Time off have no
  // model to count (see the TODO above), and a count there would be the first fabricated
  // thing on the screen.
  const slots: StaffHeaderSlots = {
    title: "Staff",
    context: clientLabel,
    count: staff ? staff.members.length : undefined,
    tabs: (
      <div className="flex items-center gap-5 border-b border-line px-[var(--panel-pad)]" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={`-mb-px flex items-center gap-1.5 whitespace-nowrap border-b-2 pb-2.5 text-[13px] font-medium transition-colors ${
              tab === t.key
                ? "border-brand text-foreground"
                : "border-transparent text-muted hover:text-foreground"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
    ),
  };

  return (
    <main className="flex min-h-0 w-full flex-1 flex-col">
      {/* `surface="canvas"`: this screen is NOT one card. PageShell contributes the
          region (flex, min-h-0, flex-1) and lets the layout's canvas show through;
          the cards below are the page's own, so there is no card inside a card and no
          doubled border. `relative` makes this the drawer's positioning context, which
          is what lets the drawer run the FULL height of the region. */}
      <PageShell surface="canvas" className="relative">
        {tab === "staff" ? (
          staff ? (
            <StaffTab clientId={clientId} header={slots} {...staff} />
          ) : (
            <StubCard slots={slots}>
            <Empty
              title="No roster yet"
              hint="This client has no site, and a barber belongs to one. Create a site in Scheduling settings first."
            />
            </StubCard>
          )
        ) : tab === "shifts" ? (
          <StubCard slots={slots}>
            <Empty
              title="Shifts"
              hint="Coming soon. A barber has weekly working hours today, not published shifts — a rota needs its own model."
            />
          </StubCard>
        ) : (
          <StubCard slots={slots}>
            <Empty
              title="Time off"
              hint="Coming soon. Blocked time exists on the schedule, but there is no request or approval flow behind it yet."
            />
          </StubCard>
        )}
      </PageShell>
    </main>
  );
}

/** The header card plus whatever the tab has to show — so a stub tab keeps exactly the
 *  same two-card geometry as the roster instead of losing the header. */
function StubCard({ slots, children }: { slots: StaffHeaderSlots; children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <StaffHeaderCard slots={slots} />
      {children}
    </div>
  );
}

function Empty({ title, hint }: { title: string; hint: ReactNode }) {
  return (
    // The empty state is the tab's CARD, not a dashed box floating on the canvas: a stub
    // tab must keep the same two-card silhouette the roster has, or switching tabs
    // changes the shape of the screen and not just its contents.
    <PageShell>
      <div className="flex min-h-0 flex-1 items-center justify-center p-10">
        <div className="flex max-w-sm flex-col items-center gap-1 text-center">
          <p className="text-sm font-medium text-muted">{title}</p>
          <p className="text-sm text-faint">{hint}</p>
        </div>
      </div>
    </PageShell>
  );
}

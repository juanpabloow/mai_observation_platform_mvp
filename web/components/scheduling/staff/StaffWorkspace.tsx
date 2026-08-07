"use client";

import { useState, type ReactNode } from "react";
import { PageShell } from "@/components/ui/PageShell";
import { PageTitle } from "@/components/ui/PageTitle";
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
  // Only Staff has a number to show. Shifts and Time off have no model to count (see
  // the TODO above) — a count there would be the first fabricated thing on the screen.
  const [creating, setCreating] = useState(0);

  return (
    <main className="flex min-h-0 w-full flex-1 flex-col">
      <PageShell>
        <div className="flex shrink-0 flex-col gap-3 px-[var(--panel-pad)] pt-3">
          <PageTitle
            title="Staff"
            context={clientLabel}
            actions={
              // The roster's own primary action. Inviting a USER is a different job on
              // a different screen (Users & access) — this button adds a barber.
              <button
                type="button"
                onClick={() => setCreating((n) => n + 1)}
                disabled={!staff}
                className="inline-flex h-9 items-center rounded-md bg-brand px-3 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                + Add staff member
              </button>
            }
          />

          <div className="flex items-center gap-5 border-b border-line" role="tablist">
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
                {t.key === "staff" && staff ? (
                  <span className="u-mono rounded bg-chip px-1.5 text-[10px] font-medium text-muted">
                    {staff.members.length}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        </div>

        {tab === "staff" ? (
          staff ? (
            <StaffTab clientId={clientId} openCreate={creating} {...staff} />
          ) : (
            <Empty
              title="No roster yet"
              hint="This client has no site, and a barber belongs to one. Create a site in Scheduling settings first."
            />
          )
        ) : tab === "shifts" ? (
          <Empty
            title="Shifts"
            hint="Coming soon. A barber has weekly working hours today, not published shifts — a rota needs its own model."
          />
        ) : (
          <Empty
            title="Time off"
            hint="Coming soon. Blocked time exists on the schedule, but there is no request or approval flow behind it yet."
          />
        )}
      </PageShell>
    </main>
  );
}

function Empty({ title, hint }: { title: string; hint: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center bg-background p-10">
      <div className="flex max-w-sm flex-col items-center gap-1 rounded-xl border border-dashed border-line-strong bg-surface px-8 py-10 text-center">
        <p className="text-sm font-medium text-muted">{title}</p>
        <p className="text-sm text-faint">{hint}</p>
      </div>
    </div>
  );
}

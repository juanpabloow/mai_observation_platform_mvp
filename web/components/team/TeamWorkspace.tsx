"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { PageShell } from "@/components/ui/PageShell";
import { PageTitle } from "@/components/ui/PageTitle";
import { StaffTab, type StaffTabProps } from "./StaffTab";

/**
 * TEAM — the people screen, four tabs deep.
 *
 * STAFF (the roster of agendable barbers) and ROLES & PERMISSIONS (who can log in
 * and what they can see) are two different populations that were living in two
 * different places: the roster in Scheduling settings, the logins here. They are one
 * screen now, because "who works here" is one question a manager asks once.
 *
 * The nav entry stays where it is, under ADMINISTRATION — the design shows this under
 * CRM, but moving it is a navigation change nobody asked for.
 *
 * TODO(staff): Shifts and Time off are STUBS. Shifts needs a published-rota model
 *   (today a barber has weekly `working_hours`, not shifts); Time off needs a request
 *   and approval flow on top of `schedule_exceptions`, which only stores blocked time
 *   with no requester, state or decision. Neither is faked with a count.
 */
const TABS = [
  { key: "staff", label: "Staff" },
  { key: "shifts", label: "Shifts" },
  { key: "roles", label: "Roles & permissions" },
  { key: "timeoff", label: "Time off" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

export function TeamWorkspace({
  clientId,
  clientLabel,
  activeTab,
  schedulingEnabled,
  staff,
  roles,
  roleCount,
}: {
  clientId: string;
  clientLabel: string;
  activeTab: string;
  schedulingEnabled: boolean;
  /** null when the client has no scheduling module / no site. */
  staff: StaffTabProps | null;
  /** The EXISTING team management, rendered inside its own tab rather than rebuilt. */
  roles: ReactNode;
  roleCount: number;
}) {
  const [tab, setTab] = useState<TabKey>(
    (TABS.find((t) => t.key === activeTab)?.key ?? "staff") as TabKey,
  );

  const count = (k: TabKey): number | null => {
    if (k === "staff") return staff?.members.length ?? 0;
    if (k === "roles") return roleCount;
    // Shifts and Time off have no model to count (see the TODO above) — a number here
    // would be the first fabricated thing on the screen.
    return null;
  };

  return (
    <main className="flex min-h-0 w-full flex-1 flex-col">
      <PageShell>
        <div className="flex shrink-0 flex-col gap-3 px-[var(--panel-pad)] pt-3">
          <PageTitle
            title="Staff"
            context={clientLabel}
            actions={
              // TODO(staff): "Invite teammate" creates a USER with a role, which is the
              //   Roles & permissions tab's invite form — not a staff row. It jumps
              //   there instead of opening a second, divergent invite dialog.
              <button
                type="button"
                onClick={() => setTab("roles")}
                className="inline-flex h-9 items-center rounded-md bg-brand px-3 text-sm font-medium text-white transition-opacity hover:opacity-90"
              >
                Invite teammate
              </button>
            }
          />

          <div className="flex items-center gap-5 border-b border-line" role="tablist">
            {TABS.map((t) => {
              const n = count(t.key);
              return (
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
                  {n !== null ? (
                    <span className="u-mono rounded bg-chip px-1.5 text-[10px] font-medium text-muted">{n}</span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>

        {tab === "staff" ? (
          staff ? (
            <StaffTab clientId={clientId} {...staff} />
          ) : (
            <Empty
              title="No roster yet"
              hint={
                schedulingEnabled ? (
                  <>
                    This client has no site, and a barber belongs to one.{" "}
                    <Link href={`/clients/${clientId}/scheduling/admin`} className="text-accent hover:underline">
                      Create a site
                    </Link>{" "}
                    first.
                  </>
                ) : (
                  "Scheduling is off for this client, so there are no agendable staff."
                )
              }
            />
          )
        ) : tab === "roles" ? (
          <div className="min-h-0 flex-1 overflow-y-auto bg-background p-4">
            <div className="mx-auto w-full max-w-2xl rounded-xl border border-line-strong bg-surface p-5">{roles}</div>
          </div>
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

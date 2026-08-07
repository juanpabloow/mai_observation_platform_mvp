"use client";

import { useState, useTransition } from "react";
import { createStaffAction, setStaffServiceAction, updateStaffAction } from "@/lib/schedulingAdminActions";
import { gridFromWeekly, HoursGrid, weeklyFromGrid, type HourGrid } from "@/components/scheduling/HoursGrid";
import type { StaffMember, StaffServiceOpt, StaffSiteOpt } from "./StaffTab";

/**
 * EDIT a barber — name, the services they can perform, and whether they hold a chair.
 *
 * It writes through the SAME server actions the Scheduling settings form has always
 * used (`updateStaffAction`, `setStaffServiceAction`), so client scoping, the
 * owner/admin gate and the "service must belong to this client" check are unchanged.
 * Nothing new was invented at the data layer for this screen.
 *
 * Services are saved as a DIFF (one call per changed pairing) because the action is
 * per-pair — sending the whole set every time would rewrite rows that did not change.
 *
 * With `member: null` it CREATES instead (createStaffAction) — the "+ Add staff
 * member" card. Creating and editing a barber both live here now; Scheduling settings
 * kept sites, the service catalogue and blocked time.
 *
 * TODO(staff): the design's form also has ROLE, PHONE and EMAIL. `staff` has no such
 *   columns (id, site, name, working_hours, active), so those inputs render DISABLED
 *   with the reason on hover rather than pretending to save.
 * TODO(staff): moving a barber between SITES is not an update the repo supports
 *   (site_id is set at creation and staff belong to exactly one site in V1), so the
 *   site select is read-only here.
 */
export function StaffEditDialog({
  clientId,
  member,
  siteId,
  services,
  sites,
  onClose,
  onSaved,
}: {
  clientId: string;
  /** null = CREATE a new barber at `siteId`. */
  member: StaffMember | null;
  siteId?: string;
  services: StaffServiceOpt[];
  sites: StaffSiteOpt[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(member?.name ?? "");
  const [serviceIds, setServiceIds] = useState<string[]>(member?.serviceIds ?? []);
  const [active, setActive] = useState(member?.active ?? true);
  const [grid, setGrid] = useState<HourGrid>(gridFromWeekly((member?.workingHours ?? {}) as never));
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const toggle = (id: string) =>
    setServiceIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const save = () => {
    setError(null);
    start(async () => {
      const trimmed = name.trim();
      if (trimmed === "") {
        setError("A name is required.");
        return;
      }
      const workingHours = weeklyFromGrid(grid);
      if (!member) {
        // CREATE: one call takes the name, the site and the service set.
        const target = siteId ?? sites[0]?.id;
        if (!target) {
          setError("This client has no site yet.");
          return;
        }
        const r = await createStaffAction({ clientId, siteId: target, name: trimmed, serviceIds });
        if (!r.ok) {
          setError(r.error);
          return;
        }
        // Hours are a separate patch — createStaffAction takes no schedule.
        if (Object.keys(workingHours).length > 0 && r.id) {
          const h = await updateStaffAction(clientId, r.id, { workingHours });
          if (!h.ok) {
            setError(h.error);
            return;
          }
        }
        onSaved();
        return;
      }

      const r = await updateStaffAction(clientId, member.id, { name: trimmed, active, workingHours });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      // Only the pairings that actually changed.
      const added = serviceIds.filter((id) => !member.serviceIds.includes(id));
      const removed = member.serviceIds.filter((id) => !serviceIds.includes(id));
      for (const id of added) {
        const res = await setStaffServiceAction(clientId, member.id, id, true);
        if (!res.ok) {
          setError(res.error);
          return;
        }
      }
      for (const id of removed) {
        const res = await setStaffServiceAction(clientId, member.id, id, false);
        if (!res.ok) {
          setError(res.error);
          return;
        }
      }
      onSaved();
    });
  };

  const siteName = sites.find((s) => s.id === (member?.siteId ?? siteId))?.name ?? member?.siteName ?? "—";

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-6" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-xl border border-line bg-popover p-5 text-popover-foreground shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold">{member ? "Edit profile" : "Add staff member"}</h2>

        <div className="mt-4 flex flex-col gap-3">
          <Field label="Name">
            <input value={name} onChange={(e) => setName(e.target.value)} className={INPUT} placeholder="Full name" />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Role">
              <input
                disabled
                placeholder="No role field yet"
                title="`staff` has no role column — adding one is a migration"
                className={`${INPUT} cursor-not-allowed opacity-60`}
              />
            </Field>
            <Field label="Site">
              <input
                disabled
                value={siteName}
                readOnly
                title="A barber belongs to one site in V1; moving them is not an update the repository supports"
                className={`${INPUT} cursor-not-allowed opacity-60`}
              />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Phone">
              <input
                disabled
                placeholder="No phone field yet"
                title="`staff` has no contact columns — adding them is a migration"
                className={`${INPUT} cursor-not-allowed opacity-60`}
              />
            </Field>
            <Field label="Email">
              <input
                disabled
                placeholder="No email field yet"
                title="`staff` has no contact columns — adding them is a migration"
                className={`${INPUT} cursor-not-allowed opacity-60`}
              />
            </Field>
          </div>

          <div className="flex flex-col gap-1.5 border-t border-line pt-3">
            <span className="text-xs text-muted">Services</span>
            {services.filter((s) => s.active).length === 0 ? (
              <p className="text-sm text-faint">This client has no active services yet.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {services
                  .filter((s) => s.active)
                  .map((s) => {
                    const on = serviceIds.includes(s.id);
                    return (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => toggle(s.id)}
                        aria-pressed={on}
                        className={`inline-flex h-8 items-center rounded-md border px-2.5 text-xs transition-colors ${
                          on
                            ? "border-transparent bg-foreground text-background"
                            : "border-line-strong text-muted hover:bg-hover"
                        }`}
                      >
                        {s.name}
                      </button>
                    );
                  })}
              </div>
            )}
          </div>

          <div className="flex flex-col gap-1.5 border-t border-line pt-3">
            <span className="text-xs text-muted">Working hours</span>
            <p className="text-[11px] text-faint">All days off = inherit the site&rsquo;s opening hours.</p>
            <HoursGrid grid={grid} setGrid={setGrid} />
          </div>

          {/* ACTIVE is the real "holds a chair" flag: an inactive barber keeps their
              history and their lane on the agenda but takes no new bookings. */}
          <label className={`flex items-center gap-2 border-t border-line pt-3 text-sm ${member ? "" : "hidden"}`}>
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="size-4" />
            <span>
              Takes bookings
              <span className="ml-1.5 text-xs text-faint">
                — off keeps their history and lane, but no new appointments
              </span>
            </span>
          </label>
        </div>

        {error ? (
          <p role="alert" className="mt-3 text-sm text-danger">
            {error}
          </p>
        ) : null}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 items-center rounded-md border border-line-strong px-3 text-sm transition-colors hover:bg-hover"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={pending}
            className="inline-flex h-9 items-center rounded-md bg-brand px-4 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {pending ? "Saving…" : member ? "Save" : "Add staff"}
          </button>
        </div>
      </div>
    </div>
  );
}

const INPUT =
  "w-full rounded-md border border-line-strong bg-transparent px-2.5 py-2 text-sm outline-none focus:border-brand";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-muted">{label}</span>
      {children}
    </label>
  );
}

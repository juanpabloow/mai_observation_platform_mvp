"use client";

import { useState, useTransition } from "react";
import { useTrappedPanel } from "@/components/ui/Overlay";
import { PanelSection } from "@/components/ui/primitives";
import { IconCalendar, IconIdentity, IconTask } from "@/components/ui/icons";
import {
  BTN_PRIMARY,
  BTN_SECONDARY,
  PANEL_CLOSE_CLS,
  PANEL_EDGE_LG,
  PANEL_SURFACE,
  PanelBanner,
  PanelCloseIcon,
} from "@/components/ui/panelChrome";
import { createStaffAction, updateStaffAction } from "@/lib/schedulingAdminActions";
import { gridFromWeekly, HoursGrid, weeklyFromGrid, type HourGrid } from "@/components/scheduling/HoursGrid";
import type { StaffServiceOpt, StaffSiteOpt } from "./StaffTab";

/**
 * ADD a barber — the name, the site, the services they can perform, and their hours.
 *
 * CREATE ONLY, and that is the whole design. A barber who EXISTS is changed in the tabs
 * of their own detail panel, where every field sits behind one unsaved bar. This drawer
 * exists for the one case that cannot work that way: a barber who does not exist yet has
 * no panel to be edited in. It was previously an edit form as well, which meant name,
 * services, hours and the two status flags had two owners — this drawer and the panel's
 * tabs — and whichever saved last won.
 *
 * THE GEOMETRY. It used to be a centred modal on a dark scrim floating over the middle of
 * the screen. It now opens in the panel column's own box: same top edge, same bottom edge,
 * same right edge, same width as the detail panel, so the roster simply grows a lane
 * instead of the whole window going dark.
 *
 * It writes through the SAME server actions the Scheduling settings form has always used
 * (`createStaffAction`, then `updateStaffAction` for the hours, which create does not
 * take), so client scoping, the owner/admin gate and the "service must belong to this
 * client" check are unchanged. Nothing new was invented at the data layer.
 *
 * The STATUS flags are absent on purpose: both are true for a new hire, so asking is
 * noise. They are edited afterwards in the panel's Details tab.
 *
 * TODO(staff): moving a barber between SITES is not an update the repo supports
 *   (site_id is set at creation and staff belong to exactly one site in V1), so the
 *   site field is read-only here.
 */
export function StaffCreateDrawer({
  clientId,
  siteId,
  services,
  sites,
  onClose,
  onSaved,
}: {
  clientId: string;
  siteId?: string;
  services: StaffServiceOpt[];
  sites: StaffSiteOpt[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [serviceIds, setServiceIds] = useState<string[]>([]);
  const [grid, setGrid] = useState<HourGrid>(gridFromWeekly({} as never));
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  // A FORM is exactly the case where the focus trap earns its keep — tabbing out of a
  // half-filled barber into the roster behind loses the operator's place invisibly. It
  // is active here at every width, unlike the read-only panel's, which only traps while
  // it covers the content.
  const panelRef = useTrappedPanel({ active: true, onClose });

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
      const target = siteId ?? sites[0]?.id;
      if (!target) {
        setError("This client has no site yet.");
        return;
      }
      // ONE call takes the name, the site and the service set...
      const r = await createStaffAction({ clientId, siteId: target, name: trimmed, serviceIds });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      // ...and the hours are a separate patch, because createStaffAction takes no schedule.
      const workingHours = weeklyFromGrid(grid);
      if (Object.keys(workingHours).length > 0 && r.id) {
        const h = await updateStaffAction(clientId, r.id, { workingHours });
        if (!h.ok) {
          setError(h.error);
          return;
        }
      }
      onSaved();
    });
  };

  const siteName = sites.find((s) => s.id === siteId)?.name ?? sites[0]?.name ?? "—";
  const activeServices = services.filter((s) => s.active);

  return (
    <>
      {/* A TRANSPARENT catcher, not a scrim, wherever the drawer has a lane of its own.
          The dark overlay is gone by design: the editor opens on exactly the box the
          detail panel occupied, so darkening the whole window to announce a panel that
          does not move was noise. What the layer still buys is worth keeping — a click
          outside dismisses, and a stray click on a roster row cannot navigate away from
          unsaved edits. Below `lg` the drawer genuinely COVERS the roster, and there the
          content underneath does have to visibly recede. */}
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="pointer-events-auto fixed inset-0 z-40 cursor-default bg-black/40 lg:bg-transparent"
      />
      <aside
        ref={panelRef as React.RefObject<HTMLElement>}
        role="dialog"
        aria-modal="true"
        aria-labelledby="staff-form-title"
        // FIXED while covering, ABSOLUTE once it has a lane — and the lane is the panel
        // column's own box, which is why the frame does not move when Edit is pressed.
        // FULL-BLEED below `lg` (no radius, no border — it is the whole screen there),
        // a card from `lg` up. pointer-events-auto because the region it renders into is
        // pointer-events-none while it spans the viewport.
        className={`u-panel-in pointer-events-auto fixed inset-y-0 right-0 z-50 w-full max-w-full lg:absolute lg:inset-y-0 lg:right-0 ${PANEL_SURFACE} ${PANEL_EDGE_LG}`}
      >
        {/* HEADER — the panel's header shape, minus the person: no tone wash and no avatar
            disc, because there is nobody yet to be the colour of. The quiet close and the
            two-line title/meta are the panel's own. */}
        <div className="flex shrink-0 items-start gap-2.5 border-b border-line px-4 pb-3 pt-3.5">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <h2 id="staff-form-title" className="truncate text-base font-semibold tracking-tight text-foreground">
              Add staff member
            </h2>
            <p className="truncate text-[0.6875rem] leading-4 text-faint">New barber at {siteName}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className={PANEL_CLOSE_CLS}>
            <PanelCloseIcon />
          </button>
        </div>

        {error ? (
          <div className="shrink-0 bg-surface px-4 pt-3">
            <PanelBanner tone="danger">{error}</PanelBanner>
          </div>
        ) : null}

        {/* THE only scrolling zone, and it adds no padding: each section brings its own
            and closes with a full-width rule, exactly as in the read-only panel. */}
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-surface">
          <PanelSection title="Identity" icon={<IconIdentity />}>
            <div className="flex flex-col gap-3.5">
              <Field label="Name" htmlFor="staff-name">
                <input
                  id="staff-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className={INPUT}
                  placeholder="Full name"
                />
              </Field>
              <Field label="Site" hint="fixed">
                <input
                  disabled
                  value={siteName}
                  readOnly
                  title="A barber belongs to one site in V1; moving them is not an update the repository supports"
                  className={`${INPUT} cursor-not-allowed opacity-60`}
                />
              </Field>
              {/* Everything else about a barber — role, contact details, skills,
                  certifications, and the two status flags — is edited in their panel once
                  they exist. Asking for it all up front is a wall; asking for none of it
                  makes the roster unusable, so this form takes only what create needs. */}
              <p className="text-[11px] text-faint">
                Role, contact details, hours changes, skills and certifications are edited in the
                barber&rsquo;s own panel afterwards.
              </p>
            </div>
          </PanelSection>

          <PanelSection
            title="Services"
            icon={<IconTask />}
            trailing={activeServices.length > 0 ? `${serviceIds.length} of ${activeServices.length}` : undefined}
          >
            {activeServices.length === 0 ? (
              <p className="text-sm text-faint">This client has no active services yet.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {activeServices.map((s) => {
                  const on = serviceIds.includes(s.id);
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => toggle(s.id)}
                      aria-pressed={on}
                      // rounded-md — the shape the contact form's selectable chips use.
                      // A full pill here would make a togglable service look like the
                      // read-only status chips in the panel's header.
                      className={`inline-flex h-8 items-center whitespace-nowrap rounded-md border px-2.5 text-xs transition-colors ${
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
          </PanelSection>

          <PanelSection title="Working hours" icon={<IconCalendar />}>
            <div className="flex flex-col gap-2">
              <p className="text-[11px] text-faint">All days off = inherit the site&rsquo;s opening hours.</p>
              <HoursGrid grid={grid} setGrid={setGrid} />
            </div>
          </PanelSection>

        </div>

        {/* THE SAVE BAR — always present, pinned. A form long enough to scroll (this one
            is) must never put its primary action below the fold. */}
        <div className="flex shrink-0 items-center gap-2 border-t border-line bg-surface px-4 py-3">
          <span className="min-w-0 flex-1 truncate text-xs text-muted">
            {name.trim() === "" ? "A name is required" : `New barber at ${siteName}`}
          </span>
          <button type="button" onClick={onClose} className={BTN_SECONDARY}>
            Cancel
          </button>
          <button type="button" onClick={save} disabled={pending || name.trim() === ""} className={BTN_PRIMARY}>
            {pending ? "Saving…" : "Add staff member"}
          </button>
        </div>
      </aside>
    </>
  );
}

const INPUT =
  "u-focus h-9 w-full rounded-md border border-line-strong bg-transparent px-2.5 text-sm transition-colors";

/** A labelled field. `hint` is the right-aligned marker the contact form uses. */
function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={htmlFor} className="text-xs font-medium text-muted">
          {label}
        </label>
        {hint ? <span className="text-[11px] text-faintest">{hint}</span> : null}
      </div>
      {children}
    </div>
  );
}

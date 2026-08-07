"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useState } from "react";
import type { ContactPanelData } from "@/lib/contactPanel";
import { ContactIdentitySummary } from "@/components/contacts/shared/ContactIdentitySummary";
import { AppointmentsSection } from "@/components/contacts/shared/AppointmentsSection";
import { TasksSection } from "@/components/contacts/shared/TasksSection";
import { NotesSection } from "@/components/contacts/shared/NotesSection";
import { TagsSection } from "@/components/contacts/shared/TagsSection";
import { ContactTimeline, type TimelineItemView } from "@/components/contacts/ContactTimeline";
import { ContactEditDialog } from "@/components/contacts/ContactEditDialog";
import type { FieldDefView } from "@/components/contacts/ContactProperties";

/**
 * The contacts list's CUSTOMER PANEL: pick a row, read the person, act — without
 * losing the list. It is assembled from the SAME shared sections as the full record
 * and the inbox panel (identity summary, appointments, tasks, notes, tags, timeline),
 * so there is no third implementation of "what a contact looks like".
 *
 * FOUR TABS, and each one is a real query the page already ran:
 *   Summary       — identity, next appointment, open tasks, tags
 *   Appointments  — the whole history, count on the tab
 *   Notes         — the notes list + composer
 *   Activity      — the unified timeline (crm_activity_events et al), which pages
 *                   itself through the existing keyset action
 *
 * Selection is the `?c=<contactId>` query param, mirroring the inbox's `?c=`: the row
 * is a plain Link, so deep links, Back and middle-click all keep working, and the
 * server re-renders the panel with fresh data on every selection.
 */

const TABS = ["summary", "appointments", "notes", "activity"] as const;
type Tab = (typeof TABS)[number];

export function ContactSidePanel({
  clientId,
  contactId,
  data,
  timelineItems,
  timelineCursor,
  viewerUserId,
  viewerIsFullAccess,
  schedulingEnabled,
  closeHref,
  recordHref,
  editInitial,
  fieldDefs,
  openEdit = false,
}: {
  clientId: string;
  contactId: string;
  data: ContactPanelData;
  timelineItems: TimelineItemView[];
  timelineCursor: string | null;
  viewerUserId: string;
  viewerIsFullAccess: boolean;
  schedulingEnabled: boolean;
  /** The list URL with `?c=` dropped — the ✕ is a Link, not a history hack. */
  closeHref: string;
  recordHref: string;
  /** The editable columns as they stand, for the one-shot edit dialog. */
  editInitial: { name: string | null; email: string | null; phone: string | null; customFields: Record<string, unknown> };
  /** The CLIENT's own field definitions — Instagram/Facebook when defined. */
  fieldDefs: FieldDefView[];
  /** Open with the edit dialog already up (the row's "+ Add email" link). */
  openEdit?: boolean;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("summary");
  const [editing, setEditing] = useState(openEdit);
  // Every section writes through its own server action; refreshing re-runs the page's
  // loaders so derived values (counts, "next appointment") can't drift from the list.
  const onChanged = () => router.refresh();

  const apptCount = data.appointments.upcoming.length + data.appointments.past.length;

  return (
    <aside
      aria-label="Customer details"
      // Its OWN floating card on the recessed body, beside the table's — not a column
      // butted against it. The two are separated by the ground showing between them.
      className="hidden w-[360px] shrink-0 flex-col overflow-hidden rounded-xl border border-line-strong bg-surface xl:flex 2xl:w-[392px]"
    >
      <div className="flex h-[var(--topbar-height)] shrink-0 items-center justify-between border-b border-line px-3">
        <h2 className="text-sm font-semibold">Customer details</h2>
        <Link
          href={closeHref}
          scroll={false}
          aria-label="Close customer details"
          className="inline-flex size-8 items-center justify-center rounded-md border border-line-strong text-xs text-muted transition-colors hover:bg-hover hover:text-foreground"
        >
          &#10005;
        </Link>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* ONLY the identity block is tinted — it is the "who is this" band. The tabs
            and everything under them stay on the surface, so the panel reads as one
            card with a header rather than as a grey column. */}
        <div className="border-b border-line bg-panel-hero px-4 pb-4 pt-5">
        <ContactIdentitySummary
          summary={data.summary}
          identities={data.identities}
          dense
          centered
          action={
            <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
              {schedulingEnabled ? (
                <Link
                  href={`/clients/${clientId}/scheduling/agenda?book=${contactId}`}
                  className="inline-flex h-9 items-center rounded-md bg-brand px-3 text-sm font-medium text-white transition-opacity hover:opacity-90"
                >
                  Book appointment
                </Link>
              ) : null}
              <Link
                href={recordHref}
                className="inline-flex h-9 items-center rounded-md border border-line-strong bg-surface px-3 text-sm transition-colors hover:bg-hover"
              >
                Open record
              </Link>
              {/* One real action behind the control, spelled out: a "…" that does
                  exactly one thing is a worse affordance than the word for it. */}
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="inline-flex h-9 items-center rounded-md border border-line-strong bg-surface px-3 text-sm transition-colors hover:bg-hover"
              >
                Edit
              </button>
            </div>
          }
        />
        </div>

        {/* The tab strip is a real segmented control, not links: switching tabs must
            not re-run the page's queries — everything the four tabs show was already
            loaded with the panel. */}
        <div className="flex items-center gap-4 border-b border-line px-4" role="tablist">
          {TABS.map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={`-mb-px border-b-2 pb-2.5 pt-3 text-[0.8125rem] font-medium capitalize transition-colors ${
                tab === t
                  ? "border-brand text-foreground"
                  : "border-transparent text-muted hover:text-foreground"
              }`}
            >
              {t}
              {t === "appointments" && apptCount > 0 ? (
                <span className="u-mono ml-1 text-[0.625rem] text-faint">{apptCount}</span>
              ) : null}
            </button>
          ))}
        </div>

        <div className="px-4 py-4">
          {tab === "summary" ? (
            <div className="flex flex-col gap-4">
              <section className="flex flex-col gap-2">
                <div className="flex items-baseline justify-between gap-2">
                  <p className="u-th">Next appointment</p>
                  <span className="u-mono text-[0.625rem] text-faint">{apptCount} total</span>
                </div>
                <AppointmentsSection
                  clientId={clientId}
                  appointments={data.appointments}
                  onChanged={onChanged}
                  showHistory={false}
                />
              </section>

              <section className="flex flex-col gap-2 border-t border-line pt-3">
                <p className="u-th">Open tasks</p>
                <TasksSection
                  clientId={clientId}
                  contactId={contactId}
                  tasks={data.openTasks}
                  assignableMembers={[]}
                  viewerUserId={viewerUserId}
                  viewerIsFullAccess={viewerIsFullAccess}
                  onChanged={onChanged}
                />
              </section>

              <section className="flex flex-col gap-2 border-t border-line pt-3">
                <p className="u-th">Tags</p>
                <TagsSection
                  clientId={clientId}
                  contactId={contactId}
                  tags={data.tags}
                  catalogue={[]}
                  canManageCatalog={viewerIsFullAccess}
                  onChanged={onChanged}
                />
              </section>
            </div>
          ) : null}

          {tab === "appointments" ? (
            <AppointmentsSection
              clientId={clientId}
              appointments={data.appointments}
              onChanged={onChanged}
              showHistory
            />
          ) : null}

          {tab === "notes" ? (
            <NotesSection
              clientId={clientId}
              contactId={contactId}
              notes={data.recentNotes}
              viewerUserId={viewerUserId}
              viewerIsFullAccess={viewerIsFullAccess}
              onChanged={onChanged}
              dense
            />
          ) : null}

          {tab === "activity" ? (
            <ContactTimeline
              clientId={clientId}
              contactId={contactId}
              initialItems={timelineItems}
              initialCursor={timelineCursor}
            />
          ) : null}
        </div>
      </div>

      {editing ? (
        <ContactEditDialog
          clientId={clientId}
          contactId={contactId}
          initial={editInitial}
          fieldDefs={fieldDefs}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            onChanged();
          }}
        />
      ) : null}
    </aside>
  );
}

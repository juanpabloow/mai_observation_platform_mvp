"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useMemo, useState } from "react";
import type { ContactPanelData } from "@/lib/contactPanel";
import { AppointmentsSection } from "@/components/contacts/shared/AppointmentsSection";
import { TasksSection } from "@/components/contacts/shared/TasksSection";
import { NotesSection } from "@/components/contacts/shared/NotesSection";
import { TagsSection } from "@/components/contacts/shared/TagsSection";
import { ContactTimeline, type TimelineItemView } from "@/components/contacts/ContactTimeline";
import { ContactEditForm } from "@/components/contacts/form/ContactEditForm";
import type { ContactEditPayload } from "@/lib/contactPanel";
import { CRM_COPY } from "@/lib/contactLabels";
import { FormSection, IconCalendar, IconInternal, IconPencil, IconTask } from "@/components/contacts/form/formPrimitives";
import { ContactSections } from "@/components/contacts/form/ContactSections";
import {
  CONTACT_PANEL_FRAME,
  CONTACT_PANEL_REGION,
  CONTACT_PANEL_WIDTH,
  ContactPanelHeader,
  ContactPanelShell,
  PANEL_CLOSE_CLS,
  PanelCloseIcon,
} from "@/components/contacts/shared/ContactPanelShell";
import { contactToneVar, type ContactHeaderFacts, type ContactMetricFacts } from "@/components/contacts/shared/ContactHeaderBlock";

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

const TABS = ["summary", "data", "appointments", "notes", "activity"] as const;
type Tab = (typeof TABS)[number];
/** Label per tab. The KEY stays English — it is state, not copy. */
const TAB_LABEL: Record<Tab, string> = {
  summary: CRM_COPY.tabs.summary,
  data: CRM_COPY.tabs.data,
  appointments: CRM_COPY.tabs.appointments,
  notes: CRM_COPY.tabs.notes,
  activity: CRM_COPY.tabs.activity,
};

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
  edit,
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
  /**
   * The whole-contact edit payload, built server-side by loadContactEditPayload — the
   * SAME loader the record header uses. Null when the viewer's client scope couldn't
   * resolve the contact, in which case the Edit button is simply not offered.
   *
   * This replaced a four-field snapshot (name, ONE email, ONE phone, custom fields)
   * that fed a small modal. That modal is gone: it could not see a contact's second
   * address, so saving it silently overwrote whichever one it happened to hold, and it
   * bypassed the "at least one identity" rule, the duplicate check and E.164
   * normalisation — a back door for exactly the duplicates the identity spine exists
   * to prevent.
   */
  edit: ContactEditPayload | null;
  /** Open with the edit drawer already up (the row's "+ Add email" / "+ Add number"). */
  openEdit?: boolean;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("summary");
  // `?edit=1` (the row's "+ Add email" / "+ Add number") opens straight into the drawer.
  const [editing, setEditing] = useState(openEdit && edit !== null);
  // Every section writes through its own server action; refreshing re-runs the page's
  // loaders so derived values (counts, "next appointment") can't drift from the list.
  const onChanged = () => router.refresh();

  const apptCount = data.appointments.upcoming.length + data.appointments.past.length;

  // Header facts come from the SAME payload the drawer opens with, so the quick view
  // and the editor cannot introduce the same person with different numbers — the
  // activity total in particular is one derivation, in one loader.
  const headerFacts: ContactHeaderFacts = {
    displayName: data.summary.displayName,
    primaryIdentity: data.identities[0]?.value ?? null,
    stage: data.summary.stage,
    isCustomer: data.summary.isCustomer,
    consent: data.summary.consent,
    createdAt: edit?.initial.createdAt ?? new Date().toISOString(),
    activityCount: edit?.initial.activityCount ?? 0,
  };
  // Null only when the contact could not be re-resolved under this client, in which
  // case the panel offers no editing either — see `edit`.
  const metricFacts: ContactMetricFacts | null = edit
    ? {
        activityCount: edit.initial.activityCount,
        lastContactAt: edit.initial.lastContactAt,
        sourceChannel: edit.initial.sourceChannel,
      }
    : null;
  // One clock for every relative age in the header.
  const now = useMemo(() => new Date(), []);

  return (
    // THE PANEL REGION. The quick view sits in flow inside it and the edit drawer
    // overlays it absolutely, so both occupy the identical box — same top, same
    // bottom, same right edge, same width. Pressing "Editar" swaps the contents
    // without moving the frame.
    <div className={`hidden shrink-0 self-stretch xl:flex ${CONTACT_PANEL_REGION}`} style={{ width: CONTACT_PANEL_WIDTH }}>
      <aside
        aria-label="Detalles del contacto"
        // A card that lives BESIDE the table — no scrim, nothing dimmed. min-h-0 +
        // flex-1 so its height comes from the ROW, not from the active tab: switching
        // tabs never resizes it. The shared frame's overflow-hidden keeps the body's
        // scrollbar inside the rounded corners instead of cutting the border.
        className={`min-h-0 flex-1 ${CONTACT_PANEL_FRAME}`}
      >
      <ContactPanelShell
        scrollResetKey={tab}
        headerTone={contactToneVar(headerFacts)}
        header={
          <ContactPanelHeader
            now={now}
            facts={headerFacts}
            metrics={metricFacts}
            closeAction={
              <Link
                href={closeHref}
                scroll={false}
                aria-label="Cerrar detalles del contacto"
                className={PANEL_CLOSE_CLS}
              >
                <PanelCloseIcon />
              </Link>
            }
            extra={
              /* The actions stay in the HEADER: a view that saves nothing has no footer
                 bar to put them in, and moving them down would imply one. */
              // The primary action TAKES the leftover width and the two secondaries size
              // to their labels — the reference's proportion, which makes the one thing
              // you most often do here unmissable.
              <div className="flex items-center gap-1.5">
                {schedulingEnabled ? (
                  <Link
                    href={`/clients/${clientId}/scheduling/agenda?book=${contactId}`}
                    className="inline-flex h-9 min-w-0 flex-1 items-center justify-center whitespace-nowrap rounded-lg bg-brand px-3 text-xs font-medium text-white transition-opacity hover:opacity-90"
                  >
                    {CRM_COPY.actions.book}
                  </Link>
                ) : null}
                <Link
                  href={recordHref}
                  className="inline-flex h-9 shrink-0 items-center whitespace-nowrap rounded-lg border border-line-strong bg-surface px-3 text-xs transition-colors hover:bg-hover"
                >
                  {CRM_COPY.actions.openRecord}
                </Link>
                {edit ? (
                  <button
                    type="button"
                    onClick={() => setEditing(true)}
                    className="inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border border-line-strong bg-surface px-3 text-xs transition-colors hover:bg-hover"
                  >
                    <IconPencil />
                    {CRM_COPY.actions.edit}
                  </button>
                ) : null}
              </div>
            }
          />
        }
        subheader={
          /* The tab strip is a real segmented control, not links: switching tabs must
             not re-run the page's queries — everything the four tabs show was already
             loaded with the panel. */
          <div className="flex items-center gap-4 border-b border-line px-4" role="tablist">
            {TABS.map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={`-mb-px whitespace-nowrap border-b-2 pb-2.5 pt-3 text-[0.8125rem] font-medium transition-colors ${
                  tab === t
                    ? "border-brand text-foreground"
                    : "border-transparent text-muted hover:text-foreground"
                }`}
              >
                {TAB_LABEL[t]}
                {t === "appointments" && apptCount > 0 ? (
                  <span className="u-mono ml-1 text-[0.625rem] text-faint">{apptCount}</span>
                ) : null}
              </button>
            ))}
          </div>
        }
      >
          {tab === "summary" ? (
            <div className="flex flex-col gap-3">
              <FormSection
                title={CRM_COPY.headings.nextAppointment}
                icon={<IconCalendar />}
                trailing={<span className="u-mono">{CRM_COPY.totalCount(apptCount)}</span>}
              >
                <AppointmentsSection
                  clientId={clientId}
                  appointments={data.appointments}
                  onChanged={onChanged}
                  showHistory={false}
                />
              </FormSection>

              <FormSection title={CRM_COPY.headings.openTasks} icon={<IconTask />}>
                <TasksSection
                  clientId={clientId}
                  contactId={contactId}
                  tasks={data.openTasks}
                  assignableMembers={[]}
                  viewerUserId={viewerUserId}
                  viewerIsFullAccess={viewerIsFullAccess}
                  onChanged={onChanged}
                />
              </FormSection>

              <FormSection title={CRM_COPY.headings.tags} icon={<IconInternal />}>
                <TagsSection
                  clientId={clientId}
                  contactId={contactId}
                  tags={data.tags}
                  catalogue={[]}
                  canManageCatalog={viewerIsFullAccess}
                  onChanged={onChanged}
                />
              </FormSection>
            </div>
          ) : null}

          {/* DATOS — the contact's fields, READ-ONLY. It exists because the only fast way
              to check an owner, a consent or a "no contactar" used to be opening the
              EDITOR, which is the read-through-an-editing-surface pattern the record
              page already dropped. Same component the record renders, same payload the
              panel already loaded for the Editar button: no new query, no second
              definition of what a contact consists of. */}
          {tab === "data" ? (
            edit ? (
              <ContactSections
                mode="read"
                clientId={clientId}
                fieldDefs={edit.fieldDefs}
                read={{
                  name: edit.initial.name,
                  phones: edit.initial.phones,
                  emails: edit.initial.emails,
                  ownerLabel: edit.owners.find((o) => o.userId === edit.initial.assignedTo)?.label ?? null,
                  stage: edit.initial.stage,
                  preferredChannel: edit.initial.preferredChannel,
                  doNotContact: edit.initial.doNotContact,
                  consent: edit.initial.consent,
                  consentUpdatedAt: edit.initial.consentUpdatedAt,
                  consentSource: edit.initial.consentSource,
                  customFields: edit.initial.customFields,
                  tags: edit.tags,
                }}
              />
            ) : null
          ) : null}

          {tab === "appointments" ? (
            <FormSection title={CRM_COPY.headings.appointments} icon={<IconCalendar />}>
              <AppointmentsSection clientId={clientId} appointments={data.appointments} onChanged={onChanged} showHistory />
            </FormSection>
          ) : null}

          {tab === "notes" ? (
            <FormSection title={CRM_COPY.headings.notes} icon={<IconInternal />}>
              <NotesSection
                clientId={clientId}
                contactId={contactId}
                notes={data.recentNotes}
                viewerUserId={viewerUserId}
                viewerIsFullAccess={viewerIsFullAccess}
                onChanged={onChanged}
                dense
              />
            </FormSection>
          ) : null}

          {tab === "activity" ? (
            <div className="p-4">
              <ContactTimeline
                clientId={clientId}
                contactId={contactId}
                initialItems={timelineItems}
                initialCursor={timelineCursor}
              />
            </div>
          ) : null}
      </ContactPanelShell>

      </aside>

      {/* The SAME drawer the record header opens — one editor, one set of rules. It
          renders INTO this region, so it lands exactly on the quick view. */}
      {editing && edit ? (
        <ContactEditForm
          clientId={clientId}
          initial={edit.initial}
          owners={edit.owners}
          fieldDefs={edit.fieldDefs}
          tags={edit.tags}
          tagCatalogue={edit.tagCatalogue}
          notes={edit.notes}
          canDelete={edit.canDelete}
          canManageTagCatalog={edit.canManageTagCatalog}
          onClose={() => setEditing(false)}
        />
      ) : null}
    </div>
  );
}

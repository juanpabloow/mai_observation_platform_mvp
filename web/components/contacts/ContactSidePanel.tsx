"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useMemo, useState, type RefObject } from "react";
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
import { BOOK_CLS } from "@/components/ui/primitives";
import { IconPlus } from "@/components/ui/icons";
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
import { contactToneStyle, type ContactHeaderFacts, type ContactMetricFacts } from "@/components/contacts/shared/ContactHeaderBlock";
import { OVERLAY_SCRIM, useIsOverlayWidth, useTrappedPanel } from "@/components/ui/Overlay";

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

/*
 * FOUR TABS. The design draws three — Resumen / Citas / Notas (§2.5) — and folds what
 * used to be a separate `Datos` tab into Resumen, which is right: "the contact's fields"
 * and "a summary of this contact" were never two different questions, and splitting them
 * meant checking an owner or a consent took two clicks from a panel that had room for
 * neither tab.
 *
 * `activity` survives as a fourth. The artboard simply does not draw it, which is not the
 * same as removing it: the unified timeline is real content with its own keyset pager,
 * and it does not fit inside Resumen the way the field list does.
 */
const TABS = ["summary", "appointments", "notes", "activity"] as const;
type Tab = (typeof TABS)[number];
/** Label per tab. The KEY stays English — it is state, not copy. */
const TAB_LABEL: Record<Tab, string> = {
  summary: CRM_COPY.tabs.summary,
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

  // Below xl the panel COVERS the table, so it is an overlay (a right sheet over a scrim),
  // not a beside-table column — otherwise a click below 1280px selected the row but
  // rendered NOTHING (the redesign bug). Esc and the scrim close it by navigating to
  // closeHref, since the selection lives in ?c=. At xl+ it is the in-flow card and the
  // focus trap stays OFF, so the rest of the screen is reachable by keyboard.
  const overlaying = useIsOverlayWidth(1279.98);
  const panelRef = useTrappedPanel({ active: overlaying, onClose: () => router.push(closeHref, { scroll: false }) });

  return (
    <>
      {/* The scrim to close against when the panel COVERS the table (below xl). A Link,
          not a button, because closing is a navigation — the selection lives in ?c=.
          display:none at xl+, where the panel is a column beside the list, not over it. */}
      <Link
        href={closeHref}
        scroll={false}
        aria-label="Cerrar detalles del contacto"
        className={`${OVERLAY_SCRIM} xl:hidden`}
      />
      {/* POSITIONING LAYER: a fixed right-side overlay below xl; `xl:contents` makes this
          wrapper vanish at xl+, so the region drops straight into the table row and the
          desktop layout is byte-identical to the beside-card it has always been. This is
          what a row click produces at EVERY width now — a sheet below xl, the column above
          it — instead of a selected row and no visible panel. */}
      <div className="fixed inset-y-0 right-0 z-50 flex xl:contents">
        {/* THE PANEL REGION. The quick view sits in flow inside it and the edit drawer
            overlays it absolutely, so both occupy the identical box — same top, same
            bottom, same right edge, same width. Pressing "Editar" swaps the contents
            without moving the frame. (Was `hidden xl:flex` — the bug; now always `flex`,
            with the layer above deciding overlay vs column.) */}
        <div className={`flex max-w-[90vw] shrink-0 self-stretch ${CONTACT_PANEL_REGION}`} style={{ width: CONTACT_PANEL_WIDTH }}>
      <aside
        ref={panelRef as RefObject<HTMLElement>}
        aria-label="Detalles del contacto"
        // A card that lives BESIDE the table at xl+ — no scrim, nothing dimmed; a dialog
        // with a focus trap below xl, where it covers the table. min-h-0 + flex-1 so its
        // height comes from the ROW, not from the active tab: switching tabs never resizes
        // it. The shared frame's overflow-hidden keeps the body's scrollbar inside the
        // rounded corners instead of cutting the border.
        role={overlaying ? "dialog" : undefined}
        aria-modal={overlaying || undefined}
        tabIndex={-1}
        className={`min-h-0 flex-1 ${CONTACT_PANEL_FRAME}`}
      >
      <ContactPanelShell
        scrollResetKey={tab}
        headerToneStyle={contactToneStyle(headerFacts)}
        header={
          <ContactPanelHeader
            now={now}
            facts={headerFacts}
            metrics={metricFacts}
            /*
              THE ACTION ROW IS GONE, and that is the design's point (§2.5).
              It was three same-sized buttons stacked under the metrics: a red primary,
              "Abrir ficha", and "Editar". The redesign redistributes them by weight —
              `Agendar cita` is the one thing you do here, so it moves to the TAB ROW
              where it is always visible whichever tab is open; "Ficha ↗" is a
              navigation, so it becomes a quiet link on the name line; and editing is a
              28px pencil glyph beside the close, because it is a mode switch on this
              panel rather than an action on the customer.
              What this buys back is the ~44px band of chrome that used to sit between
              the person's name and their actual content.
            */
            recordAction={
              <Link
                href={recordHref}
                className="shrink-0 text-[0.71875rem] text-brand no-underline hover:underline"
              >
                Ficha ↗
              </Link>
            }
            closeAction={
              <>
                {edit ? (
                  <button
                    type="button"
                    onClick={() => setEditing(true)}
                    aria-label={CRM_COPY.actions.edit}
                    title={CRM_COPY.actions.edit}
                    className={PANEL_CLOSE_CLS}
                  >
                    <IconPencil />
                  </button>
                ) : null}
                <Link
                  href={closeHref}
                  scroll={false}
                  aria-label="Cerrar detalles del contacto"
                  className={PANEL_CLOSE_CLS}
                >
                  <PanelCloseIcon />
                </Link>
              </>
            }
          />
        }
        subheader={
          /* The tab strip is a real segmented control, not links: switching tabs must
             not re-run the page's queries — everything the four tabs show was already
             loaded with the panel. */
          <div className="flex items-center gap-4 border-b border-line-soft px-4">
            <div className="flex min-w-0 items-center gap-4 overflow-x-auto" role="tablist">
              {TABS.map((t) => (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  aria-selected={tab === t}
                  onClick={() => setTab(t)}
                  // The active indicator is INK, not brand. There is exactly one red thing
                  // in this panel and it is `Agendar cita`, two inches to the right; a red
                  // underline as well made the tab row compete with the action.
                  className={`-mb-px shrink-0 whitespace-nowrap border-b-2 pb-2.5 pt-3 text-[0.78125rem] transition-colors ${
                    tab === t
                      ? "border-ink font-semibold text-foreground"
                      : "border-transparent text-muted hover:text-foreground"
                  }`}
                >
                  {TAB_LABEL[t]}
                  {t === "appointments" && apptCount > 0 ? (
                    <span className="u-mono ml-1 text-[0.625rem] text-faint">{apptCount}</span>
                  ) : null}
                  {t === "notes" && data.recentNotes.length > 0 ? (
                    <span className="u-mono ml-1 text-[0.625rem] text-faint">{data.recentNotes.length}</span>
                  ) : null}
                </button>
              ))}
            </div>
            {/* THE one primary action, on the tab row — so it is reachable from every tab
                without the panel spending a whole row on chrome. */}
            {schedulingEnabled ? (
              <Link
                href={`/clients/${clientId}/scheduling/agenda?book=${contactId}`}
                className={`ml-auto my-1.5 ${BOOK_CLS}`}
              >
                <IconPlus />
                {CRM_COPY.actions.book}
              </Link>
            ) : null}
          </div>
        }
      >
          {tab === "summary" ? (
            <div className="flex flex-col">
              {/* THE FACTS, first — Contacto / Asignación / Mensajería / Etiquetas, in
                  the design's order. Same component the record page renders in read
                  mode, from the payload the panel already loaded for the Editar button:
                  no new query, and no second definition of what a contact consists of. */}
              {edit ? (
                <ContactSections
                  mode="read"
                  // ONE column. The panel is 380px and a fact row spends 6.5rem of it on
                  // the label; two columns leave ~70px for the value, which truncates a
                  // phone number.
                  columns={1}
                  clientId={clientId}
                  fieldDefs={edit.fieldDefs}
                  read={{
                    name: edit.initial.name,
                    phones: edit.initial.phones,
                    emails: edit.initial.emails,
                    ownerLabel:
                      edit.owners.find((o) => o.userId === edit.initial.assignedTo)?.label ?? null,
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
              ) : null}

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
      </div>
    </>
  );
}

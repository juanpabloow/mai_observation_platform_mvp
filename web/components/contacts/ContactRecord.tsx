"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { BOOK_CLS, Chip, StageChip } from "@/components/ui/primitives";
import { IconPlus } from "@/components/ui/icons";
import { ContactAvatar } from "./ContactAvatar";
import {
  ContactPreferencesCard,
  ContactValueCard,
  type ContactValueProfileView,
} from "./ContactValueCard";
import { relativeAgeShort } from "@/lib/format";
import { consentLabel, sourceLabel } from "@/lib/contactLabels";
import type { AppointmentSummary, ContactSummary, IdentityView, MemberOption, TagView, TaskView } from "@/lib/contactShared";
import { ContactProperties, type FieldDefView } from "./ContactProperties";
import type { ContactReadValues } from "./form/ContactSections";
import { ContactTimeline, type TimelineItemView } from "./ContactTimeline";
import { ContactAssociations } from "./ContactAssociations";
import type { CandidateView } from "./DuplicateBanner";
import { EditContactButton } from "./form/EditContactButton";
import type { ContactEditPayload } from "@/lib/contactPanel";

/**
 * The unified contact RECORD (C-4) — a three-region layout that replaces the deleted
 * tab set (Data | Conversations | Appointments | Activity), whose fragmentation was the
 * problem this phase exists to fix. LEFT: identity + properties. CENTER: the unified
 * timeline (the reason the page exists). RIGHT: associations + actions.
 *
 * At wide viewports it's three columns; below that everything stacks in the order
 * identity → timeline → rail. Writes flow through the shared sections; onChanged =
 * router.refresh() re-pulls the server data so derived badges/lists stay accurate (the
 * timeline manages its own keyset paging independently).
 */
export interface ContactRecordProps {
  clientId: string;
  contactId: string;
  summary: ContactSummary;
  identities: IdentityView[];
  candidates: CandidateView[];
  canManageDuplicates: boolean;
  canEditFieldDefs: boolean;
  canManageTags: boolean;
  /** The contact's properties for READ mode — the same field set the drawer edits. */
  properties: ContactReadValues;
  /** Origin channel + creation date: record-only facts, shown in the header. */
  source: string;
  createdAt: string;
  members: MemberOption[];
  /** Resolved owner display name — a record-header fact. */
  ownerName: string | null;
  fieldDefs: FieldDefView[];
  timelineItems: TimelineItemView[];
  timelineCursor: string | null;
  appointments: AppointmentSummary;
  openTasks: TaskView[];
  tags: TagView[];
  tagCatalogue: TagView[];
  viewerUserId: string;
  viewerIsFullAccess: boolean;
  mostRecentConversationId: string | null;
  schedulingEnabled: boolean;
  /**
   * Everything the whole-contact edit drawer needs, from loadContactEditPayload — the
   * SAME loader the list's customer panel uses, so the two doors into editing show one
   * contact, not two versions of one. Null only if the contact couldn't be re-resolved
   * under this client, in which case no Edit button is offered.
   *
   * The record still edits field by field in the left column; this is the "change
   * several things at once" door.
   */
  edit: ContactEditPayload | null;
  /**
   * Derived commercial facts for the "Valor del cliente" + "Preferencias" cards. Null for
   * a contact with no completed visit — those cards render their own empty state.
   */
  valueProfile: ContactValueProfileView | null;
  /** The last COMPLETED visit, for the header's meta line. */
  lastVisitAt: string | null;
}

export function ContactRecord(props: ContactRecordProps) {
  const router = useRouter();
  const onChanged = () => router.refresh();

  return (
    <div className="flex flex-col gap-4">
      <ContactRecordHeader
        clientId={props.clientId}
        contactId={props.contactId}
        summary={props.summary}
        identities={props.identities}
        source={props.source}
        lastVisitAt={props.lastVisitAt}
        mostRecentConversationId={props.mostRecentConversationId}
        schedulingEnabled={props.schedulingEnabled}
        edit={props.edit}
      />

      {/*
        `items-stretch` (was `items-start`): the three columns are as tall as the tallest,
        so the left card's white continues to the bottom of the row instead of stopping at
        its last field and leaving a slab of canvas under it.

        THIS COST THE STICKY LEFT COLUMN, and that is a real trade rather than a free win.
        It used to be `xl:sticky xl:top-4`, so the contact's facts stayed on screen while
        you scrolled a long timeline. An element that fills its row has nowhere to stick —
        the two behaviours are mutually exclusive at this layout. Filling won because the
        gap was visible on every record and the sticky only paid off on the long ones.
      */}
      <div className="flex flex-col gap-4 xl:grid xl:grid-cols-[300px_minmax(0,1fr)_340px] xl:items-stretch">
        <div className="flex min-w-0 flex-col">
          <ContactProperties
            clientId={props.clientId}
            contactId={props.contactId}
            candidates={props.candidates}
            canManageDuplicates={props.canManageDuplicates}
            values={props.properties}
            fieldDefs={props.fieldDefs}
            onChanged={onChanged}
          />
        </div>

      <ContactTimeline
        clientId={props.clientId}
        contactId={props.contactId}
        initialItems={props.timelineItems}
        initialCursor={props.timelineCursor}
      />

      <div className="flex min-w-0 flex-col gap-3">
        <ContactValueCard
          profile={props.valueProfile}
          ownerName={props.ownerName}
          // Assignment lives in the edit drawer, so "Cambiar" is a link into it rather
          // than a second place that writes the owner.
          changeOwnerHref={props.edit ? `?edit=1` : undefined}
        />
        <ContactPreferencesCard profile={props.valueProfile} />
        <ContactAssociations
          clientId={props.clientId}
          contactId={props.contactId}
          appointments={props.appointments}
          openTasks={props.openTasks}
          tags={props.tags}
          tagCatalogue={props.tagCatalogue}
          assignableMembers={props.members}
          viewerUserId={props.viewerUserId}
          viewerIsFullAccess={props.viewerIsFullAccess}
          canManageTags={props.canManageTags}
          mostRecentConversationId={props.mostRecentConversationId}
          schedulingEnabled={props.schedulingEnabled}
          onChanged={onChanged}
        />
      </div>
      </div>
    </div>
  );
}

/**
 * The record's HEADER (artboard 23a): the identity disc, the name, and ONE meta line of
 * the facts an operator needs before acting — then the actions, right.
 *
 * IT USED TO BE THREE LINES: name+chips, a "contacto desde · N actividades" line, and a
 * `<dl>` of Origen / Dueño / Visitas / No-shows. The design collapses the last two into a
 * single dot-separated run, which fits because none of those facts needs a label: a phone
 * number, "Origen WhatsApp" and "14 visitas" all say what they are. That bought back ~40px
 * of chrome above the content, and the DUEÑO moved to the value card, where it sits beside
 * the money it is responsible for.
 */
function ContactRecordHeader({
  clientId,
  contactId,
  summary,
  identities,
  source,
  lastVisitAt,
  mostRecentConversationId,
  schedulingEnabled,
  edit,
}: {
  clientId: string;
  contactId: string;
  summary: ContactSummary;
  identities: IdentityView[];
  source: string;
  lastVisitAt: string | null;
  mostRecentConversationId: string | null;
  schedulingEnabled: boolean;
  edit: ContactRecordProps["edit"];
}) {
  const action =
    "inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border border-line-strong bg-surface px-3 text-xs text-muted transition-colors hover:border-faint hover:text-foreground";
  const primaryIdentity = identities[0]?.value ?? null;
  // ONE dot-separated run. Each fact is omitted rather than shown empty: "· 0 no-shows"
  // on somebody who has never missed one is noise, and "· última —" is worse than absent.
  const facts: string[] = [];
  if (source) facts.push(`Origen ${sourceLabel(source)}`);
  if (summary.visitCount > 0) {
    facts.push(`${summary.visitCount} ${summary.visitCount === 1 ? "visita" : "visitas"}`);
  }
  if (summary.noShowCount > 0) facts.push(`${summary.noShowCount} no-show`);
  if (lastVisitAt) facts.push(`última ${relativeAgeShort(lastVisitAt)}`);

  return (
    <header className="flex flex-wrap items-center gap-x-3.5 gap-y-3 rounded-xl border border-line bg-surface px-4 py-3.5 shadow-[var(--shadow-card)]">
      <ContactAvatar
        name={summary.displayName}
        fallback={primaryIdentity ?? summary.displayName}
        size={40}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h1 className="truncate text-[1.1875rem] font-semibold tracking-[-0.02em] text-foreground">
            {summary.displayName}
          </h1>
          <StageChip stage={summary.stage} />
          {summary.isCustomer ? <Chip tone="muted">cliente</Chip> : null}
          {/* Consent surfaces ONLY when opted out — quiet, informational, not an error. */}
          {summary.consent === "opted_out" ? (
            <Chip tone="warn" title="Este contacto rechazó recibir mensajes">
              {consentLabel("opted_out").toLowerCase()}
            </Chip>
          ) : null}
        </div>
        <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[0.78125rem] text-muted">
          {primaryIdentity ? (
            <span className="u-mono whitespace-nowrap text-foreground">{primaryIdentity}</span>
          ) : null}
          {facts.map((f) => (
            <span key={f} className="flex items-center gap-2 whitespace-nowrap">
              <span aria-hidden className="text-faintest">
                ·
              </span>
              {f}
            </span>
          ))}
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        {edit ? (
          <EditContactButton
            clientId={clientId}
            initial={edit.initial}
            owners={edit.owners}
            fieldDefs={edit.fieldDefs}
            tags={edit.tags}
            tagCatalogue={edit.tagCatalogue}
            notes={edit.notes}
            canDelete={edit.canDelete}
            canManageTagCatalog={edit.canManageTagCatalog}
            className={action}
          />
        ) : null}
        {mostRecentConversationId ? (
          <Link href={`/clients/${clientId}/inbox?c=${encodeURIComponent(mostRecentConversationId)}`} className={action}>
            Ver conversación ↗
          </Link>
        ) : null}
        {/*
          THE ARTBOARD ALSO HAS "Marcar VIP →". Left out: it is a one-click shortcut for
          applying one specific tag, and which tag a shop treats as "VIP" is that shop's
          decision, not the product's — the client's tag catalogue is per-client and may
          not contain a VIP tag at all. Tagging already lives in the rail, one click away,
          and works for every tag rather than for one hard-coded name.
        */}
        {schedulingEnabled ? (
          <Link
            href={`/clients/${clientId}/scheduling/agenda?book=${encodeURIComponent(contactId)}&return=${encodeURIComponent(contactId)}`}
            className={BOOK_CLS}
          >
            <IconPlus />
            Agendar cita
          </Link>
        ) : null}
      </div>
    </header>
  );
}

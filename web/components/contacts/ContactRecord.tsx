"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Chip, StageChip } from "@/components/ui/primitives";
import type { AppointmentSummary, ContactSummary, IdentityView, MemberOption, TagView, TaskView } from "@/lib/contactShared";
import { ContactProperties, type FieldDefView } from "./ContactProperties";
import { ContactTimeline, type TimelineItemView } from "./ContactTimeline";
import { ContactAssociations } from "./ContactAssociations";
import type { CandidateView } from "./DuplicateBanner";

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
  properties: {
    name: string | null;
    stage: string;
    assignedTo: string | null;
    consent: string;
    consentSource: string | null;
    source: string;
    createdAt: string;
    customFields: Record<string, unknown>;
  };
  members: MemberOption[];
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
        source={props.properties.source}
        ownerName={props.ownerName}
        mostRecentConversationId={props.mostRecentConversationId}
        schedulingEnabled={props.schedulingEnabled}
      />

      <div className="flex flex-col gap-4 xl:grid xl:grid-cols-[300px_minmax(0,1fr)_340px] xl:items-start">
        <div className="xl:sticky xl:top-4">
        <ContactProperties
          clientId={props.clientId}
          contactId={props.contactId}
          summary={props.summary}
          identities={props.identities}
          candidates={props.candidates}
          canManageDuplicates={props.canManageDuplicates}
          canEditFieldDefs={props.canEditFieldDefs}
          initial={props.properties}
          members={props.members}
          ownerName={props.ownerName}
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
  );
}

/**
 * The record's COMPACT HEADER (final design): who this is (name + stage + customer
 * badge), the operative facts an agent needs before acting (source, owner, visits,
 * no-shows), and the two primary actions. The actions moved UP here from the right
 * rail so the rail is purely associations — the rail no longer renders them, so
 * there is exactly one "Open conversation" / "Book appointment" per page.
 */
function ContactRecordHeader({
  clientId,
  contactId,
  summary,
  source,
  ownerName,
  mostRecentConversationId,
  schedulingEnabled,
}: {
  clientId: string;
  contactId: string;
  summary: ContactSummary;
  source: string;
  ownerName: string | null;
  mostRecentConversationId: string | null;
  schedulingEnabled: boolean;
}) {
  const action =
    "inline-flex h-10 items-center rounded-md border border-line-strong bg-surface px-3 text-sm text-foreground transition-colors hover:bg-subtle";
  return (
    <header className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-lg border border-line bg-surface px-4 py-3">
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="truncate text-lg font-semibold tracking-tight text-foreground">{summary.displayName}</h1>
          <StageChip stage={summary.stage} />
          {summary.isCustomer ? <Chip tone="muted">customer</Chip> : null}
          {/* Consent surfaces ONLY when opted out — quiet, informational, not an error. */}
          {summary.consent === "opted_out" ? (
            <Chip tone="warn" title="This contact has opted out of messaging">
              opted out
            </Chip>
          ) : null}
        </div>
        <dl className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
          <Fact label="Source" value={source} />
          <Fact label="Owner" value={ownerName ?? "Unassigned"} />
          <Fact label="Visits" value={String(summary.visitCount)} mono />
          <Fact label="No-shows" value={String(summary.noShowCount)} mono />
        </dl>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        {mostRecentConversationId ? (
          <Link href={`/clients/${clientId}/inbox?c=${encodeURIComponent(mostRecentConversationId)}`} className={action}>
            Open conversation
          </Link>
        ) : null}
        {schedulingEnabled ? (
          <Link
            href={`/clients/${clientId}/scheduling/agenda?book=${encodeURIComponent(contactId)}&return=${encodeURIComponent(contactId)}`}
            className={action}
          >
            Book appointment
          </Link>
        ) : null}
      </div>
    </header>
  );
}

function Fact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="u-th">{label}</dt>
      <dd className={`text-foreground ${mono ? "u-mono" : ""}`}>{value}</dd>
    </div>
  );
}

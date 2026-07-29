"use client";

import { useRouter } from "next/navigation";
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
    <div className="flex flex-col gap-6 xl:grid xl:grid-cols-[280px_minmax(0,1fr)_320px] xl:items-start">
      <div className="xl:sticky xl:top-6">
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
  );
}

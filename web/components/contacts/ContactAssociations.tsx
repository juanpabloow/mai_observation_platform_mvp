"use client";

import { Panel } from "@/components/ui/primitives";
import { CRM_COPY } from "@/lib/contactLabels";
import { IconCalendar, IconInternal, IconTask, SectionHeading } from "./form/formPrimitives";
import type { AppointmentSummary, MemberOption, TagView, TaskView } from "@/lib/contactShared";
import { AppointmentsSection } from "./shared/AppointmentsSection";
import { TasksSection } from "./shared/TasksSection";
import { TagsSection } from "./shared/TagsSection";

/**
 * The record's RIGHT rail (C-4): next/upcoming/past appointments, open tasks and tags —
 * all assembled from the SHARED sections (so the inbox panel renders the same pieces).
 * Every action respects the module + access gates server-side.
 *
 * The two PRIMARY actions that used to sit on top of this rail now live in the record's
 * compact header, so each appears exactly once per page. The rail is purely
 * associations; the appointment actions inside AppointmentsSection are unchanged.
 */
export function ContactAssociations({
  clientId,
  contactId,
  appointments,
  openTasks,
  tags,
  tagCatalogue,
  assignableMembers,
  viewerUserId,
  viewerIsFullAccess,
  canManageTags,
  schedulingEnabled,
  onChanged,
}: {
  clientId: string;
  contactId: string;
  appointments: AppointmentSummary;
  openTasks: TaskView[];
  tags: TagView[];
  tagCatalogue: TagView[];
  assignableMembers: MemberOption[];
  viewerUserId: string;
  viewerIsFullAccess: boolean;
  canManageTags: boolean;
  /** Accepted for the caller's convenience but no longer rendered here: the
   *  conversation shortcut moved to the record header (one per page). */
  mostRecentConversationId: string | null;
  schedulingEnabled: boolean;
  onChanged?: () => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      {schedulingEnabled ? (
        <Panel className="shadow-[var(--shadow-card)]">
          <div className="flex flex-col gap-3 p-3">
            <SectionHeading title={CRM_COPY.headings.appointments} icon={<IconCalendar />} />
            <AppointmentsSection clientId={clientId} appointments={appointments} onChanged={onChanged} showHistory returnContactId={contactId} />
          </div>
        </Panel>
      ) : null}

      <Panel className="shadow-[var(--shadow-card)]">
        <div className="flex flex-col gap-3 p-3">
          <SectionHeading title={CRM_COPY.headings.openTasks} icon={<IconTask />} />
          <TasksSection
            clientId={clientId}
            contactId={contactId}
            tasks={openTasks}
            assignableMembers={assignableMembers}
            viewerUserId={viewerUserId}
            viewerIsFullAccess={viewerIsFullAccess}
            onChanged={onChanged}
          />
        </div>
      </Panel>

      <Panel className="shadow-[var(--shadow-card)]">
        <div className="flex flex-col gap-3 p-3">
          <SectionHeading title={CRM_COPY.headings.tags} icon={<IconInternal />} />
          <TagsSection
            clientId={clientId}
            contactId={contactId}
            tags={tags}
            catalogue={tagCatalogue}
            canManageCatalog={canManageTags}
            onChanged={onChanged}
          />
        </div>
      </Panel>
    </div>
  );
}

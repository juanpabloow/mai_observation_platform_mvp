"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import type { AppointmentSummary, MemberOption, TagView, TaskView } from "@/lib/contactShared";
import { AppointmentsSection } from "./shared/AppointmentsSection";
import { TasksSection } from "./shared/TasksSection";
import { TagsSection } from "./shared/TagsSection";

/** Local client-safe card (same chrome as analytics-ui's PanelCard, which can't be
 *  imported here — it transitively pulls the server pg client into the bundle). */
function RailCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-line bg-card p-4">
      <p className="mb-2 text-sm font-medium text-foreground">{title}</p>
      {children}
    </div>
  );
}

/**
 * The record's RIGHT rail (C-4): next/upcoming/past appointments, open tasks, tags, and
 * quick actions — all assembled from the SHARED sections (so the inbox panel renders the
 * same pieces). Every action respects the module + access gates server-side.
 *
 * "Book appointment" DEEP-LINKS to the agenda: the existing new-appointment modal does
 * not accept a prefilled contact (no contactId on the booking input), so per the phase
 * plan we link rather than build a new booking form — prefill is reported as a gap.
 * "Open conversation" targets the most recent conversation's inbox thread (?c=), hidden
 * when the contact has none.
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
  mostRecentConversationId,
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
  mostRecentConversationId: string | null;
  schedulingEnabled: boolean;
  onChanged?: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      {/* Quick actions */}
      <div className="flex flex-wrap gap-2">
        {schedulingEnabled ? (
          <Link
            href={`/clients/${clientId}/scheduling/agenda`}
            className="rounded-lg border border-line px-3 py-1.5 text-sm text-foreground transition-colors hover:bg-subtle"
          >
            Book appointment
          </Link>
        ) : null}
        {mostRecentConversationId ? (
          <Link
            href={`/clients/${clientId}/inbox?c=${encodeURIComponent(mostRecentConversationId)}`}
            className="rounded-lg border border-line px-3 py-1.5 text-sm text-foreground transition-colors hover:bg-subtle"
          >
            Open conversation
          </Link>
        ) : null}
      </div>

      {schedulingEnabled ? (
        <RailCard title="Appointments">
          <AppointmentsSection clientId={clientId} appointments={appointments} onChanged={onChanged} showHistory />
        </RailCard>
      ) : null}

      <RailCard title="Open tasks">
        <TasksSection
          clientId={clientId}
          contactId={contactId}
          tasks={openTasks}
          assignableMembers={assignableMembers}
          viewerUserId={viewerUserId}
          viewerIsFullAccess={viewerIsFullAccess}
          onChanged={onChanged}
        />
      </RailCard>

      <RailCard title="Tags">
        <TagsSection
          clientId={clientId}
          contactId={contactId}
          tags={tags}
          catalogue={tagCatalogue}
          canManageCatalog={canManageTags}
          onChanged={onChanged}
        />
      </RailCard>
    </div>
  );
}

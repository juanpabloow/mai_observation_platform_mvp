/**
 * THE ONE place the unified-timeline copy lives (C-4). getContactTimeline (C-3) returns
 * a `kind` / `title_key` + structured `ref`/`meta` — never sentences — so every human
 * word for a timeline entry is mapped here, in one module, so wording changes in one
 * place and stays translatable. Titles are short and factual.
 *
 * `group` sorts an entry into a filter bucket + a VISUAL WEIGHT: appointments and
 * conversations read as substantive entries; CRM facts (tasks/tags/owner/stage/merge/
 * consent) read as quiet log lines. `source` is the C-3 API filter bucket the kind
 * belongs to — the timeline pushes the active filter down to getContactTimeline at this
 * source granularity (never hides rows client-side).
 */
import type { TimelineSource } from "@worker/db/repositories/contactTimeline.js";

export type TimelineWeight = "substantive" | "quiet";
export type TimelineIconKind =
  | "conversation"
  | "appointment"
  | "note"
  | "task"
  | "tag"
  | "owner"
  | "stage"
  | "merge"
  | "consent";

export interface TimelineKindCopy {
  title: string;
  icon: TimelineIconKind;
  weight: TimelineWeight;
  source: TimelineSource;
}

/** Fallback for an unrecognised kind — factual, never a crash. */
const FALLBACK: TimelineKindCopy = { title: "Activity", icon: "task", weight: "quiet", source: "activity" };

const COPY: Record<string, TimelineKindCopy> = {
  conversation: { title: "Conversation", icon: "conversation", weight: "substantive", source: "conversation" },

  appointment_created: { title: "Appointment booked", icon: "appointment", weight: "substantive", source: "appointment" },
  appointment_rescheduled: { title: "Appointment rescheduled", icon: "appointment", weight: "substantive", source: "appointment" },
  appointment_confirmed: { title: "Appointment confirmed", icon: "appointment", weight: "substantive", source: "appointment" },
  appointment_completed: { title: "Appointment completed", icon: "appointment", weight: "substantive", source: "appointment" },
  appointment_cancelled: { title: "Appointment cancelled", icon: "appointment", weight: "substantive", source: "appointment" },
  appointment_no_show: { title: "No-show", icon: "appointment", weight: "substantive", source: "appointment" },

  note: { title: "Note", icon: "note", weight: "substantive", source: "note" },

  task_created: { title: "Task created", icon: "task", weight: "quiet", source: "activity" },
  task_completed: { title: "Task completed", icon: "task", weight: "quiet", source: "activity" },
  task_reopened: { title: "Task reopened", icon: "task", weight: "quiet", source: "activity" },
  task_cancelled: { title: "Task cancelled", icon: "task", weight: "quiet", source: "activity" },
  task_assigned: { title: "Task assigned", icon: "task", weight: "quiet", source: "activity" },

  tag_added: { title: "Tag added", icon: "tag", weight: "quiet", source: "activity" },
  tag_removed: { title: "Tag removed", icon: "tag", weight: "quiet", source: "activity" },
  owner_changed: { title: "Owner changed", icon: "owner", weight: "quiet", source: "activity" },
  stage_changed: { title: "Stage changed", icon: "stage", weight: "quiet", source: "activity" },
  contact_merged: { title: "Contact merged", icon: "merge", weight: "quiet", source: "activity" },
  consent_changed: { title: "Consent updated", icon: "consent", weight: "quiet", source: "activity" },
};

export function timelineCopy(kind: string): TimelineKindCopy {
  return COPY[kind] ?? FALLBACK;
}

/**
 * The filter chips shown above the timeline. Each non-"all" chip maps to exactly ONE
 * C-3 API source, so selecting it pushes `kinds=[source]` to getContactTimeline (server-
 * side), never a client-side hide. NOTE: C-3 filters at source granularity, so task_*
 * and the CRM facts (tag/owner/stage/merge/consent) share the single "activity" source —
 * they are one "Activity" chip here rather than the separate Tasks/Changes the mock
 * imagined, because splitting them would require hiding rows client-side.
 */
export const TIMELINE_FILTERS: ReadonlyArray<{ label: string; sources: TimelineSource[] | null }> = [
  { label: "All", sources: null },
  { label: "Conversations", sources: ["conversation"] },
  { label: "Appointments", sources: ["appointment"] },
  { label: "Notes", sources: ["note"] },
  { label: "Activity", sources: ["activity"] },
];

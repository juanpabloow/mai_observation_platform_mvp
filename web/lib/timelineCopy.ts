/**
 * THE ONE place the unified-timeline copy lives (C-4). getContactTimeline (C-3) returns
 * a `kind` / `title_key` + structured `ref`/`meta` — never sentences — so every human
 * word for a timeline entry is mapped here, in one module, so wording changes in one
 * place and stays translatable. Titles are short, factual and IN SPANISH — the
 * product's language; the stored `kind` stays English because it is storage.
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
const FALLBACK: TimelineKindCopy = { title: "Actividad", icon: "task", weight: "quiet", source: "activity" };

const COPY: Record<string, TimelineKindCopy> = {
  conversation: { title: "Conversación", icon: "conversation", weight: "substantive", source: "conversation" },

  appointment_created: { title: "Cita agendada", icon: "appointment", weight: "substantive", source: "appointment" },
  appointment_rescheduled: { title: "Cita reagendada", icon: "appointment", weight: "substantive", source: "appointment" },
  appointment_confirmed: { title: "Cita confirmada", icon: "appointment", weight: "substantive", source: "appointment" },
  appointment_completed: { title: "Cita completada", icon: "appointment", weight: "substantive", source: "appointment" },
  appointment_cancelled: { title: "Cita cancelada", icon: "appointment", weight: "substantive", source: "appointment" },
  appointment_no_show: { title: "No asistió", icon: "appointment", weight: "substantive", source: "appointment" },

  note: { title: "Nota", icon: "note", weight: "substantive", source: "note" },

  task_created: { title: "Tarea creada", icon: "task", weight: "quiet", source: "activity" },
  task_completed: { title: "Tarea completada", icon: "task", weight: "quiet", source: "activity" },
  task_reopened: { title: "Tarea reabierta", icon: "task", weight: "quiet", source: "activity" },
  task_cancelled: { title: "Tarea cancelada", icon: "task", weight: "quiet", source: "activity" },
  task_assigned: { title: "Tarea asignada", icon: "task", weight: "quiet", source: "activity" },

  tag_added: { title: "Etiqueta agregada", icon: "tag", weight: "quiet", source: "activity" },
  tag_removed: { title: "Etiqueta quitada", icon: "tag", weight: "quiet", source: "activity" },
  owner_changed: { title: "Cambio de dueño", icon: "owner", weight: "quiet", source: "activity" },
  stage_changed: { title: "Cambio de stage", icon: "stage", weight: "quiet", source: "activity" },
  contact_merged: { title: "Contactos fusionados", icon: "merge", weight: "quiet", source: "activity" },
  consent_changed: { title: "Consentimiento actualizado", icon: "consent", weight: "quiet", source: "activity" },
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
  { label: "Todo", sources: null },
  { label: "Conversaciones", sources: ["conversation"] },
  { label: "Citas", sources: ["appointment"] },
  { label: "Notas", sources: ["note"] },
  { label: "Actividad", sources: ["activity"] },
];

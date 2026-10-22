import { REVIEW_REASON_LABEL, reviewReasons, type ReviewReason } from "@worker/scheduling/effectiveSchedule.js";
import type { Occurrence } from "@worker/scheduling/series.js";
import type { WeeklyHours } from "@worker/scheduling/types.js";

/**
 * «Requiere revisión» for the appointments on screen — DERIVED on every load from the same
 * rules as availability (src/scheduling/effectiveSchedule.ts), never stored, independent of
 * the appointment's status. Only live (scheduled/confirmed) appointments are read; a
 * cancelled or finished one has nothing left to review.
 */
export function reviewByAppointment(input: {
  timeZone: string;
  siteHours: WeeklyHours;
  staffHours: Map<string, WeeklyHours>;
  appointments: Array<{ id: string; staff_id: string; status: string; start_at: Date; service_end_at: Date }>;
  /** Dated blocks (schedule_exceptions) in range. */
  blocks: Array<{ staff_id: string | null; starts_at: Date; ends_at: Date }>;
  /** Series occurrences (breaks + recurring blocks) in range. */
  occurrences: Occurrence[];
}): Map<string, ReviewReason[]> {
  const out = new Map<string, ReviewReason[]>();
  const siteBlocks = [
    ...input.blocks.filter((b) => b.staff_id === null).map((b) => ({ from: b.starts_at, until: b.ends_at })),
    ...input.occurrences.filter((o) => o.kind === "block" && o.staff_id === null).map((o) => ({ from: o.from, until: o.until })),
  ];
  for (const a of input.appointments) {
    if (a.status !== "scheduled" && a.status !== "confirmed") continue;
    const reasons = reviewReasons(
      { from: a.start_at, until: a.service_end_at },
      {
        timeZone: input.timeZone,
        siteHours: input.siteHours,
        staffHours: input.staffHours.get(a.staff_id) ?? {},
        breaks: input.occurrences
          .filter((o) => o.kind === "break" && (o.staff_id === null || o.staff_id === a.staff_id))
          .map((o) => ({ from: o.from, until: o.until })),
        staffBlocks: [
          ...input.blocks.filter((b) => b.staff_id === a.staff_id).map((b) => ({ from: b.starts_at, until: b.ends_at })),
          ...input.occurrences.filter((o) => o.kind === "block" && o.staff_id === a.staff_id).map((o) => ({ from: o.from, until: o.until })),
        ],
        siteBlocks,
      },
    );
    if (reasons.length > 0) out.set(a.id, reasons);
  }
  return out;
}

export function reviewLabels(reasons: ReviewReason[] | undefined): string[] {
  return (reasons ?? []).map((r) => REVIEW_REASON_LABEL[r]);
}

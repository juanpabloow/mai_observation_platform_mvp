import type { DayExplanation, PublicAbsenceReason } from "@worker/scheduling/availabilityExplain.js";

/**
 * PUBLIC DAY STATUS — what the booking page may say about a day, derived from the
 * availability EXPLAINER (src/scheduling/availabilityExplain.ts), which reads exactly the
 * engine's inputs. Pure; unit-tested in test/unit/publicAvailability.test.ts.
 *
 *   open                at least one bookable start (the engine's own slots)
 *   site_closed         the SITE does not open that day, or a site-wide closure covers it
 *   artist_unavailable  this ARTIST is not working (day off, outside their shift, absence)
 *   no_slots            people work, but no free gap holds the whole service (booked,
 *                       breaks, blocks that leave gaps too short), or booking rules
 *
 * One artist's absence is never a site closure: `site_closed` comes only from the site's
 * own hours or from blocks with no professional. For "Sin preferencia" a day is `open` when
 * ANY eligible artist can take the full service (the engine never stitches two artists'
 * fragments into one slot), `site_closed` only when the site itself is closed, and
 * `no_slots` otherwise — including when every artist happens to be away.
 *
 * Reasons: only a block's PUBLIC reason (schedule_exceptions.public_reason, a curated code
 * the business chose to publish) is carried, and only when it alone explains the day. The
 * internal `reason` text never reaches this module.
 */

export type PublicDayKind = "open" | "site_closed" | "artist_unavailable" | "no_slots";

export interface PublicDay {
  date: string;
  kind: PublicDayKind;
  /** Only for site_closed / artist_unavailable, and only a published reason. */
  reason: PublicAbsenceReason | null;
}

function kindOf(e: DayExplanation): { kind: PublicDayKind; reason: PublicAbsenceReason | null } {
  if (e.status === "available") return { kind: "open", reason: null };
  switch (e.summary) {
    case "site_closed_day":
    case "outside_site_hours":
      return { kind: "site_closed", reason: null };
    case "site_closure": {
      const c = e.causes.find((x) => x.code === "site_closure");
      return c?.coverage === "all" && c.covers_whole_working_day ? { kind: "site_closed", reason: e.public_reason } : { kind: "no_slots", reason: null };
    }
    case "off_shift":
      return { kind: "artist_unavailable", reason: null };
    case "absence": {
      const c = e.causes.find((x) => x.code === "absence");
      // A partial absence leaves part of the shift: say "no times left", not "away".
      return c?.coverage === "all" ? { kind: "artist_unavailable", reason: e.public_reason } : { kind: "no_slots", reason: null };
    }
    default:
      return { kind: "no_slots", reason: null };
  }
}

/** One artist's days. */
export function publicDaysForArtist(explanations: DayExplanation[], staffId: string): PublicDay[] {
  return explanations.filter((e) => e.staff_id === staffId).map((e) => ({ date: e.date, ...kindOf(e) }));
}

/** "Sin preferencia": open if any artist is open; site_closed only if the site is closed. */
export function publicDaysForAny(explanations: DayExplanation[], staffIds: readonly string[]): PublicDay[] {
  const byDate = new Map<string, Array<{ kind: PublicDayKind; reason: PublicAbsenceReason | null }>>();
  for (const e of explanations) {
    if (!staffIds.includes(e.staff_id)) continue;
    byDate.set(e.date, [...(byDate.get(e.date) ?? []), kindOf(e)]);
  }
  return [...byDate.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, ks]) => {
      if (ks.some((k) => k.kind === "open")) return { date, kind: "open" as const, reason: null };
      if (ks.length > 0 && ks.every((k) => k.kind === "site_closed")) {
        const r = ks[0].reason;
        return { date, kind: "site_closed" as const, reason: ks.every((k) => k.reason === r) ? r : null };
      }
      return { date, kind: "no_slots" as const, reason: null };
    });
}

/** The first local day ("YYYY-MM-DD") on which `staffId` (or anyone, for null) has a slot. */
export function firstOpenDay(
  slots: ReadonlyArray<{ start_at: string; available_staff_ids: string[] }>,
  dayOf: (iso: string) => string,
  staffId: string | null,
): string | null {
  for (const s of slots) if (staffId === null || s.available_staff_ids.includes(staffId)) return dayOf(s.start_at);
  return null;
}

import { dateLabel, localClock24, localDay, timeLabel } from "./localTime";

/**
 * AV-1 — START WINDOWS: contiguous runs of VALID START times, derived from the slot engine's
 * output (computeAvailability). This is NOT "free time": `until` is the LAST start at which the
 * service still fits, never the end of the free block. So an artist free 10:00–19:30 with a 50-min
 * booking at 17:15 yields windows like 10:00→16:15 and 18:15→18:40 (last starts), not 10:00→17:15
 * and 18:05→19:30. The LLM is forbidden to compute durations/buffers/last-start; the platform does
 * it here. Pure (only the C-6 label helpers) → unit-testable without HTTP/DB.
 *
 * A run breaks wherever consecutive starts are NOT exactly `step_minutes` apart (a taken slot, a
 * break, time off or a closure removes the starts in between). For "any staff" the caller passes the
 * engine's UNION starts (one per time any artist can start) and `staffName=null`; for a staff filter
 * it passes that staff's starts and the staff name.
 */
export interface StartWindow {
  day: string;
  date_label: string;
  staff_name: string | null; // present for a single-staff window; null for the "any staff" union
  from: string; // first valid start, HH:MM (24h, site/label tz)
  until: string; // LAST valid start, HH:MM — never the end of the free time
  from_label: string; // locale read-aloud, e.g. "10:00 a. m."
  until_label: string; // e.g. "4:15 p. m."
  step_minutes: number;
  first_start_at: string; // ISO (UTC) of the first start — bookable verbatim
  until_start_at: string; // ISO (UTC) of the last start
}

/**
 * Collapse valid starts into contiguous windows per local day.
 * @param starts valid start instants (one per bookable time); duplicates are de-duped.
 * @param stepMs the slot grid step (slot_interval_min × 60000).
 * @param maxWindows defensive cap; when exceeded, the extra windows are dropped and `truncated`
 *   is true (a clear flag, never a silent cut). Not reachable for a normal ≤45-day request.
 */
export function computeStartWindows(
  starts: Date[],
  tz: string,
  locale: string,
  stepMs: number,
  staffName: string | null,
  maxWindows: number,
): { windows: StartWindow[]; truncated: boolean } {
  const stepMinutes = Math.round(stepMs / 60_000);
  // Unique, chronological start epochs. computeAvailability already emits one slot per union time,
  // but de-dupe defensively so a caller can pass raw per-staff starts too.
  const uniq = [...new Set(starts.map((d) => d.getTime()))].sort((a, b) => a - b);

  const byDay = new Map<string, number[]>();
  for (const t of uniq) {
    const day = localDay(new Date(t), tz);
    const list = byDay.get(day);
    if (list) list.push(t);
    else byDay.set(day, [t]);
  }

  const windows: StartWindow[] = [];
  let truncated = false;
  for (const day of [...byDay.keys()].sort()) {
    const times = byDay.get(day)!;
    let runStart = 0;
    for (let i = 1; i <= times.length; i++) {
      const broken = i === times.length || times[i] - times[i - 1] !== stepMs;
      if (!broken) continue;
      if (windows.length >= maxWindows) {
        truncated = true;
        break;
      }
      const first = new Date(times[runStart]);
      const last = new Date(times[i - 1]);
      windows.push({
        day,
        date_label: dateLabel(first, tz, locale),
        staff_name: staffName,
        from: localClock24(first, tz),
        until: localClock24(last, tz),
        from_label: timeLabel(first, tz, locale),
        until_label: timeLabel(last, tz, locale),
        step_minutes: stepMinutes,
        first_start_at: first.toISOString(),
        until_start_at: last.toISOString(),
      });
      runStart = i;
    }
    if (truncated) break;
  }
  return { windows, truncated };
}

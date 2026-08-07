"use client";

import type { WeeklyHours } from "@worker/scheduling/types.js";

/**
 * The 7-day WEEKLY HOURS editor and its converters — shared by the two things that
 * have opening hours: a SITE (Scheduling settings) and a BARBER (the Staff screen).
 *
 * It lived inside AdminPanel, which is why moving staff management out of that file
 * looked like it would need a copy. It doesn't: this is the common component, and
 * both callers import it.
 *
 * An empty grid round-trips to `{}`, which is the model's "inherit the site's opening
 * hours" for a staff member — so switching every day off is a real, meaningful save
 * and not an empty write.
 */
export const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

export type HourRow = { on: boolean; start: string; end: string };
export type HourGrid = Record<string, HourRow>;

export function gridFromWeekly(weekly: WeeklyHours): HourGrid {
  return Object.fromEntries(
    DAYS.map((d) => {
      const slot = weekly?.[d as keyof WeeklyHours]?.[0];
      return [d, slot ? { on: true, start: slot.start, end: slot.end } : { on: false, start: "09:00", end: "18:00" }];
    }),
  );
}

export function weeklyFromGrid(grid: HourGrid): WeeklyHours {
  const out: WeeklyHours = {};
  for (const d of DAYS) if (grid[d].on) out[d as keyof WeeklyHours] = [{ start: grid[d].start, end: grid[d].end }];
  return out;
}

const INPUT = "rounded-lg border border-line-strong bg-transparent px-2 py-1.5 text-sm";

export function HoursGrid({ grid, setGrid }: { grid: HourGrid; setGrid: (g: HourGrid) => void }) {
  return (
    <div className="flex flex-col gap-1">
      {DAYS.map((d) => (
        <div key={d} className="flex items-center gap-2 text-xs">
          <label className="flex w-16 items-center gap-1">
            <input
              type="checkbox"
              checked={grid[d].on}
              onChange={(e) => setGrid({ ...grid, [d]: { ...grid[d], on: e.target.checked } })}
            />
            {d}
          </label>
          <input
            type="time"
            value={grid[d].start}
            disabled={!grid[d].on}
            onChange={(e) => setGrid({ ...grid, [d]: { ...grid[d], start: e.target.value } })}
            className={INPUT}
          />
          <input
            type="time"
            value={grid[d].end}
            disabled={!grid[d].on}
            onChange={(e) => setGrid({ ...grid, [d]: { ...grid[d], end: e.target.value } })}
            className={INPUT}
          />
        </div>
      ))}
    </div>
  );
}

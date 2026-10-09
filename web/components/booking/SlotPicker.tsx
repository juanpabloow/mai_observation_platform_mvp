"use client";

import { fmtTime, siteHour, type HourFormat } from "@/lib/siteCalendar";

/**
 * The chosen day's real free times as a column of full-width buttons in site time,
 * split into morning and afternoon, in the visitor's chosen 12/24-hour format.
 * PRESENTATIONAL: the slots come from the public availability endpoint (the booking
 * engine), already de-duplicated by the flow.
 */

export interface SlotOption {
  start_at: string;
  service_end_at: string;
}

export function SlotPicker({
  slots,
  timezone,
  format,
  selected,
  onSelect,
  loading,
  emptyMessage,
}: {
  slots: SlotOption[];
  timezone: string;
  format: HourFormat;
  selected: string | null;
  onSelect: (startAt: string) => void;
  loading: boolean;
  emptyMessage: string;
}) {
  if (loading) {
    return (
      <div className="flex flex-col gap-2" aria-busy="true">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="h-[46px] animate-pulse rounded-[9px] bg-subtle" />
        ))}
        <p className="sr-only" role="status">
          Buscando horarios…
        </p>
      </div>
    );
  }
  if (slots.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-line-strong px-4 py-7 text-center text-[13px] text-muted">{emptyMessage}</div>
    );
  }
  const groups = [
    { key: "am", label: "Mañana", slots: slots.filter((s) => siteHour(s.start_at, timezone) < 12) },
    { key: "pm", label: "Tarde", slots: slots.filter((s) => siteHour(s.start_at, timezone) >= 12) },
  ].filter((g) => g.slots.length > 0);

  return (
    <div className="flex flex-col gap-4">
      {groups.map((g) => (
        <div key={g.key} className="flex flex-col gap-2">
          <span className="text-xs text-muted">{g.label}</span>
          <div role="radiogroup" aria-label={g.label} className="flex flex-col gap-2">
            {g.slots.map((s) => {
              const active = selected === s.start_at;
              return (
                <button
                  key={s.start_at}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => onSelect(s.start_at)}
                  className={`u-focus h-[46px] w-full whitespace-nowrap rounded-[9px] border text-[14.5px] font-medium transition-colors ${
                    active
                      ? "border-ink bg-ink text-ink-fg"
                      : "border-line bg-subtle text-foreground hover:border-foreground"
                  }`}
                >
                  {fmtTime(s.start_at, timezone, format)}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

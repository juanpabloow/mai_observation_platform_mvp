"use client";

import { calendarDays, monthTitle, type DayKey, type MonthKey } from "@/lib/siteCalendar";

/**
 * The month calendar of the booking flow. Large day numbers; a bookable day is bright
 * with a small availability dot under it, a day without room or closed is dimmed, the
 * selected day is drawn inverted and today carries a quiet outline. It only says
 * WHETHER a day has room — the chosen day's times render beside/below it. The state of
 * every day is also in its accessible name ("hay cupos" / "sin cupos" / "cerrado") and
 * in the legend, so the dot is never the only signal. PRESENTATIONAL: availability is
 * computed by the flow and passed in.
 */

export type DayStatus = "outside" | "past" | "closed" | "loading" | "available" | "full";

const STATUS_LABEL: Record<DayStatus, string> = {
  outside: "",
  past: "pasado",
  closed: "Cerrado",
  loading: "cargando",
  available: "Hay cupos",
  full: "Sin cupos",
};

const WEEKDAYS = ["LUN", "MAR", "MIÉ", "JUE", "VIE", "SÁB", "DOM"];

export function MonthCalendar({
  month,
  selected,
  today,
  statusOf,
  onSelect,
  onPrev,
  onNext,
  canPrev,
  canNext,
  loading,
}: {
  month: MonthKey;
  selected: DayKey | null;
  today: DayKey;
  statusOf: (day: DayKey, inMonth: boolean) => DayStatus;
  onSelect: (day: DayKey) => void;
  onPrev: () => void;
  onNext: () => void;
  canPrev: boolean;
  canNext: boolean;
  loading: boolean;
}) {
  const days = calendarDays(month);
  const title = monthTitle(month);
  const navBtn =
    "u-focus inline-flex size-[44px] items-center justify-center rounded-xl border border-line-strong text-lg text-foreground transition-colors hover:bg-subtle disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent";
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <h3 className="min-w-0 flex-1 truncate text-xl font-semibold tracking-tight sm:text-2xl" aria-live="polite">
          {title}
        </h3>
        <button type="button" aria-label="Mes anterior" onClick={onPrev} disabled={!canPrev} className={navBtn}>
          ‹
        </button>
        <button type="button" aria-label="Mes siguiente" onClick={onNext} disabled={!canNext} className={navBtn}>
          ›
        </button>
      </div>

      <div className="grid grid-cols-7 gap-1 sm:gap-1.5" aria-hidden>
        {WEEKDAYS.map((label) => (
          <span key={label} className="text-center text-[0.6875rem] font-medium tracking-wide text-muted sm:text-xs">
            {label}
          </span>
        ))}
      </div>

      <div role="group" aria-label={`Días de ${title}`} aria-busy={loading} className="grid grid-cols-7 gap-1 sm:gap-1.5">
        {days.map((d) => {
          const status = statusOf(d.key, d.inMonth);
          if (!d.inMonth) {
            return (
              <span key={d.key} aria-hidden className="flex h-[52px] items-center justify-center text-base tabular-nums text-faintest/50 sm:h-[60px]">
                {d.day}
              </span>
            );
          }
          const isSelected = selected === d.key;
          const isToday = today === d.key;
          const enabled = status === "available";
          const label = STATUS_LABEL[status];
          return (
            <button
              key={d.key}
              type="button"
              aria-pressed={isSelected}
              aria-current={isToday ? "date" : undefined}
              aria-label={`${d.day}${isToday ? ", hoy" : ""}${label ? `, ${label.toLocaleLowerCase("es")}` : ""}`}
              title={label && status !== "loading" ? label : undefined}
              disabled={!enabled}
              onClick={() => onSelect(d.key)}
              className={`u-focus relative flex h-[52px] flex-col items-center justify-center gap-1 rounded-xl border transition-colors sm:h-[60px] ${
                isSelected
                  ? "border-ink bg-ink text-ink-fg"
                  : isToday
                    ? "border-line-strong bg-subtle"
                    : "border-transparent"
              } ${enabled && !isSelected ? "hover:border-line-strong hover:bg-subtle" : ""} disabled:cursor-default`}
            >
              <span
                className={`text-base tabular-nums sm:text-[1.0625rem] ${
                  isSelected ? "font-semibold" : enabled ? "font-semibold text-foreground" : "text-faintest"
                }`}
              >
                {d.day}
              </span>
              {status === "loading" ? (
                <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-line-strong" />
              ) : enabled ? (
                <span aria-hidden className={`size-1.5 rounded-full ${isSelected ? "bg-ink-fg/70" : "u-booking-dot"}`} />
              ) : (
                <span aria-hidden className="size-1.5" />
              )}
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[0.6875rem] text-muted">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="u-booking-dot size-1.5 rounded-full" />
          Hay cupos
        </span>
        <span className="inline-flex items-center gap-1.5 text-faint">
          <span aria-hidden className="text-faintest">12</span>
          Sin cupos o cerrado
        </span>
      </div>
    </div>
  );
}

"use client";

import { calendarDays, dayHeadline, fmtTime, monthTitle, type DayKey, type MonthKey } from "@/lib/siteCalendar";
import { DAY_STATUS_SPOKEN, groupSlots, isSelectableDay, type DayStatus } from "@/lib/publicBookingFlow";
import { BTN_PRIMARY_SM, BTN_SECONDARY, IconChevron, IconInfo, LINK_BTN, SERIF, type Slot } from "./ui";

/**
 * STEP 3 — Elige fecha y hora. A month calendar (Monday first) with circular selection:
 * selected = black disc, today = ring, a green dot = "Hay cupos", struck-through = no
 * room or closed, greyed = past or beyond the booking horizon. Times are listed under
 * it, in 24 h and in the SITE's timezone. Nothing here decides availability: the days
 * and times are what the public availability endpoint (the shared engine) returned.
 */

const WEEK_HEADER = ["LU", "MA", "MI", "JU", "VI", "SÁ", "DO"];

/** What an empty day offers — as data; the flow performs it (onEmptyAction). */
export type EmptyAction = { kind: "day"; day: DayKey } | { kind: "nextMonth" } | { kind: "any" } | { kind: "artist" };
export interface EmptyState {
  title: string;
  text: string;
  next?: { label: string; action: EmptyAction };
  alt?: { label: string; action: EmptyAction };
}

export function DateTimeStep({
  serviceLine,
  artistLine,
  onChangeService,
  onChangeArtist,
  notice,
  month,
  today,
  selectedDay,
  statusOf,
  onPickDay,
  canPrev,
  canNext,
  onPrev,
  onNext,
  timezone,
  timezoneText,
  slots,
  selectedSlot,
  onPickSlot,
  loading,
  error,
  onRetry,
  empty,
  onEmptyAction,
}: {
  serviceLine: string;
  artistLine: string;
  onChangeService: () => void;
  onChangeArtist: () => void;
  notice: string | null;
  month: MonthKey;
  today: DayKey;
  selectedDay: DayKey | null;
  statusOf: (day: DayKey) => DayStatus;
  onPickDay: (day: DayKey) => void;
  canPrev: boolean;
  canNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  timezone: string;
  timezoneText: string;
  slots: Slot[];
  selectedSlot: string | null;
  onPickSlot: (start: string) => void;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  empty: EmptyState | null;
  onEmptyAction: (a: EmptyAction) => void;
}) {
  const cells = calendarDays(month);
  // calendarDays starts weeks on Sunday; the design starts them on Monday.
  const lead = (() => {
    const first = cells.find((c) => c.inMonth);
    if (!first) return 0;
    const [y, m, d] = first.key.split("-").map(Number);
    return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
  })();
  const monthDays = cells.filter((c) => c.inMonth);
  const blanksAfter = (7 - ((lead + monthDays.length) % 7)) % 7;
  const title = monthTitle(month);
  const groups = groupSlots(slots, timezone);
  const dayTitle = selectedDay ? `${selectedDay === today ? "Hoy, " : ""}${selectedDay === today ? dayHeadline(selectedDay).toLocaleLowerCase("es") : dayHeadline(selectedDay)}` : "Elige un día";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col rounded-[16px] border border-pb-line bg-white py-0.5 pl-4 pr-1.5">
        <div className="flex min-h-[52px] items-center gap-2.5 border-b border-pb-hair">
          <span className="flex min-w-0 flex-1 flex-col gap-px">
            <span className="text-[12.5px] text-pb-muted">Servicio</span>
            <span className="truncate text-[15px]">{serviceLine}</span>
          </span>
          <button type="button" onClick={onChangeService} className={LINK_BTN}>
            Cambiar<span className="sr-only"> servicio</span>
          </button>
        </div>
        <div className="flex min-h-[52px] items-center gap-2.5">
          <span className="flex min-w-0 flex-1 flex-col gap-px">
            <span className="text-[12.5px] text-pb-muted">Artista</span>
            <span className="truncate text-[15px]">{artistLine}</span>
          </span>
          <button type="button" onClick={onChangeArtist} className={LINK_BTN}>
            Cambiar<span className="sr-only"> artista</span>
          </button>
        </div>
      </div>

      {notice ? (
        <div role="status" className="flex items-start gap-2.5 rounded-[12px] border border-pb-warn-bd bg-pb-warn-bg px-3.5 py-3 text-[14px] leading-[1.45] text-pb-warn-fg">
          <IconInfo />
          <span>{notice}</span>
        </div>
      ) : null}

      <section aria-label="Calendario" className="rounded-[16px] border border-pb-line bg-white px-2 pb-3 pt-3.5 min-[380px]:px-3">
        <div className="flex items-center gap-2 px-1 pb-2">
          <h2 className={`${SERIF} m-0 text-[22px]`} aria-live="polite">
            {title}
          </h2>
          <span className="ml-auto flex gap-1.5">
            <NavButton dir="prev" label="Mes anterior" disabled={!canPrev} onClick={onPrev} />
            <NavButton dir="next" label="Mes siguiente" disabled={!canNext} onClick={onNext} />
          </span>
        </div>
        <div role="group" aria-label={`Días de ${title}`} className="grid grid-cols-7 gap-y-0.5">
          <div aria-hidden className="contents">
            {WEEK_HEADER.map((w) => (
              <span key={w} className="pb-1.5 pt-0.5 text-center text-[12px] tracking-[0.04em] text-pb-muted">
                {w}
              </span>
            ))}
          </div>
          <div className="contents">
            {Array.from({ length: lead }, (_, i) => (
              <span key={`b${i}`} aria-hidden className="flex justify-center">
                <span className="size-11" />
              </span>
            ))}
            {monthDays.map((c) => {
              const st = statusOf(c.key);
              const selectable = isSelectableDay(st);
              const sel = c.key === selectedDay;
              const isToday = c.key === today;
              const open = st === "open";
              const struck = st === "full" || st === "closed";
              return (
                <span key={c.key} className="flex justify-center">
                  <button
                    type="button"
                    disabled={!selectable}
                    aria-pressed={sel}
                    aria-current={isToday ? "date" : undefined}
                    aria-label={`${isToday ? "Hoy, " : ""}${dayHeadline(c.key)}, ${DAY_STATUS_SPOKEN[st]}`}
                    onClick={() => onPickDay(c.key)}
                    className={`relative flex size-11 items-center justify-center rounded-full p-0 text-[15px] [font-variant-numeric:tabular-nums] ${
                      sel
                        ? "border border-pb-ink bg-pb-ink font-semibold text-white"
                        : !selectable
                          ? "cursor-not-allowed border border-transparent text-pb-dis"
                          : `${isToday ? "border-[1.5px] border-pb-ink" : "border border-transparent"} ${
                              struck ? "text-pb-struck line-through" : open ? "text-pb-ink" : "text-pb-muted"
                            }`
                    }`}
                  >
                    <span>{c.day}</span>
                    {open ? (
                      <span aria-hidden className={`absolute bottom-[5px] left-1/2 -ml-[2.5px] size-[5px] rounded-full ${sel ? "bg-white" : "bg-pb-ok"}`} />
                    ) : null}
                  </button>
                </span>
              );
            })}
            {Array.from({ length: blanksAfter }, (_, i) => (
              <span key={`a${i}`} aria-hidden className="flex justify-center">
                <span className="size-11" />
              </span>
            ))}
          </div>
        </div>
        <div className="mt-2 flex flex-wrap gap-x-3.5 gap-y-1.5 border-t border-pb-hair px-1 pt-2.5 text-[12.5px] text-pb-muted">
          <span className="flex items-center gap-1.5">
            <span aria-hidden className="size-[5px] rounded-full bg-pb-ok" />
            Hay cupos
          </span>
          <span className="flex items-center gap-1.5">
            <span aria-hidden className="size-3.5 rounded-full border-[1.5px] border-pb-ink" />
            Hoy
          </span>
          <span className="flex items-center gap-1.5">
            <span aria-hidden className="text-pb-struck line-through">
              18
            </span>
            Sin cupos o cerrado
          </span>
        </div>
      </section>

      <section aria-label="Horarios" className="flex flex-col gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 className="m-0 text-[17px] font-semibold">{dayTitle}</h2>
          <span className="text-[13px] text-pb-muted">Hora de {timezoneText}</span>
        </div>
        {error ? (
          <div role="alert" className="flex flex-col items-start gap-3 rounded-[16px] border border-pb-line bg-white p-4">
            <span className="text-[14px] leading-[1.45] text-pb-muted">No pudimos cargar los horarios. Revisa tu conexión e inténtalo de nuevo.</span>
            <button type="button" onClick={onRetry} className={BTN_SECONDARY}>
              Reintentar
            </button>
          </div>
        ) : loading ? (
          <div role="status" aria-label="Cargando horarios" className="grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-2">
            {Array.from({ length: 6 }, (_, k) => (
              <span key={k} aria-hidden className="h-12 rounded-[12px] bg-pb-hair" />
            ))}
          </div>
        ) : empty ? (
          <div className="flex flex-col gap-3 rounded-[16px] border border-pb-line bg-white p-4">
            <div className="flex flex-col gap-1">
              <span className="text-[16px] font-[590]">{empty.title}</span>
              <span className="text-[14px] leading-[1.45] text-pb-muted">{empty.text}</span>
            </div>
            {empty.next || empty.alt ? (
              <div className="flex flex-wrap gap-2">
                {empty.next ? (
                  <button type="button" onClick={() => onEmptyAction(empty.next!.action)} className={BTN_PRIMARY_SM}>
                    {empty.next.label}
                  </button>
                ) : null}
                {empty.alt ? (
                  <button type="button" onClick={() => onEmptyAction(empty.alt!.action)} className={BTN_SECONDARY}>
                    {empty.alt.label}
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-col gap-3.5">
            {groups.map((g) => (
              <div key={g.name} className="flex flex-col gap-2">
                <h3 className="m-0 text-[13px] font-[590] text-pb-muted">{g.name}</h3>
                <div role="group" aria-label={g.name} className="grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-2">
                  {g.items.map((s) => {
                    const sel = s.start_at === selectedSlot;
                    const label = fmtTime(s.start_at, timezone, "24");
                    return (
                      <button
                        key={s.start_at}
                        type="button"
                        aria-pressed={sel}
                        aria-label={`${label}, hasta las ${fmtTime(s.service_end_at, timezone, "24")}`}
                        onClick={() => onPickSlot(s.start_at)}
                        className={`min-h-12 rounded-[12px] border text-[15.5px] [font-variant-numeric:tabular-nums] ${
                          sel ? "border-pb-ink bg-pb-ink font-[590] text-white" : "border-pb-line2 bg-white text-pb-ink"
                        }`}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function NavButton({ dir, label, disabled, onClick }: { dir: "prev" | "next"; label: string; disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={`flex size-11 items-center justify-center rounded-full border bg-white p-0 ${
        disabled ? "cursor-not-allowed border-pb-hair text-pb-dis" : "border-pb-line2 text-pb-ink"
      }`}
    >
      <IconChevron dir={dir} />
    </button>
  );
}

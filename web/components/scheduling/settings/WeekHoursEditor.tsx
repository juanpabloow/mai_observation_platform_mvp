"use client";

import { DAYS, type HourGrid, type HourRow } from "../HoursGrid";
import { timeOptions, toMin } from "../mobile/config/logic";
import { SWITCH } from "@/components/ui/module/FormKit";

/**
 * The weekly opening hours of a SITE, as the Sedes editor shows them: one row per day
 * with an «Abierto / Cerrado» switch, 24-hour selects (half-hour steps, plus whatever
 * is already stored, so a 09:15 is never rounded away), the day's pause as a label, and
 * an error on the row itself when it closes before it opens.
 *
 * Same data as HoursGrid (HourGrid, pauses carried through untouched), so the save is
 * unchanged; HoursGrid stays as it is for Horarios y ausencias and the staff screen.
 */

const DAY_NAME: Record<string, string> = {
  mon: "Lunes",
  tue: "Martes",
  wed: "Miércoles",
  thu: "Jueves",
  fri: "Viernes",
  sat: "Sábado",
  sun: "Domingo",
};
const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri"];

/** Open minutes of one day (outer hours minus its pauses). */
function openMinutes(row: HourRow): number {
  if (!row.on) return 0;
  const total = Math.max(0, toMin(row.end) - toMin(row.start));
  const paused = (row.pauses ?? []).reduce((n, p) => n + Math.max(0, toMin(p.end) - toMin(p.start)), 0);
  return Math.max(0, total - paused);
}

const SELECT =
  "u-focus h-[44px] rounded-sch-control border border-line-strong bg-surface pl-3 pr-8 text-base tabular-nums text-foreground lg:h-[2.25rem] lg:text-sm aria-[invalid=true]:border-danger";

export function WeekHoursEditor({ grid, setGrid }: { grid: HourGrid; setGrid: (g: HourGrid) => void }) {
  const set = (d: string, patch: Partial<HourRow>) => setGrid({ ...grid, [d]: { ...grid[d], ...patch } });
  const copyMonday = (days: string[]) => {
    const mon = grid.mon;
    setGrid({ ...grid, ...Object.fromEntries(days.map((d) => [d, { ...mon, pauses: mon.pauses ? [...mon.pauses] : undefined }])) });
  };
  const openDays = DAYS.filter((d) => grid[d].on).length;
  const weekMinutes = DAYS.reduce((n, d) => n + openMinutes(grid[d]), 0);
  const hours = Math.round((weekMinutes / 60) * 10) / 10;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p className="mr-auto text-[0.8125rem] text-muted">
          {openDays === 0 ? (
            "Cerrada toda la semana: no se ofrecerán horarios."
          ) : (
            <>
              Abierta <strong className="font-semibold text-foreground">{openDays} día{openDays === 1 ? "" : "s"}</strong> · {hours.toLocaleString("es-CO")} h a la semana
            </>
          )}
        </p>
        <span className="text-xs text-muted">Copiar el lunes a:</span>
        <button type="button" onClick={() => copyMonday(WEEKDAYS.slice(1))} disabled={!grid.mon.on} className="u-focus h-[44px] rounded-full border border-line-strong px-3 text-[0.8125rem] font-medium text-foreground hover:bg-subtle disabled:opacity-50 lg:h-[2rem]">
          Martes a viernes
        </button>
        <button type="button" onClick={() => copyMonday(DAYS.slice(1))} disabled={!grid.mon.on} className="u-focus h-[44px] rounded-full border border-line-strong px-3 text-[0.8125rem] font-medium text-foreground hover:bg-subtle disabled:opacity-50 lg:h-[2rem]">
          Toda la semana
        </button>
      </div>

      <ul className="flex flex-col divide-y divide-line-soft overflow-hidden rounded-sch-card border border-line">
        {DAYS.map((d) => {
          const row = grid[d];
          const bad = row.on && toMin(row.end) <= toMin(row.start);
          const options = timeOptions([row.start, row.end]);
          const name = DAY_NAME[d];
          return (
            <li key={d} className={`flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 ${row.on ? "" : "bg-subtle/50"}`}>
              <label className="flex w-[11rem] shrink-0 cursor-pointer items-center gap-3">
                <input type="checkbox" role="switch" checked={row.on} onChange={(e) => set(d, { on: e.target.checked })} aria-label={`${name}: abierto`} className={SWITCH} />
                <span className={`text-[0.875rem] font-medium ${row.on ? "text-foreground" : "text-muted"}`}>{name}</span>
              </label>
              {row.on ? (
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                  <select value={row.start} onChange={(e) => set(d, { start: e.target.value })} aria-label={`${name}: abre`} aria-invalid={bad} className={SELECT}>
                    {options.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                  <span aria-hidden className="text-muted">
                    a
                  </span>
                  <select value={row.end} onChange={(e) => set(d, { end: e.target.value })} aria-label={`${name}: cierra`} aria-invalid={bad} className={SELECT}>
                    {options.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                  {row.pauses?.length ? (
                    <span className="rounded-full bg-chip px-2.5 py-1 text-[0.75rem] text-muted" title="La pausa se mantiene al cambiar el horario.">
                      {row.pauses.map((p) => `Pausa ${p.start}–${p.end}`).join(" · ")}
                    </span>
                  ) : null}
                  <span className="ml-auto text-[0.75rem] tabular-nums text-muted">{bad ? "" : `${Math.round((openMinutes(row) / 60) * 10) / 10} h`}</span>
                  {bad ? (
                    <span role="alert" className="basis-full text-xs text-danger">
                      La hora de cierre debe ser posterior a la de apertura.
                    </span>
                  ) : null}
                </div>
              ) : (
                <span className="text-[0.8125rem] text-muted">Cerrado</span>
              )}
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-muted">Horas en formato 24 h, en la zona horaria de la sede. Las pausas (por ejemplo, el almuerzo) se conservan al cambiar el horario del día.</p>
    </div>
  );
}


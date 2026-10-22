"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { saveWeeklyScheduleAction, type ScheduleWriteResult, type SeriesView } from "@/lib/scheduleSeriesActions";
import { useNavigationGuard } from "@/components/ui/module/useEditorGuard";
import { DiscardChanges } from "@/components/ui/module/ConfirmLayer";
import { Button } from "../ui/system";
import { AffectedList, TimeSelect, type AffectedItem } from "../agenda/ScheduleFormParts";

/**
 * THE WEEKLY SCHEDULE of one owner — the site's opening hours, or one professional's own
 * hours ("Atiende con [el horario de la sede ▾]"). Each day: open/closed, from–to, and its
 * USUAL BREAKS. A break lives only here (schedule_series kind=break, one per weekday): this
 * editor changes the routine from each weekday's first date not started yet; one date's
 * exception is changed from that date (calendar / «Cambiar la pausa de una fecha»).
 *
 * Inheriting shows the site's hours in grey — never "Off". Saving first asks the server
 * which future appointments the new week leaves outside the hours or inside a break; they
 * are listed, nothing moves, and saving anyway needs «Guardar igualmente». Errors keep every
 * change on screen with «Reintentar». Leaving with changes asks first.
 */
type Day = { open: boolean; start: string; end: string; breaks: Array<{ start: string; end: string }> };
type Week = Day[]; // index 0 = Sunday

const KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const NAMES = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];
const ORDER = [1, 2, 3, 4, 5, 6, 0];
const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const mins = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

type Hours = Record<string, Array<{ start: string; end: string }>>;

/** Current week = weekly hours (one span per day, gaps = breaks) + break rows in effect. */
export function weekFrom(hours: Hours, series: SeriesView[], today: string): Week {
  return KEYS.map((k, wd) => {
    const ranges = [...(hours[k] ?? [])].sort((a, b) => a.start.localeCompare(b.start));
    if (ranges.length === 0) return { open: false, start: "10:00", end: "19:00", breaks: [] };
    const breaks: Array<{ start: string; end: string }> = [];
    for (let i = 1; i < ranges.length; i++) if (ranges[i].start > ranges[i - 1].end) breaks.push({ start: ranges[i - 1].end, end: ranges[i].start });
    // The routine as of this weekday's next date: rows not ended before it.
    const next = nextDateOf(today, wd);
    for (const s of series) {
      if (s.kind !== "break" || s.weekdays[0] !== wd) continue;
      if (s.endsOn !== null && s.endsOn < next) continue;
      if (s.startsOn !== null && s.startsOn > next) continue;
      breaks.push({ start: s.start, end: s.end });
    }
    breaks.sort((a, b) => a.start.localeCompare(b.start));
    return { open: true, start: ranges[0].start, end: ranges[ranges.length - 1].end, breaks };
  });
}

function nextDateOf(today: string, wd: number): string {
  const [y, m, d] = today.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  const off = (wd - t.getUTCDay() + 7) % 7;
  const n = new Date(Date.UTC(y, m - 1, d + off));
  return `${n.getUTCFullYear()}-${String(n.getUTCMonth() + 1).padStart(2, "0")}-${String(n.getUTCDate()).padStart(2, "0")}`;
}

function dayHours(d: Day): number {
  if (!d.open) return 0;
  return Math.max(0, mins(d.end) - mins(d.start) - d.breaks.reduce((a, b) => a + Math.max(0, mins(b.end) - mins(b.start)), 0)) / 60;
}

export function WeeklyScheduleEditor(props: {
  clientId: string;
  siteId: string;
  /** null = the site's hours. */
  staffId: string | null;
  ownerLabel: string;
  siteName: string;
  timezone: string;
  today: string;
  hours: Hours;
  siteHours: Hours;
  /** Break rows of THIS owner (and, for a professional, the site's — shown when inheriting). */
  series: SeriesView[];
  siteSeries?: SeriesView[];
  canEdit: boolean;
  onSaved: (message: string) => void;
  onReschedule?: (item: AffectedItem) => void;
  /** Bumped after a reschedule → re-ask the affected list. */
  recheck?: number;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const isStaff = props.staffId !== null;
  const inheritsNow = isStaff && Object.keys(props.hours).length === 0;
  const initialWeek = useMemo(
    () => weekFrom(inheritsNow ? props.siteHours : props.hours, inheritsNow ? props.siteSeries ?? [] : props.series, props.today),
    [inheritsNow, props.hours, props.siteHours, props.series, props.siteSeries, props.today],
  );
  const siteWeek = useMemo(() => weekFrom(props.siteHours, props.siteSeries ?? [], props.today), [props.siteHours, props.siteSeries, props.today]);
  const [inherit, setInherit] = useState(inheritsNow);
  const [week, setWeek] = useState<Week>(initialWeek);
  const [editing, setEditing] = useState(false);
  const [result, setResult] = useState<ScheduleWriteResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [pending, startTransition] = useTransition();
  const sending = useRef(false);
  useEffect(() => {
    if (!editing) {
      setWeek(initialWeek);
      setInherit(inheritsNow);
    }
  }, [initialWeek, inheritsNow, editing]);

  const changes = useMemo(() => {
    if (inherit !== inheritsNow) return 1 + (inherit ? 0 : week.filter((d) => d.open).length);
    if (inherit) return 0;
    return week.reduce((n, d, i) => n + (JSON.stringify(d) === JSON.stringify(initialWeek[i]) ? 0 : 1), 0);
  }, [week, inherit, initialWeek, inheritsNow]);
  const dirty = editing && changes > 0;
  useEffect(() => props.onDirtyChange?.(dirty), [dirty]); // eslint-disable-line react-hooks/exhaustive-deps
  const nav = useNavigationGuard({ dirty, onAsk: () => setAsking(true) });

  const shown = inherit ? siteWeek : week;
  const total = shown.reduce((a, d) => a + dayHours(d), 0);
  const setDay = (wd: number, patch: Partial<Day>) => {
    setResult(null);
    setWeek((w) => w.map((d, i) => (i === wd ? { ...d, ...patch } : d)));
  };
  const affected = result && result.ok && !result.written ? (result.affected as AffectedItem[]) : null;

  const payload = (extra: { dryRun?: boolean; confirm?: boolean }) => ({
    clientId: props.clientId,
    siteId: props.siteId,
    staffId: props.staffId,
    inherit: isStaff ? inherit : undefined,
    days: KEYS.map((_, wd) => (week[wd].open ? { start: week[wd].start, end: week[wd].end } : null)),
    breaks: KEYS.map((_, wd) => (week[wd].open ? week[wd].breaks : [])),
    ...extra,
  });

  const save = (confirm: boolean) => {
    if (sending.current) return;
    sending.current = true;
    setError(null);
    startTransition(async () => {
      try {
        const r = await saveWeeklyScheduleAction(payload({ confirm }));
        if (!r.ok) {
          setError(r.error);
          return;
        }
        setResult(r);
        if (r.written) {
          setEditing(false);
          setResult(null);
          props.onSaved(`Horario guardado · ${props.ownerLabel}`);
        }
      } catch {
        setError("No se pudo guardar. Tus cambios siguen aquí.");
      } finally {
        sending.current = false;
      }
    });
  };

  // After coming back from a reschedule, ask again (a real move removes it from the list).
  useEffect(() => {
    if (!props.recheck || !editing || !affected) return;
    startTransition(async () => {
      try {
        const r = await saveWeeklyScheduleAction(payload({ dryRun: true }));
        if (r.ok) setResult(r.affected.length ? r : null);
      } catch {
        /* the list stays; saving re-checks anyway */
      }
    });
  }, [props.recheck]); // eslint-disable-line react-hooks/exhaustive-deps

  const cancel = () => {
    if (dirty) setAsking(true);
    else setEditing(false);
  };

  return (
    <section aria-labelledby={`wse-${props.staffId ?? "site"}`} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h3 id={`wse-${props.staffId ?? "site"}`} className="text-[15px] font-semibold">
          Horario semanal
        </h3>
        {isStaff ? (
          <label className="flex items-center gap-2 text-[13px] text-muted">
            <span aria-hidden className="h-4 w-px bg-line" />
            Atiende con
            <select
              aria-label="Origen del horario"
              disabled={!props.canEdit}
              value={inherit ? "site" : "own"}
              onChange={(e) => {
                setEditing(true);
                setResult(null);
                const own = e.target.value === "own";
                setInherit(!own);
                if (own && inheritsNow) setWeek(siteWeek.map((d) => ({ ...d, breaks: [...d.breaks] })));
              }}
              className="u-focus h-9 rounded-sch-control border border-line bg-surface px-2 text-[13px] font-medium text-foreground"
            >
              <option value="site">el horario de la sede</option>
              <option value="own">un horario propio</option>
            </select>
            <span className="text-[12.5px]">{inherit ? `${props.siteName}: ${shortWeek(siteWeek)}` : "Días y horas a medida"}</span>
          </label>
        ) : (
          <span className="text-[13px] text-muted">Es la base para quien no tiene horario propio.</span>
        )}
        <span className="ml-auto text-[13px] text-muted">
          <span className="u-tnum text-[20px] font-semibold text-foreground">{Math.round(total * 10) / 10} h</span> / semana
        </span>
      </div>

      <div className="overflow-hidden rounded-[14px] border border-line">
        <ul className="divide-y divide-line-soft">
          {ORDER.map((wd) => {
            const d = shown[wd];
            const readOnly = !props.canEdit || inherit;
            return (
              <li key={wd} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start sm:gap-4">
                <div className="flex w-full items-center justify-between sm:w-32 sm:flex-col sm:items-start sm:justify-start">
                  <span className="text-[13px] font-semibold">{NAMES[wd]}</span>
                  {!readOnly ? (
                    <button
                      type="button"
                      onClick={() => {
                        setEditing(true);
                        setDay(wd, d.open ? { open: false, breaks: [] } : { open: true });
                      }}
                      className="u-focus rounded text-[12.5px] text-muted underline-offset-2 hover:text-foreground hover:underline"
                    >
                      {d.open ? (isStaff ? "Marcar libre" : "Cerrar este día") : isStaff ? "Trabaja este día" : "Abrir este día"}
                    </button>
                  ) : null}
                </div>
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  {d.open ? (
                    <>
                      <DayTrack day={d} muted={inherit} />
                      <div className="flex flex-wrap items-center gap-2">
                        {readOnly ? (
                          <span className={`u-tnum text-[13px] ${inherit ? "text-muted" : ""}`}>{d.start} – {d.end}</span>
                        ) : (
                          <>
                            <TimeSelect label={`${NAMES[wd]}: desde`} value={d.start} onChange={(v) => { setEditing(true); setDay(wd, { start: v }); }} />
                            <span aria-hidden className="text-muted">–</span>
                            <TimeSelect label={`${NAMES[wd]}: hasta`} value={d.end} onChange={(v) => { setEditing(true); setDay(wd, { end: v }); }} />
                          </>
                        )}
                        {d.breaks.map((b, i) => (
                          <span key={i} className="inline-flex items-center gap-1.5 rounded-full bg-chip px-2.5 py-1 text-[12.5px]">
                            <span className="text-muted">Pausa</span>
                            {readOnly ? (
                              <span className="u-tnum">{b.start}–{b.end}</span>
                            ) : (
                              <>
                                <TimeSelect label={`${NAMES[wd]}: pausa desde`} value={b.start} onChange={(v) => { setEditing(true); setDay(wd, { breaks: d.breaks.map((x, j) => (j === i ? { ...x, start: v } : x)) }); }} />
                                <span aria-hidden>–</span>
                                <TimeSelect label={`${NAMES[wd]}: pausa hasta`} value={b.end} onChange={(v) => { setEditing(true); setDay(wd, { breaks: d.breaks.map((x, j) => (j === i ? { ...x, end: v } : x)) }); }} />
                                <button type="button" aria-label={`Quitar la pausa de ${b.start}`} onClick={() => { setEditing(true); setDay(wd, { breaks: d.breaks.filter((_, j) => j !== i) }); }} className="u-focus grid size-7 place-items-center rounded-full text-muted hover:bg-subtle hover:text-foreground">
                                  ×
                                </button>
                              </>
                            )}
                          </span>
                        ))}
                        {!readOnly ? (
                          <button
                            type="button"
                            onClick={() => {
                              setEditing(true);
                              const mid = Math.floor((mins(d.start) + mins(d.end)) / 2 / 30) * 30;
                              setDay(wd, { breaks: [...d.breaks, { start: hm(mid), end: hm(Math.min(mid + 60, mins(d.end) - 15)) }] });
                            }}
                            className="u-focus h-9 rounded-full px-3 text-[12.5px] font-medium text-foreground hover:bg-subtle"
                          >
                            + Pausa
                          </button>
                        ) : null}
                      </div>
                      {!readOnly && (mins(d.end) <= mins(d.start) || d.breaks.some((b) => mins(b.start) <= mins(d.start) || mins(b.end) >= mins(d.end) || mins(b.end) <= mins(b.start))) ? (
                        <span role="alert" className="text-[12.5px] text-danger">Revisa este día: el fin va después del inicio y las pausas quedan dentro del horario.</span>
                      ) : null}
                    </>
                  ) : (
                    <span className="text-[13px] text-muted">{isStaff ? "No trabaja" : "Cerrado"}</span>
                  )}
                </div>
                <span className="u-tnum hidden w-12 text-right text-[12.5px] text-muted sm:block">{d.open ? `${Math.round(dayHours(d) * 10) / 10} h` : ""}</span>
              </li>
            );
          })}
        </ul>
      </div>

      {affected && affected.length > 0 ? (
        <AffectedList
          items={affected}
          loading={pending}
          timezone={props.timezone}
          what="el nuevo horario"
          lead={(n) => `${n === 1 ? "1 cita queda" : `${n} citas quedan`} fuera del nuevo horario o dentro de una pausa.`}
          onReschedule={props.onReschedule}
        />
      ) : null}
      {result && result.ok && !result.written && result.summary ? (
        <ul className="flex flex-col gap-0.5 text-[12.5px] text-muted">
          {result.summary.lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      ) : null}
      {error ? <p role="alert" className="text-[13px] text-danger">{error}</p> : null}

      {props.canEdit && (editing || dirty) ? (
        <div className="sticky bottom-0 z-10 flex items-center gap-2 rounded-[12px] border border-line bg-surface px-3 py-2.5 shadow-[var(--shadow-float)]">
          <span className="min-w-0 flex-1 text-[13px] text-muted">
            {changes === 0 ? "Sin cambios" : `${changes} ${changes === 1 ? "cambio" : "cambios"} sin guardar`}
            {affected && affected.length > 0 ? <span className="ml-2 text-[var(--warn)]">· {affected.length} {affected.length === 1 ? "cita requiere" : "citas requieren"} revisión</span> : null}
          </span>
          <Button onClick={cancel} disabled={pending}>
            Cancelar
          </Button>
          <Button variant="primary" onClick={() => save(Boolean(affected && affected.length > 0))} disabled={changes === 0 || pending} loading={pending} loadingLabel="Guardando…">
            {error ? "Reintentar" : affected && affected.length > 0 ? "Guardar igualmente" : "Guardar horario"}
          </Button>
        </div>
      ) : props.canEdit && !inherit ? null : !props.canEdit ? (
        <p className="text-[12.5px] text-muted">Solo lectura: tu rol no puede editar este horario.</p>
      ) : null}
      {asking ? (
        <DiscardChanges
          onKeep={() => {
            setAsking(false);
            nav.forget();
          }}
          onDiscard={() => {
            setAsking(false);
            setEditing(false);
            setResult(null);
            setWeek(initialWeek);
            setInherit(inheritsNow);
            if (nav.hasPending()) nav.follow();
          }}
        />
      ) : null}
    </section>
  );
}

/** A 07–22 track: the working span, its breaks as gaps. Visual only. */
function DayTrack({ day, muted }: { day: Day; muted: boolean }) {
  const lo = 7 * 60;
  const hi = 22 * 60;
  const pct = (t: string) => Math.min(100, Math.max(0, ((mins(t) - lo) / (hi - lo)) * 100));
  return (
    <div aria-hidden className="relative h-6 rounded-[8px] bg-chip">
      <span className={`absolute inset-y-1 rounded-[6px] ${muted ? "bg-line-strong" : "bg-foreground"}`} style={{ left: `${pct(day.start)}%`, width: `${pct(day.end) - pct(day.start)}%` }} />
      {day.breaks.map((b, i) => (
        <span key={i} className="u-sch-break absolute inset-y-1 rounded-[4px]" style={{ left: `${pct(b.start)}%`, width: `${pct(b.end) - pct(b.start)}%` }} />
      ))}
    </div>
  );
}

function shortWeek(w: Week): string {
  const open = ORDER.filter((wd) => w[wd].open);
  if (open.length === 0) return "cerrada";
  const first = w[open[0]];
  const same = open.every((wd) => w[wd].start === first.start && w[wd].end === first.end);
  const short = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
  return same ? `${short[open[0]]}–${short[open[open.length - 1]]} ${first.start}–${first.end}` : `${open.length} días`;
}

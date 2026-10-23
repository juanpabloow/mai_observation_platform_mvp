"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { saveWeeklyScheduleAction, type ScheduleWriteResult, type SeriesView } from "@/lib/scheduleSeriesActions";
import { useNavigationGuard } from "@/components/ui/module/useEditorGuard";
import { DiscardChanges } from "@/components/ui/module/ConfirmLayer";
import { Button } from "../ui/system";
import { AffectedList, type AffectedItem } from "../agenda/ScheduleFormParts";

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
  /** Open straight in the editor (Horarios: «Editar horario» of the site). */
  autoEdit?: boolean;
  /** The editor was left without saving (Horarios hides it again). */
  onCancel?: () => void;
  /** «Cambiar la pausa de una fecha» — opens one date's break (BreakWeekPanel). */
  onChangeOneDate?: () => void;
}) {
  const isStaff = props.staffId !== null;
  const inheritsNow = isStaff && Object.keys(props.hours).length === 0;
  const initialWeek = useMemo(
    () => weekFrom(inheritsNow ? props.siteHours : props.hours, inheritsNow ? props.siteSeries ?? [] : props.series, props.today),
    [inheritsNow, props.hours, props.siteHours, props.series, props.siteSeries, props.today],
  );
  const siteWeek = useMemo(() => weekFrom(props.siteHours, props.siteSeries ?? [], props.today), [props.siteHours, props.siteSeries, props.today]);
  const [draftInherit, setInherit] = useState(inheritsNow);
  const [draftWeek, setWeek] = useState<Week>(initialWeek);
  const [editing, setEditingState] = useState(Boolean(props.autoEdit));
  // Outside editing the STORED week is shown (it follows refreshes); starting an edit copies
  // it into the draft, so nothing has to be re-synced from an effect.
  const week = editing ? draftWeek : initialWeek;
  const inherit = editing ? draftInherit : inheritsNow;
  const setEditing = (v: boolean) => {
    if (v && !editing) {
      setWeek(initialWeek.map((d) => ({ ...d, breaks: [...d.breaks] })));
      setInherit(inheritsNow);
    }
    setEditingState(v);
  };
  const [result, setResult] = useState<ScheduleWriteResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [pending, startTransition] = useTransition();
  const sending = useRef(false);

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
    const base = editing ? draftWeek : initialWeek;
    setWeek(base.map((d, i) => (i === wd ? { ...d, ...patch } : d)));
    if (!editing) {
      setInherit(inheritsNow);
      setEditingState(true);
    }
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
    else {
      setEditing(false);
      setResult(null);
      props.onCancel?.();
    }
  };

  const headId = `wse-${props.staffId ?? "site"}`;
  const openDays = week.filter((d) => d.open).length;
  // One date's break is changed from here only for the professional's OWN breaks; an
  // inherited break is the whole site's (Horarios y ausencias).
  const anyBreak = !inheritsNow && initialWeek.some((d) => d.open && d.breaks.length > 0);

  // ── READ (reference E2 f11/f14): the week as a list; the edit starts from a button. ──
  if (!editing && isStaff) {
    return (
      <section aria-labelledby={headId} className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <h3 id={headId} className="min-w-0 flex-1 text-[15px] font-medium">Horario semanal</h3>
          {props.canEdit ? (
            <button
              type="button"
              onClick={() => {
                setEditing(true);
                if (inheritsNow) {
                  setInherit(false);
                  setWeek(siteWeek.map((d) => ({ ...d, breaks: [...d.breaks] })));
                }
              }}
              className="u-focus inline-flex h-[36px] items-center rounded-[10px] border border-[var(--line-strong)] bg-[var(--surface)] px-3.5 text-[13.5px] font-medium hover:bg-[var(--subtle)]"
            >
              {inheritsNow ? "Definir horario propio" : "Editar horario"}
            </button>
          ) : null}
        </div>
        {inheritsNow ? (
          <p className="rounded-[10px] bg-[var(--chip)] px-3 py-2.5 text-[13px] leading-[1.45] text-[var(--ag-ink2)]">
            Atiende en el horario habitual de {props.siteName}. Si la sede cambia su horario, este también cambia. Esto no significa que esté ausente.
          </p>
        ) : null}
        <ul className="flex flex-col">
          {ORDER.map((wd) => {
            const d = (inheritsNow ? siteWeek : initialWeek)[wd];
            return (
              <li key={wd} className={`grid grid-cols-[128px_minmax(0,1fr)_minmax(0,1fr)] gap-2 py-2.5 text-[13.5px] shadow-[inset_0_-1px_0_var(--line-soft)] ${d.open ? (inheritsNow ? "text-[var(--ag-ink2)]" : "") : "text-muted"}`}>
                <span className="text-foreground">{NAMES[wd]}</span>
                <span className="tabular-nums">{d.open ? `${d.start} – ${d.end}` : inheritsNow ? "Sede cerrada" : "No trabaja"}</span>
                <span className="text-[12.5px] tabular-nums text-muted">{d.open && d.breaks.length ? d.breaks.map((b) => `Pausa ${b.start} – ${b.end}`).join(" · ") : ""}</span>
              </li>
            );
          })}
        </ul>
        {props.onChangeOneDate && anyBreak ? (
          <button type="button" onClick={props.onChangeOneDate} className="u-focus inline-flex h-[32px] self-start items-center rounded-[9px] border border-[var(--line-strong)] bg-[var(--surface)] px-3 text-[13px] hover:bg-[var(--subtle)]">
            Cambiar la pausa de una fecha
          </button>
        ) : null}
        {!props.canEdit ? <p className="text-[12.5px] text-muted">Solo lectura: tu rol no puede editar este horario.</p> : null}
      </section>
    );
  }

  // ── EDIT (reference f12 / f24): the week on a 07–22 timeline. Drag a bar's edges or the
  // bar (15 min); every handle is also a keyboard slider. Breaks are the hatched parts. ──
  return (
    <section aria-labelledby={headId} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h3 id={headId} className="text-[15px] font-medium">
          Horario semanal
        </h3>
        {isStaff ? (
          <label className="flex items-center gap-2.5 text-[13px] text-muted">
            <span aria-hidden className="h-4 w-px bg-[var(--line)]" />
            Atiende con
            <select
              aria-label="Origen del horario"
              disabled={!props.canEdit}
              value={inherit ? "site" : "own"}
              onChange={(e) => {
                setResult(null);
                const own = e.target.value === "own";
                setInherit(!own);
                if (own && inheritsNow) setWeek(siteWeek.map((d) => ({ ...d, breaks: [...d.breaks] })));
              }}
              className="u-focus h-[36px] rounded-[10px] bg-[var(--chip)] px-2.5 text-[14px] text-foreground"
            >
              <option value="site">el horario de la sede</option>
              <option value="own">un horario propio</option>
            </select>
            <span className="text-[12.5px]">{inherit ? `${props.siteName}: ${shortWeek(siteWeek)}` : "Días y horas a medida"}</span>
          </label>
        ) : null}
      </div>

      <div className="flex flex-col rounded-[14px] px-6 pb-3 pt-5 shadow-[inset_0_0_0_1px_var(--line)]">
        <div className="flex items-end gap-3 pb-3">
          <span className="min-w-0 flex-1 text-[13px] text-muted">
            {inherit ? "Hereda el horario de la sede · se edita en Horarios y ausencias" : "Arrastra los bordes o la barra · intervalos de 15 min · flechas del teclado en cada borde"}
          </span>
          <span className="text-[13px] text-muted">
            <span className="text-[24px] font-medium tabular-nums text-foreground">{Math.round(total * 10) / 10} h</span> / semana
          </span>
        </div>
        <div aria-hidden className="grid grid-cols-[160px_minmax(0,1fr)_88px_44px] gap-4 pb-1.5">
          <span />
          <span className="relative h-4 text-[12px] tabular-nums text-muted">
            {[7, 10, 13, 16, 19, 22].map((h) => (
              <span key={h} className="absolute -translate-x-1/2" style={{ left: `${((h - 7) / 15) * 100}%` }}>
                {String(h).padStart(2, "0")}
              </span>
            ))}
          </span>
          <span />
          <span />
        </div>
        <ul className="flex flex-col">
          {ORDER.map((wd) => {
            const d = shown[wd];
            const readOnly = !props.canEdit || inherit;
            const wrong = !readOnly && d.open && (mins(d.end) <= mins(d.start) || d.breaks.some((b) => mins(b.start) <= mins(d.start) || mins(b.end) >= mins(d.end) || mins(b.end) <= mins(b.start)));
            return (
              <li key={wd} className="grid grid-cols-[160px_minmax(0,1fr)_88px_44px] items-center gap-4 py-2">
                <span className="flex flex-col">
                  <span className={`text-[14px] ${d.open ? "" : "text-muted"}`}>{NAMES[wd]}</span>
                  {!readOnly ? (
                    <button
                      type="button"
                      onClick={() => setDay(wd, d.open ? { open: false, breaks: [] } : { open: true })}
                      className="u-focus self-start rounded text-[12.5px] text-[var(--ag-ink2)] underline underline-offset-2"
                    >
                      {d.open ? (isStaff ? "Marcar libre" : "Cerrar este día") : isStaff ? "Trabaja este día" : "Abrir este día"}
                    </button>
                  ) : null}
                </span>
                <span className="flex min-w-0 flex-col gap-1">
                  {d.open ? (
                    <TimelineDay day={d} name={NAMES[wd]} editable={!readOnly} onChange={(patch) => setDay(wd, patch)} />
                  ) : (
                    <button
                      type="button"
                      disabled={readOnly}
                      onClick={() => setDay(wd, { open: true })}
                      className="u-focus flex h-[40px] items-center justify-center rounded-[10px] text-[13px] text-muted shadow-[inset_0_0_0_1px_var(--line-strong)] [border-style:dashed] disabled:cursor-default"
                      style={{ boxShadow: "none", border: "1px dashed var(--line-strong)" }}
                    >
                      {isStaff ? "No trabaja" : "Cerrado"}
                      {!readOnly ? " · toca para abrir" : ""}
                    </button>
                  )}
                  {d.open && d.breaks.length > 0 && !readOnly ? (
                    <span className="flex flex-wrap gap-1.5">
                      {d.breaks.map((b, i) => (
                        <span key={i} className="inline-flex h-[24px] items-center gap-1 rounded-[6px] bg-[var(--chip)] pl-2 text-[12px] tabular-nums text-[var(--ag-ink2)]">
                          Pausa {b.start}–{b.end}
                          <button type="button" aria-label={`Quitar la pausa de ${b.start} del ${NAMES[wd].toLowerCase()}`} onClick={() => setDay(wd, { breaks: d.breaks.filter((_, j) => j !== i) })} className="u-focus grid size-[24px] place-items-center rounded-[6px] hover:bg-[var(--subtle)]">
                            ×
                          </button>
                        </span>
                      ))}
                    </span>
                  ) : null}
                  {wrong ? <span role="alert" className="text-[12.5px] text-danger">Revisa este día: el fin va después del inicio y las pausas quedan dentro del horario.</span> : null}
                </span>
                <span>
                  {d.open && !readOnly ? (
                    <button
                      type="button"
                      onClick={() => {
                        const mid = Math.floor((mins(d.start) + mins(d.end)) / 2 / 30) * 30;
                        setDay(wd, { breaks: [...d.breaks, { start: hm(mid), end: hm(Math.min(mid + 60, mins(d.end) - 15)) }].sort((a, b) => a.start.localeCompare(b.start)) });
                      }}
                      className="u-focus h-[32px] rounded-[8px] px-2 text-[13px] text-foreground hover:bg-[var(--subtle)]"
                    >
                      + Pausa
                    </button>
                  ) : null}
                </span>
                <span className="text-right text-[13px] tabular-nums text-muted">{d.open ? `${Math.round(dayHours(d) * 10) / 10} h` : isStaff ? "" : "Cerrado"}</span>
              </li>
            );
          })}
        </ul>
        <div className="mt-2 flex items-center gap-3 border-t border-[var(--line)] pt-3">
          <span className="min-w-0 flex-1 text-[13px] text-muted">
            {openDays} {openDays === 1 ? "día abierto" : "días abiertos"} · rayado = pausa
          </span>
          {props.canEdit && !inherit ? (
            <button
              type="button"
              onClick={() => {
                const mon = week[1];
                setResult(null);
                setWeek(week.map((d, i) => (i === 1 || !d.open ? d : { ...d, start: mon.start, end: mon.end, breaks: mon.breaks.map((b) => ({ ...b })) })));
              }}
              className="u-focus inline-flex h-[36px] items-center rounded-[10px] border border-[var(--line-strong)] bg-[var(--surface)] px-3.5 text-[13.5px] hover:bg-[var(--subtle)]"
            >
              Copiar lunes a todos
            </button>
          ) : null}
        </div>
      </div>

      {affected && affected.length > 0 ? (
        <AffectedList
          items={affected}
          preexisting={result && result.ok ? (result.preexisting as AffectedItem[]) : null}
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

      {props.canEdit ? (
        <div className="sticky bottom-0 z-10 -mx-6 flex items-center gap-2 border-t border-[var(--line)] bg-[var(--surface)] px-6 py-3">
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
      ) : (
        <p className="text-[12.5px] text-muted">Solo lectura: tu rol no puede editar este horario.</p>
      )}
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
            else props.onCancel?.();
          }}
        />
      ) : null}
    </section>
  );
}

/**
 * One day on the reference's 07–22 track (HK.blanco): the working span is the dark bar
 * (its range written inside), the breaks are hatched. Pointer: drag an edge to resize, the
 * bar to move it, a break to move it — all in 15-minute steps, kept inside 07–22 and with
 * the breaks inside the day. Keyboard: each edge, the bar and each break is a slider
 * (← → = 15 min, Shift = 1 h; on a break Supr removes it).
 */
const LO = 7 * 60;
const HI = 22 * 60;
const STEP = 15;
function TimelineDay({ day, name, editable, onChange }: { day: Day; name: string; editable: boolean; onChange: (patch: Partial<Day>) => void }) {
  const pct = (m: number) => ((Math.min(HI, Math.max(LO, m)) - LO) / (HI - LO)) * 100;
  const s0 = mins(day.start);
  const e0 = mins(day.end);
  const clampSpan = (s: number, e: number) => {
    const minLen = 30;
    let a = Math.round(s / STEP) * STEP;
    let b = Math.round(e / STEP) * STEP;
    a = Math.max(LO, Math.min(a, HI - minLen));
    b = Math.min(HI, Math.max(b, a + minLen));
    return [a, b] as const;
  };
  // Breaks follow the day when it moves; a resize trims nothing silently (validation says so).
  const apply = (s: number, e: number, kind: "start" | "end" | "move") => {
    const [a, b] = clampSpan(s, e);
    const shift = kind === "move" ? a - s0 : 0;
    onChange({ start: hm(a), end: hm(b), breaks: shift ? day.breaks.map((x) => ({ start: hm(mins(x.start) + shift), end: hm(mins(x.end) + shift) })) : day.breaks });
  };
  const moveBreak = (i: number, delta: number) => {
    const bs = mins(day.breaks[i].start);
    const be = mins(day.breaks[i].end);
    const len = be - bs;
    const ns = Math.max(s0 + STEP, Math.min(bs + delta, e0 - STEP - len));
    onChange({ breaks: day.breaks.map((x, j) => (j === i ? { start: hm(ns), end: hm(ns + len) } : x)) });
  };
  const drag = (e: React.PointerEvent, onDelta: (deltaMin: number) => void) => {
    const track = (e.currentTarget as HTMLElement).closest<HTMLElement>("[data-track]");
    if (!editable || !track) return;
    e.preventDefault();
    e.stopPropagation();
    const width = track.getBoundingClientRect().width;
    const x0 = e.clientX;
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const onMove = (ev: PointerEvent) => onDelta(Math.round((((ev.clientX - x0) / width) * (HI - LO)) / STEP) * STEP);
    const onUp = () => {
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
      target.removeEventListener("pointercancel", onUp);
    };
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
    target.addEventListener("pointercancel", onUp);
  };
  const keys = (e: React.KeyboardEvent, onDelta: (d: number) => void, onDelete?: () => void) => {
    if (!editable) return;
    const step = e.shiftKey ? 60 : STEP;
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") onDelta(-step);
    else if (e.key === "ArrowRight" || e.key === "ArrowUp") onDelta(step);
    else if ((e.key === "Delete" || e.key === "Backspace") && onDelete) onDelete();
    else return;
    e.preventDefault();
  };
  const handle = (edge: "start" | "end") => (
    <span
      role="slider"
      tabIndex={editable ? 0 : -1}
      aria-label={`${name}: ${edge === "start" ? "inicio" : "fin"}`}
      aria-valuemin={LO}
      aria-valuemax={HI}
      aria-valuenow={edge === "start" ? s0 : e0}
      aria-valuetext={edge === "start" ? day.start : day.end}
      onPointerDown={(e) => drag(e, (d) => (edge === "start" ? apply(s0 + d, e0, "start") : apply(s0, e0 + d, "end")))}
      onKeyDown={(e) => keys(e, (d) => (edge === "start" ? apply(s0 + d, e0, "start") : apply(s0, e0 + d, "end")))}
      className={`u-focus absolute inset-y-[6px] z-[2] w-[10px] ${edge === "start" ? "left-0" : "right-0"} flex cursor-ew-resize items-center justify-center rounded-[4px]`}
    >
      <span aria-hidden className="h-[16px] w-[3px] rounded-full bg-[var(--ag-bar-handle)]" />
    </span>
  );
  return (
    <div data-track="" className="relative h-[40px] rounded-[10px] bg-[var(--chip)]">
      {[10, 13, 16, 19].map((h) => (
        <span key={h} aria-hidden className="absolute inset-y-0 w-px bg-[var(--surface)] opacity-60" style={{ left: `${pct(h * 60)}%` }} />
      ))}
      <div
        role="slider"
        tabIndex={editable ? 0 : -1}
        aria-label={`${name}: horario ${day.start}–${day.end} (mover)`}
        aria-valuemin={LO}
        aria-valuemax={HI}
        aria-valuenow={s0}
        aria-valuetext={`${day.start}–${day.end}`}
        onPointerDown={(e) => drag(e, (d) => apply(s0 + d, e0 + d, "move"))}
        onKeyDown={(e) => keys(e, (d) => apply(s0 + d, e0 + d, "move"))}
        className={`u-focus absolute inset-y-[4px] flex items-center justify-center overflow-hidden rounded-[8px] bg-[var(--ag-bar)] text-[12.5px] tabular-nums text-[var(--ag-bar-ink)] ${editable ? "cursor-grab active:cursor-grabbing" : ""}`}
        style={{ left: `${pct(s0)}%`, width: `${pct(e0) - pct(s0)}%` }}
      >
        <span className="pointer-events-none relative z-[4] truncate rounded-[4px] bg-[var(--ag-bar)] px-1.5">{day.start}–{day.end}</span>
        {editable ? handle("start") : null}
        {editable ? handle("end") : null}
      </div>
      {day.breaks.map((b, i) => (
        <span
          key={i}
          role="slider"
          tabIndex={editable ? 0 : -1}
          aria-label={`${name}: pausa ${b.start}–${b.end} (mover; Supr la quita)`}
          aria-valuemin={LO}
          aria-valuemax={HI}
          aria-valuenow={mins(b.start)}
          aria-valuetext={`${b.start}–${b.end}`}
          title={`Pausa ${b.start}–${b.end}`}
          onPointerDown={(e) => drag(e, (d) => moveBreak(i, d))}
          onKeyDown={(e) => keys(e, (d) => moveBreak(i, d), () => onChange({ breaks: day.breaks.filter((_, j) => j !== i) }))}
          className={`u-focus u-ag-hatch absolute inset-y-[4px] z-[3] rounded-[4px] ${editable ? "cursor-grab" : ""}`}
          style={{ left: `${pct(mins(b.start))}%`, width: `${pct(mins(b.end)) - pct(mins(b.start))}%` }}
        />
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

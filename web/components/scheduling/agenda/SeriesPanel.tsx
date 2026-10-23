"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { deleteSeriesAction, editSeriesAction, listScheduleSeriesAction, type ScheduleWriteResult, type SeriesView } from "@/lib/scheduleSeriesActions";
import type { PublicAbsenceReason } from "@/lib/publicAbsenceReason";
import { draftHolds } from "@/lib/scheduleDraft";
import { fmtTime, todayAtSite } from "@/lib/siteCalendar";
import { ConfirmLayer } from "@/components/ui/module/ConfirmLayer";
import { Button, INPUT } from "../ui/system";
import { PublicReasonField } from "../timeoff/PublicReasonField";
import { SidePanel, PanelSection, type SidePanelHandle } from "./SidePanel";
import { AffectedList, Choice, FieldRow, ScopeChooser, TimeSelect, WeekdayPicker, type AffectedItem, type Scope } from "./ScheduleFormParts";

/**
 * ONE OCCURRENCE of a usual break or a recurring block, opened from the calendar, Equipo or
 * Horarios. It opens with THIS date's effective values (an exception's own times, not the
 * series'), says when the date has an exception and offers «Volver al horario habitual».
 *
 * Every change asks WHAT it applies to — only this date, this and the following, or the
 * whole future series — and the engine (scheduleSeriesActions → src/scheduling/series.ts)
 * never rewrites anything that already started. The affected appointments are recalculated
 * for the scope on screen; each can be rescheduled and you come back here with what you
 * typed. Saving with appointments still inside asks for an explicit «Guardar igualmente».
 */
export interface OccurrenceRef {
  seriesId: string;
  kind: "break" | "block";
  staffId: string | null;
  date: string;
  startsAt: string;
  endsAt: string;
  moved: boolean;
}

const WD = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const MON = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
function dLabel(d: string, long = false): string {
  const [, m, day] = d.split("-").map(Number);
  const w = WD[new Date(`${d}T00:00:00Z`).getUTCDay()];
  return `${long ? w : w.slice(0, 3)} ${day} ${MON[m - 1]}`;
}

export function SeriesPanel(props: {
  clientId: string;
  siteId: string;
  timezone: string;
  occ: OccurrenceRef;
  ownerName: string | null;
  /** May this login edit this series (the server re-checks). */
  canEdit: boolean;
  onClose: () => void;
  onSaved: (message: string) => void;
  /** Reschedule one affected appointment with this draft discounted; the panel stays mounted. */
  onReschedule: (item: AffectedItem, holds: string[]) => void;
  /** Bumped by the parent after a reschedule (or its cancel/failure) → recalculate. */
  recheck: number;
  hidden?: boolean;
}) {
  const { occ, timezone: tz } = props;
  const isBreak = occ.kind === "break";
  const [series, setSeries] = useState<SeriesView | null | "missing">(null);
  const [loadError, setLoadError] = useState(false);
  const initialStart = fmtTime(occ.startsAt, tz);
  const initialEnd = occ.endsAt && fmtTime(occ.endsAt, tz) === "00:00" ? "24:00" : fmtTime(occ.endsAt, tz);
  const [action, setAction] = useState<"move" | "remove">("move");
  const [start, setStart] = useState(initialStart);
  const [end, setEnd] = useState(initialEnd);
  const [scope, setScope] = useState<Scope>("date");
  const [weekdays, setWeekdays] = useState<number[]>([]);
  const [endsOn, setEndsOn] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [publicReason, setPublicReason] = useState<PublicAbsenceReason | null>(null);
  const [previewState, setPreview] = useState<{ forKey: string; loading: boolean; result: ScheduleWriteResult | null; error: boolean }>({ forKey: "", loading: false, result: null, error: false });
  const [ask, setAsk] = useState<null | "save" | "delete">(null);
  const [deleteScope, setDeleteScope] = useState<Scope>("date");
  const [deletePreviewState, setDeletePreview] = useState<{ forKey: string; lines: string[] } | null>(null);
  const deleteKey = `${deleteScope}`;
  const deletePreview = deletePreviewState && deletePreviewState.forKey === deleteKey ? deletePreviewState.lines : null;
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const sending = useRef(false);
  const handle = useRef<SidePanelHandle | null>(null);

  const load = useCallback(() => {
    listScheduleSeriesAction(props.clientId, props.siteId)
      .then((r) => {
        setLoadError(!r.ok);
        if (!r.ok) return;
        const s = r.series.find((x) => x.id === occ.seriesId) ?? null;
        setSeries(s ?? "missing");
        if (s) {
          setWeekdays(s.weekdays);
          setEndsOn(s.endsOn);
          setReason(s.reason ?? "");
          setPublicReason((s.publicReason as PublicAbsenceReason | null) ?? null);
        }
      })
      .catch(() => setLoadError(true));
  }, [props.clientId, props.siteId, occ.seriesId]);
  useEffect(load, [load]);

  const usual = series && series !== "missing" ? { start: series.start, end: series.end } : null;
  const [openedAt] = useState(() => Date.now());
  const past = Date.parse(occ.startsAt) <= openedAt;
  const canWrite = props.canEdit && !past && series !== null && series !== "missing";
  const dateText = dLabel(occ.date);
  const dirty =
    action === "remove" ||
    start !== initialStart ||
    end !== initialEnd ||
    (series && series !== "missing" && (weekdays.join() !== series.weekdays.join() || endsOn !== series.endsOn || reason !== (series.reason ?? "") || publicReason !== (series.publicReason ?? null)));
  const scopeOnlyDate = scope === "date";
  const timesValid = end > start;

  // Affected appointments for the scope on screen (dry run — nothing is written).
  const req = useMemo(
    () => ({
      clientId: props.clientId,
      seriesId: occ.seriesId,
      date: occ.date,
      scope,
      start,
      end,
      ...(scopeOnlyDate || isBreak ? {} : { weekdays, endsOn, reason, publicReason }),
    }),
    [props.clientId, occ.seriesId, occ.date, scope, start, end, scopeOnlyDate, isBreak, weekdays, endsOn, reason, publicReason],
  );
  const reqKey = JSON.stringify([req, props.recheck]);
  const wantsPreview = canWrite && action === "move" && timesValid && Boolean(dirty);
  // Each answer is tagged with the request it answers: "loading" and "nothing to show" are derived.
  const preview = !wantsPreview
    ? { loading: false, result: null as ScheduleWriteResult | null, error: false }
    : previewState.forKey === reqKey
      ? previewState
      : { loading: true, result: previewState.result, error: false };
  useEffect(() => {
    if (!wantsPreview) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const r = await editSeriesAction({ ...req, dryRun: true });
        if (!cancelled) setPreview({ forKey: reqKey, loading: false, result: r, error: false });
      } catch {
        if (!cancelled) setPreview({ forKey: reqKey, loading: false, result: null, error: true });
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // props.recheck: recalculated after coming back from a reschedule.
  }, [reqKey, wantsPreview]); // eslint-disable-line react-hooks/exhaustive-deps

  const affected: AffectedItem[] | null = preview.result && preview.result.ok ? preview.result.affected : null;
  const planError = preview.result && !preview.result.ok ? preview.result.error : null;
  const summary = preview.result && preview.result.ok ? preview.result.summary : null;

  const holds = () => {
    const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
    return draftHolds({
      staffId: occ.staffId,
      timeZone: tz,
      weekdays: scopeOnlyDate ? [new Date(`${occ.date}T00:00:00Z`).getUTCDay()] : weekdays,
      startMin: toMin(start),
      endMin: toMin(end),
      startsOn: scope === "future" ? todayAtSite(tz) : occ.date,
      endsOn: scopeOnlyDate ? occ.date : endsOn,
    });
  };

  const save = (confirm: boolean) => {
    if (sending.current) return;
    sending.current = true;
    setError(null);
    startTransition(async () => {
      try {
        const r = await editSeriesAction({ ...req, confirm });
        if (!r.ok) return setError(r.error);
        if (!r.written) {
          // Appointments appeared since the preview: show them, ask again.
          setPreview({ forKey: reqKey, loading: false, result: r, error: false });
          setAsk(null);
          return;
        }
        props.onSaved(scopeOnlyDate ? `${isBreak ? "Pausa" : "Bloqueo"} cambiado solo el ${dateText}` : "Cambios guardados");
      } catch {
        setError("No se pudo guardar. Tus cambios siguen aquí; vuelve a intentarlo.");
      } finally {
        sending.current = false;
        setAsk(null);
      }
    });
  };

  const backToUsual = () => {
    if (!usual || sending.current) return;
    sending.current = true;
    setError(null);
    startTransition(async () => {
      try {
        const r = await editSeriesAction({ clientId: props.clientId, seriesId: occ.seriesId, date: occ.date, scope: "date", start: usual.start, end: usual.end, confirm: true });
        if (!r.ok) return setError(r.error);
        props.onSaved(`${dateText}: vuelve al horario habitual`);
      } catch {
        setError("No se pudo guardar. Vuelve a intentarlo.");
      } finally {
        sending.current = false;
      }
    });
  };

  useEffect(() => {
    if (ask !== "delete") return;
    let cancelled = false;
    const key = `${deleteScope}`;
    deleteSeriesAction({ clientId: props.clientId, seriesId: occ.seriesId, date: occ.date, scope: deleteScope, dryRun: true })
      .then((r) => !cancelled && setDeletePreview({ forKey: key, lines: r.ok ? r.summary?.lines ?? [] : [r.error] }))
      .catch(() => !cancelled && setDeletePreview({ forKey: key, lines: ["No pudimos calcular el efecto. Puedes intentarlo igual."] }));
    return () => {
      cancelled = true;
    };
  }, [ask, deleteScope, props.clientId, occ.seriesId, occ.date]);

  const remove = () => {
    if (sending.current) return;
    sending.current = true;
    setError(null);
    startTransition(async () => {
      try {
        const r = await deleteSeriesAction({ clientId: props.clientId, seriesId: occ.seriesId, date: occ.date, scope: deleteScope });
        if (!r.ok) return setError(r.error);
        props.onSaved(deleteScope === "date" ? `Se quitó solo el ${dateText}` : "Serie terminada desde esa fecha");
      } catch {
        setError("No se pudo eliminar. Vuelve a intentarlo.");
      } finally {
        sending.current = false;
        setAsk(null);
      }
    });
  };

  const title = isBreak ? (occ.moved || dirty ? `Cambiar la pausa · ${dateText}` : `Pausa habitual · ${dateText}`) : `Bloqueo${series && series !== "missing" && series.reason ? ` · ${series.reason}` : ""}`;
  const subtitle = [props.ownerName ?? "Toda la sede", isBreak ? "horario propio" : `${dateText} · ${initialStart} – ${initialEnd}`].join(" · ");
  const n = affected?.length ?? 0;
  const plural = (d: number) => (d === 0 || d === 6 ? `${WD[d]}s` : WD[d]);
  const occWd = new Date(`${occ.date}T00:00:00Z`).getUTCDay();
  const scopeHints = isBreak
    ? {
        date: `${dLabel(occ.date)}. Los demás ${plural(occWd)} siguen a las ${usual?.start ?? initialStart}.`,
        following: `Desde el ${dLabel(occ.date)}, todos los ${plural(occWd)}. Lo anterior no cambia.`,
        future: "Desde hoy, todos los días con pausa. Lo anterior no cambia.",
      }
    : undefined;

  return (
    <div hidden={props.hidden}>
      <SidePanel
        name="series"
        title={title}
        subtitle={subtitle}
        dirty={Boolean(dirty) && canWrite}
        covered={ask !== null}
        onClose={props.onClose}
        handleRef={handle}
        footer={
          canWrite ? (
            <div className="flex flex-wrap items-center gap-2">
              {n > 0 ? <span className="w-full text-[12.5px] text-[var(--warn)] sm:hidden">{n} {n === 1 ? "cita requiere" : "citas requieren"} revisión</span> : null}
              <button type="button" className="u-focus min-h-[44px] rounded px-1 text-[13px] font-medium text-danger hover:underline md:min-h-0" onClick={() => setAsk("delete")} disabled={pending}>
                {isBreak ? "Quitar la pausa" : "Eliminar"}
              </button>
              <span className="hidden min-w-0 flex-1 truncate text-[12.5px] text-[var(--warn)] sm:block">{n > 0 ? `${n} ${n === 1 ? "cita requiere" : "citas requieren"} revisión` : ""}</span>
              <span className="flex-1 sm:hidden" />
              <Button onClick={() => handle.current?.requestClose()} disabled={pending}>
                Cancelar
              </Button>
              <Button
                variant="primary"
                disabled={!dirty || !timesValid || pending || Boolean(planError) || action === "remove"}
                loading={pending}
                loadingLabel="Guardando…"
                onClick={() => setAsk("save")}
              >
                {n > 0 ? "Guardar igualmente" : error ? "Reintentar" : "Guardar"}
              </Button>
            </div>
          ) : (
            <div className="flex justify-end">
              <Button onClick={props.onClose}>Cerrar</Button>
            </div>
          )
        }
      >
        {loadError ? (
          <div className="flex items-center gap-3 text-[13px] text-muted">
            No pudimos cargar la serie.
            <Button size="sm" onClick={() => void load()}>Reintentar</Button>
          </div>
        ) : series === null ? (
          <div aria-busy="true" className="flex flex-col gap-2">
            <div className="h-[64px] rounded-[12px] bg-subtle" />
            <div className="h-24 rounded-[12px] bg-subtle" />
          </div>
        ) : (
          <div className="flex flex-col">
            <PanelSection title={isBreak ? "Pausa habitual" : "Serie"} id="series-summary">
              <dl className="grid grid-cols-[6.5rem_1fr] gap-x-3 gap-y-1.5 rounded-[12px] bg-subtle px-3.5 py-3 text-[13px]">
                <dt className="text-muted">{isBreak ? "Habitual" : "Serie"}</dt>
                <dd>{series === "missing" ? "Ya no existe" : `${series.weekdays.length === 7 ? "Todos los días" : `Cada ${series.weekdays.map((d) => WD[d]).join(", ")}`} · ${series.start} – ${series.end}${series.endsOn ? ` · hasta el ${dLabel(series.endsOn)}` : " · sin fecha de fin"}`}</dd>
                <dt className="text-muted">Afecta a</dt>
                <dd>{props.ownerName ?? "Toda la sede"}</dd>
                <dt className="text-muted">Esta fecha</dt>
                <dd className="flex flex-wrap items-center gap-2">
                  <span className="u-tnum">{dLabel(occ.date, true)} · {initialStart} – {initialEnd}</span>
                  {occ.moved ? <span className="rounded-full bg-[var(--warn-soft)] px-2 py-0.5 text-[11.5px] font-medium text-[var(--warn)]">Tiene una excepción</span> : null}
                </dd>
                {isBreak ? (
                  <>
                    <dt className="text-muted">Dónde vive</dt>
                    <dd>En el horario semanal. No es un bloqueo aparte.</dd>
                  </>
                ) : null}
              </dl>
              {occ.moved && usual && canWrite ? (
                <div>
                  <Button size="sm" onClick={backToUsual} disabled={pending}>
                    Volver al horario habitual ({usual.start} – {usual.end})
                  </Button>
                </div>
              ) : null}
              {past ? <p className="text-[13px] text-muted">Esta fecha ya empezó: se conserva en el historial y no se modifica.</p> : null}
              {!props.canEdit && !past ? <p className="text-[13px] text-muted">Solo lectura: tu rol no puede editar este horario.</p> : null}
            </PanelSection>

            {canWrite ? (
              <>
                {isBreak ? (
                  <PanelSection title="Qué quieres hacer" id="series-action">
                    <Choice
                      label="Qué quieres hacer"
                      hideLabel
                      value={action}
                      onChange={(v) => {
                        setAction(v);
                        if (v === "remove") {
                          setDeleteScope(scope);
                          setAsk("delete");
                          setAction("move");
                        }
                      }}
                      options={[
                        { value: "move", label: "Mover la pausa" },
                        { value: "remove", label: "Quitar la pausa" },
                      ]}
                    />
                  </PanelSection>
                ) : null}

                <PanelSection title={isBreak ? "Nueva hora de la pausa" : "Horario"} id="series-times">
                  <div className="flex items-center gap-2">
                    <TimeSelect label="Desde" value={start} onChange={setStart} />
                    <span aria-hidden className="text-muted">–</span>
                    <TimeSelect label="Hasta" value={end} onChange={setEnd} />
                  </div>
                  {!timesValid ? <span role="alert" className="text-[12.5px] text-danger">La hora de fin debe ser posterior a la de inicio.</span> : null}
                  {isBreak && usual ? <BreakBar usual={usual} next={{ start, end }} /> : null}
                </PanelSection>

                <PanelSection title="Aplicar a" id="series-scope">
                  <ScopeChooser value={scope} onChange={setScope} dateLabel={dateText} hints={scopeHints} legend=" " />
                </PanelSection>

                {!scopeOnlyDate && !isBreak ? (
                  <PanelSection title="Repetición y motivo" id="series-more" hint="Solo cambian desde la fecha de corte; lo anterior se conserva.">
                    <WeekdayPicker value={weekdays} onChange={setWeekdays} error={weekdays.length === 0 ? "Elige al menos un día." : null} />
                    <FieldRow label="Termina" hint="Vacío = sin fecha de fin.">
                      <input type="date" className={INPUT} value={endsOn ?? ""} min={occ.date} onChange={(e) => setEndsOn(e.target.value || null)} />
                    </FieldRow>
                    <FieldRow label={<>Motivo interno <span className="font-normal text-muted">· solo lo ve el equipo</span></>}>
                      <input className={INPUT} value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} placeholder="Ej. Formación interna" />
                    </FieldRow>
                    <PublicReasonField scope={occ.staffId ? "staff" : "site"} value={publicReason} onChange={setPublicReason} who={props.ownerName} />
                  </PanelSection>
                ) : null}

                <PanelSection title="Citas afectadas" id="series-affected">
                  {!dirty ? (
                    <p className="text-[13px] text-muted">Cambia la hora o el alcance para ver qué citas quedarían dentro.</p>
                  ) : planError ? (
                    <p role="alert" className="text-[13px] text-danger">{planError}</p>
                  ) : (
                    <AffectedList
                      items={affected}
                      preexisting={preview.result && preview.result.ok ? preview.result.preexisting : null}
                      loading={preview.loading}
                      error={preview.error ? "x" : null}
                      timezone={tz}
                      what={isBreak ? "la nueva pausa" : "el bloqueo"}
                      onReschedule={(item) => props.onReschedule(item, holds())}
                      onRetry={() => setPreview({ forKey: "", loading: false, result: null, error: false })}
                    />
                  )}
                  {summary && !scopeOnlyDate ? (
                    <ul className="flex flex-col gap-1 text-[12.5px] text-muted">
                      {summary.lines.map((l) => (
                        <li key={l}>{l}</li>
                      ))}
                    </ul>
                  ) : null}
                </PanelSection>
              </>
            ) : null}
            {error ? <p role="alert" className="mt-3 text-[13px] text-danger">{error}</p> : null}
          </div>
        )}
      </SidePanel>

      {ask === "save" ? (
        <ConfirmLayer
          id="series-save"
          title="¿Guardar los cambios?"
          tone="primary"
          body={
            <span className="flex flex-col gap-1">
              <span>
                Alcance: {scope === "date" ? `solo el ${dateText}` : scope === "following" ? `desde el ${dateText}` : "toda la serie futura"}.
              </span>
              {scopeOnlyDate ? (
                <span>
                  Solo el {dateText}: {start} – {end}. Se guarda como excepción de esa fecha{usual ? `; las demás siguen a las ${usual.start} – ${usual.end}` : ""}.
                </span>
              ) : (
                (summary?.lines ?? []).map((l) => <span key={l}>{l}</span>)
              )}
              {n > 0 ? <span className="font-medium text-[var(--warn)]">{n} {n === 1 ? "cita quedará" : "citas quedarán"} marcadas «Requiere revisión». No se mueven ni se avisa al cliente.</span> : null}
            </span>
          }
          cancelLabel="Volver"
          confirmLabel={n > 0 ? "Guardar igualmente" : "Guardar"}
          pending={pending}
          onCancel={() => setAsk(null)}
          onConfirm={() => save(n > 0)}
        />
      ) : null}
      {ask === "delete" ? (
        <ConfirmLayer
          id="series-delete"
          title={isBreak ? "¿Quitar la pausa?" : "¿Eliminar el bloqueo?"}
          body="El horario vuelve a ofrecerse para reservas."
          cancelLabel="Volver"
          confirmLabel={isBreak ? "Quitar" : "Eliminar"}
          pending={pending}
          onCancel={() => setAsk(null)}
          onConfirm={remove}
        >
          <div className="flex flex-col gap-3">
            <ScopeChooser value={deleteScope} onChange={setDeleteScope} dateLabel={dateText} hints={scopeHints} legend="Alcance" />
            <div className="rounded-[10px] bg-subtle px-3 py-2 text-[12.5px] text-muted">
              {deletePreview === null ? "Calculando…" : deletePreview.map((l) => <p key={l}>{l}</p>)}
            </div>
          </div>
        </ConfirmLayer>
      ) : null}
    </div>
  );
}

/** «Antes / Ahora» for a break on a 10–20 track (R2). */
function BreakBar({ usual, next }: { usual: { start: string; end: string }; next: { start: string; end: string } }) {
  const m = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const lo = Math.min(10 * 60, m(usual.start), m(next.start));
  const hi = Math.max(20 * 60, m(usual.end), m(next.end));
  const pct = (t: string) => ((m(t) - lo) / (hi - lo)) * 100;
  const same = usual.start === next.start && usual.end === next.end;
  return (
    <div className="flex flex-col gap-1.5" aria-hidden>
      <div className="relative h-6 rounded-[8px] bg-chip">
        {!same ? <span className="absolute inset-y-1 rounded-[6px] border border-line-strong bg-surface" style={{ left: `${pct(usual.start)}%`, width: `${pct(usual.end) - pct(usual.start)}%` }} /> : null}
        <span className="absolute inset-y-1 rounded-[6px] bg-foreground" style={{ left: `${pct(next.start)}%`, width: `${Math.max(1, pct(next.end) - pct(next.start))}%` }} />
      </div>
      <div className="flex gap-4 text-[11.5px] text-muted">
        {!same ? <span className="flex items-center gap-1.5"><span className="h-2 w-3 rounded-[3px] border border-line-strong bg-surface" />Antes {usual.start}–{usual.end}</span> : null}
        <span className="flex items-center gap-1.5"><span className="h-2 w-3 rounded-[3px] bg-foreground" />Ahora {next.start}–{next.end}</span>
      </div>
    </div>
  );
}


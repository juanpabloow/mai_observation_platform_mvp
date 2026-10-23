"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { listScheduleSeriesAction, type SeriesView } from "@/lib/scheduleSeriesActions";
import { addDays, siteMidnight, todayAtSite } from "@/lib/siteCalendar";
import { expandSeries, type Occurrence } from "@worker/scheduling/series.js";
import { Button } from "../ui/system";
import { SidePanel, type SidePanelHandle } from "./SidePanel";
import { SeriesPanel, type OccurrenceRef } from "./SeriesPanel";
import type { AffectedItem } from "./ScheduleFormParts";

/**
 * «PAUSA HABITUAL» (reference H3): a usual break opens on the WEEK it belongs to — each day
 * with its effective break (an exception shows its own times and says so) and, on a date
 * that has not started, «Cambiar este día». That opens the edit of THAT date
 * (SeriesPanel: move / remove, and what it applies to); saving comes back here with the
 * exception marked. «Listo» closes. Nothing here writes: SeriesPanel does, through the
 * series engine, which never rewrites a started occurrence.
 */
const DAY = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
const MON = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

export function BreakWeekPanel(props: {
  clientId: string;
  siteId: string;
  timezone: string;
  /** The occurrence that was clicked: its owner and week. */
  occ: OccurrenceRef;
  ownerName: string | null;
  ownerNote: string;
  canEdit: boolean;
  onClose: () => void;
  /** Something was saved (the calendar refreshes behind the panel). */
  onChanged: () => void;
  onReschedule: (item: AffectedItem, holds: string[]) => void;
  recheck: number;
  hidden?: boolean;
}) {
  const tz = props.timezone;
  const [list, setList] = useState<SeriesView[] | null | "error">(null);
  const [editing, setEditing] = useState<OccurrenceRef | null>(null);
  const [saved, setSaved] = useState<{ date: string; message: string } | null>(null);
  const handle = useRef<SidePanelHandle | null>(null);
  const load = useCallback(() => {
    listScheduleSeriesAction(props.clientId, props.siteId)
      .then((r) => setList(r.ok ? r.series : "error"))
      .catch(() => setList("error"));
  }, [props.clientId, props.siteId]);
  useEffect(load, [load]);

  // The week (Monday first) of the clicked date.
  const [y, m, d] = props.occ.date.split("-").map(Number);
  const monday = addDays(props.occ.date, -((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7));
  const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  const today = todayAtSite(tz);
  const [now] = useState(() => Date.now());

  const owned = Array.isArray(list) ? list.filter((s) => s.kind === "break" && s.staffId === props.occ.staffId) : [];
  const rows = owned.map((s) => ({ id: s.id, site_id: props.siteId, staff_id: s.staffId, kind: s.kind, weekdays: s.weekdays, start_min: toMin(s.start), end_min: toMin(s.end), starts_on: s.startsOn, ends_on: s.endsOn, reason: s.reason, public_reason: null }));
  const ovs = owned.flatMap((s) => s.overrides.map((o) => ({ series_id: s.id, occurrence_date: o.date, action: o.action, start_min: o.start ? toMin(o.start) : null, end_min: o.end ? toMin(o.end) : null })));
  const occs: Occurrence[] = Array.isArray(list) ? expandSeries(rows, ovs, days[0], days[6], tz) : [];
  const usualOf = (seriesId: string) => owned.find((s) => s.id === seriesId);
  const skipped = (date: string) => owned.find((s) => s.weekdays.includes(new Date(`${date}T00:00:00Z`).getUTCDay()) && s.overrides.some((o) => o.date === date && o.action === "skip"));
  const routine = owned.length
    ? [...new Set(owned.map((s) => `${s.start} – ${s.end}`))].join(" · ")
    : "";

  if (editing) {
    return (
      <SeriesPanel
        key={`${editing.seriesId}:${editing.date}`}
        clientId={props.clientId}
        siteId={props.siteId}
        timezone={tz}
        occ={editing}
        ownerName={props.ownerName}
        canEdit={props.canEdit}
        hidden={props.hidden}
        recheck={props.recheck}
        onReschedule={props.onReschedule}
        onClose={() => setEditing(null)}
        onSaved={(message) => {
          setSaved({ date: editing.date, message });
          setEditing(null);
          load();
          props.onChanged();
        }}
      />
    );
  }

  const label = (date: string) => `${DAY[new Date(`${date}T00:00:00Z`).getUTCDay()]} ${Number(date.slice(8))}`;
  return (
    <div hidden={props.hidden}>
      <SidePanel
        name="break-week"
        title="Pausa habitual"
        subtitle={props.ownerNote}
        onClose={props.onClose}
        handleRef={handle}
        footer={
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 text-[13px] text-muted">{saved ? "" : props.canEdit ? "Elige un día para cambiar solo esa fecha" : ""}</span>
            <Button variant={saved ? "primary" : "secondary"} onClick={props.onClose}>
              {saved ? "Listo" : "Cerrar"}
            </Button>
          </div>
        }
      >
        {saved ? (
          <p role="status" className="mb-3 flex gap-2 rounded-[10px] bg-[var(--success-soft)] px-3 py-2.5 text-[13px] text-[var(--success)]">
            <span aria-hidden>✓</span>
            {saved.message}
          </p>
        ) : routine ? (
          <dl className="mb-3 grid grid-cols-[130px_minmax(0,1fr)] gap-x-3 gap-y-1.5 rounded-[10px] bg-[var(--chip)] px-3.5 py-3 text-[13.5px]">
            <dt className="text-muted">Pausa habitual</dt>
            <dd>{routine} · cada semana</dd>
            <dt className="text-muted">Dónde vive</dt>
            <dd>En su horario semanal. No es un bloqueo aparte.</dd>
          </dl>
        ) : null}
        {list === "error" ? (
          <p className="text-[13px] text-muted">
            No pudimos cargar la pausa.{" "}
            <button type="button" className="underline" onClick={load}>
              Reintentar
            </button>
          </p>
        ) : list === null ? (
          <div aria-busy="true" aria-label="Cargando la semana" className="h-64 rounded-[12px] bg-[var(--chip)]" />
        ) : (
          <>
            <p className="mb-1 text-[13px] text-muted">
              Semana del {Number(days[0].slice(8))} {MON[Number(days[0].slice(5, 7)) - 1]} al {Number(days[6].slice(8))} {MON[Number(days[6].slice(5, 7)) - 1]}
            </p>
            <ul className="flex flex-col">
              {days.map((date) => {
                const o = occs.find((x) => x.date === date);
                const skip = !o ? skipped(date) : undefined;
                const started = o ? o.from.getTime() <= now : date < today;
                const usual = o ? usualOf(o.series_id) : null;
                const highlight = saved?.date === date;
                return (
                  <li
                    key={date}
                    className={`flex min-h-[56px] items-center gap-3 py-2.5 shadow-[inset_0_-1px_0_var(--line-soft)] ${highlight ? "bg-[linear-gradient(90deg,var(--warn-soft),transparent_70%)]" : ""}`}
                  >
                    <span className="w-[74px] shrink-0 text-[13.5px]">{label(date)}</span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className={`text-[13.5px] tabular-nums ${o ? "text-foreground" : "text-muted"}`}>
                        {o ? `Pausa ${hm(o.start_min)} – ${hm(o.end_min)}` : skip ? "Sin pausa este día" : "Sin pausa"}
                      </span>
                      {o?.moved && usual ? (
                        <span className="text-[12.5px] text-[var(--warn)]">Excepción solo este día · antes {usual.start} – {usual.end}</span>
                      ) : skip ? (
                        <span className="text-[12.5px] text-[var(--warn)]">Excepción solo este día · pausa quitada</span>
                      ) : null}
                    </span>
                    {props.canEdit && !o && skip && date > today ? (
                      <button
                        type="button"
                        className="u-focus inline-flex h-[32px] shrink-0 items-center rounded-[9px] border border-[var(--line-strong)] bg-[var(--surface)] px-3 text-[13px] hover:bg-[var(--subtle)]"
                        onClick={() => {
                          const mid = siteMidnight(date, tz).getTime();
                          setEditing({ seriesId: skip.id, kind: "break", staffId: skip.staffId, date, startsAt: new Date(mid + toMin(skip.start) * 60_000).toISOString(), endsAt: new Date(mid + toMin(skip.end) * 60_000).toISOString(), moved: true });
                        }}
                      >
                        Cambiar este día
                      </button>
                    ) : null}
                    {props.canEdit && o && !started ? (
                      <button
                        type="button"
                        className="u-focus inline-flex h-[32px] shrink-0 items-center rounded-[9px] border border-[var(--line-strong)] bg-[var(--surface)] px-3 text-[13px] hover:bg-[var(--subtle)]"
                        onClick={() =>
                          setEditing({ seriesId: o.series_id, kind: "break", staffId: o.staff_id, date, startsAt: o.from.toISOString(), endsAt: o.until.toISOString(), moved: o.moved })
                        }
                      >
                        Cambiar este día
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </SidePanel>
    </div>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";
import { listScheduleSeriesAction, type SeriesView } from "@/lib/scheduleSeriesActions";
import { expandSeries } from "@worker/scheduling/series.js";
import { fmtTime, longDate, todayAtSite } from "@/lib/siteCalendar";
import { PUBLIC_REASON_LABEL, type PublicAbsenceReason } from "@/lib/publicAbsenceReason";
import { BlockPanel } from "../agenda/BlockPanel";
import { SeriesPanel, type OccurrenceRef } from "../agenda/SeriesPanel";
import { AffectedReschedulePanel } from "../agenda/AffectedReschedulePanel";
import type { AffectedItem } from "../agenda/ScheduleFormParts";
import type { StaffTimeOff } from "./StaffTab";

/**
 * AUSENCIAS of one professional, from their ficha: dated absences and recurring blocks,
 * created and edited with the SAME panels as the calendar (BlockPanel / SeriesPanel), so the
 * rules (scope, affected appointments, public reason) are identical everywhere. Past ones
 * are history: shown, never edited.
 */
const WD = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

export function StaffAbsences(props: {
  clientId: string;
  siteId: string;
  siteName: string;
  timezone: string;
  staffId: string;
  staffName: string;
  timeOff: StaffTimeOff[];
  canEdit: boolean;
  onChanged: (message: string) => void;
}) {
  const tz = props.timezone;
  const today = todayAtSite(tz);
  const [series, setSeries] = useState<SeriesView[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [panel, setPanel] = useState<null | { kind: "new" } | { kind: "dated"; block: StaffTimeOff } | { kind: "series"; occ: OccurrenceRef }>(null);
  const [resched, setResched] = useState<{ item: AffectedItem; holds: string[] } | null>(null);
  const [recheck, setRecheck] = useState(0);
  const [showPast, setShowPast] = useState(false);

  const load = useCallback(() => {
    listScheduleSeriesAction(props.clientId, props.siteId)
      .then((r) => {
        setLoadError(!r.ok);
        if (r.ok) setSeries(r.series.filter((s) => s.kind === "block" && (s.staffId === props.staffId || s.staffId === null)));
      })
      .catch(() => setLoadError(true));
  }, [props.clientId, props.siteId, props.staffId]);
  useEffect(load, [load]);

  const [now] = useState(() => Date.now());
  const upcoming = props.timeOff.filter((t) => Date.parse(t.endsAt) > now).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const past = props.timeOff.filter((t) => Date.parse(t.endsAt) <= now).sort((a, b) => b.startsAt.localeCompare(a.startsAt));

  const nextOccurrence = (s: SeriesView): OccurrenceRef | null => {
    const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
    const row = { id: s.id, site_id: props.siteId, staff_id: s.staffId, kind: s.kind, weekdays: s.weekdays, start_min: toMin(s.start), end_min: toMin(s.end), starts_on: s.startsOn, ends_on: s.endsOn, reason: s.reason, public_reason: null };
    const ov = s.overrides.map((o) => ({ series_id: s.id, occurrence_date: o.date, action: o.action, start_min: o.start ? toMin(o.start) : null, end_min: o.end ? toMin(o.end) : null }));
    const until = (() => {
      const [y, m, d] = today.split("-").map(Number);
      const t = new Date(Date.UTC(y, m - 1, d + 90));
      return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
    })();
    const occ = expandSeries([row], ov, today, until, tz).find((o) => o.from.getTime() > now);
    return occ ? { seriesId: s.id, kind: "block", staffId: s.staffId, date: occ.date, startsAt: occ.from.toISOString(), endsAt: occ.until.toISOString(), moved: occ.moved } : null;
  };

  const done = (m: string) => {
    setPanel(null);
    void load();
    props.onChanged(m);
  };

  const DW = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
  const MO = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  const shortD = (iso: string) => {
    const k = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
    const [y, m, d] = k.split("-").map(Number);
    return `${DW[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${d} ${MO[m - 1]}`;
  };
  const EDIT = "u-focus inline-flex h-[32px] shrink-0 items-center rounded-[9px] border border-[var(--line-strong)] bg-[var(--surface)] px-3 text-[13px] hover:bg-[var(--subtle)]";
  const TAG = "inline-flex h-[22px] shrink-0 items-center rounded-[6px] bg-[var(--chip)] px-2 text-[12px] text-[var(--ag-ink2)]";
  // Reference f15: date range, then what is withdrawn, then what the client / the team see.
  const row = (t: StaffTimeOff, isPast: boolean) => {
    const allDay = fmtTime(t.startsAt, tz) === "00:00" && fmtTime(t.endsAt, tz) === "00:00";
    const last = new Date(Date.parse(t.endsAt) - 1).toISOString();
    const same = longDate(t.startsAt, tz) === longDate(last, tz);
    const days = Math.max(1, Math.round((Date.parse(t.endsAt) - Date.parse(t.startsAt)) / 86_400_000));
    return (
      <li key={t.id} className="flex items-start gap-3 py-3 shadow-[inset_0_-1px_0_var(--line-soft)]">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="text-[14px] tabular-nums">{same ? shortD(t.startsAt) : `${shortD(t.startsAt)} – ${shortD(last)}`}</p>
          <p className="text-[13px] tabular-nums text-[var(--ag-ink2)]">
            {allDay ? `Todo el día · se ${days === 1 ? "retira 1 día completo" : `retiran ${days} días completos`}` : `${fmtTime(t.startsAt, tz)}–${fmtTime(t.endsAt, tz)}`}
          </p>
          <p className="text-[12.5px] text-muted">
            Cliente: {t.publicReason ? PUBLIC_REASON_LABEL[t.publicReason as PublicAbsenceReason] : "sin motivo"} · Equipo: {t.reason?.trim() || "sin motivo"}
          </p>
        </div>
        <span className={TAG}>Ausencia</span>
        {!isPast && props.canEdit ? (
          <button type="button" className={EDIT} onClick={() => setPanel({ kind: "dated", block: t })}>
            Editar
          </button>
        ) : null}
      </li>
    );
  };
  const tabBtn = (on: boolean) => `u-focus h-[28px] rounded-[8px] px-3 text-[13.5px] ${on ? "bg-[var(--ag-seg-on)] font-medium text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.08)]" : "text-[var(--ag-ink2)]"}`;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <div role="tablist" aria-label="Ausencias" className="flex gap-0.5 rounded-[10px] bg-[var(--ag-seg)] p-[3px]">
          <button type="button" role="tab" aria-selected={!showPast} onClick={() => setShowPast(false)} className={tabBtn(!showPast)}>
            Próximas
          </button>
          <button type="button" role="tab" aria-selected={showPast} onClick={() => setShowPast(true)} className={tabBtn(showPast)}>
            Pasadas
          </button>
        </div>
        <span className="min-w-0 flex-1" />
        {props.canEdit ? (
          <button type="button" className="u-focus inline-flex h-[36px] items-center rounded-[10px] border border-[var(--line-strong)] bg-[var(--surface)] px-3.5 text-[13.5px] font-medium hover:bg-[var(--subtle)]" onClick={() => setPanel({ kind: "new" })}>
            + Nueva ausencia
          </button>
        ) : null}
      </div>
      <p className="text-[12.5px] text-muted">Las vacaciones de {props.staffName} retiran solo su disponibilidad: la sede sigue abierta.</p>

      {showPast ? (
        past.length === 0 ? (
          <p className="rounded-[10px] bg-[var(--chip)] px-3 py-2.5 text-[13px] text-[var(--ag-ink2)]">No hay ausencias pasadas.</p>
        ) : (
          <ul className="flex flex-col">{past.map((t) => row(t, true))}</ul>
        )
      ) : (
        <ul className="flex flex-col">
          {upcoming.map((t) => row(t, false))}
          {loadError ? (
            <li className="flex items-center gap-3 py-3 text-[13px] text-muted">
              No pudimos cargar los bloqueos recurrentes.
              <button type="button" className={EDIT} onClick={() => void load()}>
                Reintentar
              </button>
            </li>
          ) : series === null ? (
            <li aria-busy="true" className="my-2 h-[48px] rounded-[10px] bg-[var(--chip)]" />
          ) : (
            series.map((s) => {
              const occ = nextOccurrence(s);
              return (
                <li key={s.id} className="flex items-start gap-3 py-3 shadow-[inset_0_-1px_0_var(--line-soft)]">
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <p className="text-[14px]">
                      Cada {s.weekdays.map((d) => WD[d]).join(", ")} · <span className="tabular-nums">{s.start}–{s.end}</span>
                    </p>
                    <p className="text-[13px] text-[var(--ag-ink2)]">
                      {s.endsOn ? `Hasta el ${s.endsOn.split("-").reverse().join("/")}` : "Sin fecha de fin"}
                      {s.overrides.length ? ` · ${s.overrides.length} ${s.overrides.length === 1 ? "excepción" : "excepciones"}` : ""}
                      {s.staffId === null ? " · toda la sede" : ""}
                    </p>
                    <p className="text-[12.5px] text-muted">Equipo: {s.reason?.trim() || "sin motivo"}</p>
                  </div>
                  <span className={TAG}>Serie</span>
                  {occ && props.canEdit && s.staffId === props.staffId ? (
                    <button type="button" className={EDIT} onClick={() => setPanel({ kind: "series", occ })}>
                      Editar serie
                    </button>
                  ) : null}
                </li>
              );
            })
          )}
          {upcoming.length === 0 && Array.isArray(series) && series.length === 0 ? (
            <li className="rounded-[10px] bg-[var(--chip)] px-3 py-2.5 text-[13px] text-[var(--ag-ink2)]">No hay ausencias próximas.</li>
          ) : null}
        </ul>
      )}

      {panel?.kind === "new" || panel?.kind === "dated" ? (
        <BlockPanel
          clientId={props.clientId}
          siteId={props.siteId}
          siteName={props.siteName}
          timezone={tz}
          staff={[{ id: props.staffId, name: props.staffName }]}
          canSiteClosure={false}
          canStaffTimeOff={props.canEdit}
          fixedStaffId={props.staffId}
          title="Nueva ausencia"
          edit={panel.kind === "dated" ? { id: panel.block.id, staff_id: props.staffId, starts_at: panel.block.startsAt, ends_at: panel.block.endsAt, reason: panel.block.reason, public_reason: panel.block.publicReason ?? null } : undefined}
          hidden={Boolean(resched)}
          recheck={recheck}
          onReschedule={(item, holds) => setResched({ item, holds })}
          onClose={() => setPanel(null)}
          onSaved={done}
        />
      ) : null}
      {panel?.kind === "series" ? (
        <SeriesPanel
          clientId={props.clientId}
          siteId={props.siteId}
          timezone={tz}
          occ={panel.occ}
          ownerName={props.staffName}
          canEdit={props.canEdit}
          hidden={Boolean(resched)}
          recheck={recheck}
          onReschedule={(item, holds) => setResched({ item, holds })}
          onClose={() => setPanel(null)}
          onSaved={done}
        />
      ) : null}
      {resched ? (
        <AffectedReschedulePanel
          clientId={props.clientId}
          siteId={props.siteId}
          timezone={tz}
          item={resched.item}
          holds={resched.holds}
          staff={[]}
          openWeekdays={new Set()}
          lockStaffId={null}
          returnLabel="la ausencia"
          onBack={() => {
            setResched(null);
            setRecheck((n) => n + 1);
          }}
        />
      ) : null}
    </div>
  );
}

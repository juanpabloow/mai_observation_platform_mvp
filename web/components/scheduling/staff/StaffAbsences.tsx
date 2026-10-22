"use client";

import { useCallback, useEffect, useState } from "react";
import { listScheduleSeriesAction, type SeriesView } from "@/lib/scheduleSeriesActions";
import { expandSeries } from "@worker/scheduling/series.js";
import { fmtTime, longDate, todayAtSite } from "@/lib/siteCalendar";
import { PUBLIC_REASON_LABEL, type PublicAbsenceReason } from "@/lib/publicAbsenceReason";
import { Button } from "../ui/system";
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

  const row = (t: StaffTimeOff, isPast: boolean) => {
    const allDay = fmtTime(t.startsAt, tz) === "00:00" && fmtTime(t.endsAt, tz) === "00:00";
    const last = new Date(Date.parse(t.endsAt) - 1).toISOString();
    const when = allDay
      ? longDate(t.startsAt, tz) === longDate(last, tz)
        ? `${longDate(t.startsAt, tz)} · todo el día`
        : `${longDate(t.startsAt, tz)} → ${longDate(last, tz)} · todo el día`
      : `${longDate(t.startsAt, tz)} · ${fmtTime(t.startsAt, tz)}–${fmtTime(t.endsAt, tz)}`;
    return (
      <li key={t.id} className={`flex items-center gap-3 px-4 py-3 ${isPast ? "opacity-70" : ""}`}>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-semibold">{t.reason?.trim() || "Ausencia"}</p>
          <p className="u-tnum truncate text-[12.5px] text-muted">
            {when}
            {t.publicReason ? ` · El cliente ve «${PUBLIC_REASON_LABEL[t.publicReason as PublicAbsenceReason]}»` : ""}
          </p>
        </div>
        {!isPast && props.canEdit ? (
          <Button size="sm" onClick={() => setPanel({ kind: "dated", block: t })}>
            Editar
          </Button>
        ) : isPast ? (
          <span className="text-[12px] text-muted">Pasada</span>
        ) : null}
      </li>
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <p className="min-w-0 flex-1 text-[13px] text-muted">Las vacaciones de {props.staffName} retiran solo su disponibilidad: la sede sigue abierta.</p>
        {props.canEdit ? (
          <Button variant="primary" onClick={() => setPanel({ kind: "new" })}>
            Nueva ausencia
          </Button>
        ) : null}
      </div>

      <section aria-labelledby="abs-upcoming" className="flex flex-col gap-2">
        <h4 id="abs-upcoming" className="text-[13px] font-semibold">Próximas</h4>
        {upcoming.length === 0 ? (
          <p className="rounded-[12px] border border-dashed border-line-strong px-4 py-4 text-[13px] text-muted">No hay ausencias próximas.</p>
        ) : (
          <ul className="divide-y divide-line-soft rounded-[12px] border border-line">{upcoming.map((t) => row(t, false))}</ul>
        )}
      </section>

      <section aria-labelledby="abs-series" className="flex flex-col gap-2">
        <h4 id="abs-series" className="text-[13px] font-semibold">Se repiten</h4>
        {loadError ? (
          <div className="flex items-center gap-3 text-[13px] text-muted">
            No pudimos cargar los bloqueos recurrentes.
            <Button size="sm" onClick={() => void load()}>Reintentar</Button>
          </div>
        ) : series === null ? (
          <div aria-busy="true" className="h-[48px] rounded-[12px] bg-subtle" />
        ) : series.length === 0 ? (
          <p className="text-[13px] text-muted">Sin bloqueos recurrentes.</p>
        ) : (
          <ul className="divide-y divide-line-soft rounded-[12px] border border-line">
            {series.map((s) => {
              const occ = nextOccurrence(s);
              return (
                <li key={s.id} className="flex items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-semibold">
                      {s.reason?.trim() || "Bloqueo"}
                      {s.staffId === null ? <span className="ml-1.5 font-normal text-muted">· toda la sede</span> : null}
                    </p>
                    <p className="truncate text-[12.5px] text-muted">
                      Cada {s.weekdays.map((d) => WD[d]).join(", ")} · {s.start}–{s.end} · {s.endsOn ? `hasta el ${s.endsOn.split("-").reverse().join("/")}` : "sin fecha de fin"}
                      {s.overrides.length ? ` · ${s.overrides.length} ${s.overrides.length === 1 ? "excepción" : "excepciones"}` : ""}
                    </p>
                  </div>
                  {occ && props.canEdit && s.staffId === props.staffId ? (
                    <Button size="sm" onClick={() => setPanel({ kind: "series", occ })}>
                      Editar
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {past.length > 0 ? (
        <section className="flex flex-col gap-2">
          <button type="button" onClick={() => setShowPast((v) => !v)} className="u-focus self-start rounded text-[13px] font-medium hover:underline" aria-expanded={showPast}>
            {showPast ? "Ocultar pasadas" : `Ver pasadas (${past.length})`}
          </button>
          {showPast ? <ul className="divide-y divide-line-soft rounded-[12px] border border-line">{past.map((t) => row(t, true))}</ul> : null}
        </section>
      ) : null}

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

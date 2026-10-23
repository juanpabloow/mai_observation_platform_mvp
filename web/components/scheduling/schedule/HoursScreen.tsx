"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { listScheduleSeriesAction, type SeriesView } from "@/lib/scheduleSeriesActions";
import { expandSeries } from "@worker/scheduling/series.js";
import { PUBLIC_REASON_LABEL, type PublicAbsenceReason } from "@/lib/publicAbsenceReason";
import { fmtTime, longDate, todayAtSite, timezoneLabel } from "@/lib/siteCalendar";
import { Button } from "../ui/system";
import { WeeklyScheduleEditor } from "./WeeklyScheduleEditor";
import { AgAvatar, AgPageHeader, agTintAt, TB_BTN, TB_PRIMARY } from "../agenda/AgendaChrome";
import { BlockPanel, type DatedBlock } from "../agenda/BlockPanel";
import { SeriesPanel, type OccurrenceRef } from "../agenda/SeriesPanel";
import { AffectedReschedulePanel } from "../agenda/AffectedReschedulePanel";
import type { AffectedItem } from "../agenda/ScheduleFormParts";

/**
 * HORARIOS Y AUSENCIAS — three levels on one page, one surface:
 *   1. the site's usual weekly hours (+ its usual breaks) — the base for everyone without
 *      their own hours;
 *   2. each professional's hours: OWN or INHERITED (inherited shows the site's hours, never
 *      "Off"); edited in their Equipo ficha;
 *   3. dated and recurring absences / closures. A professional's vacation never closes the
 *      site; a closure is «Toda la sede».
 * With several sites a discreet selector sits in the header; with one there is none.
 */
type Hours = Record<string, Array<{ start: string; end: string }>>;
interface Site { id: string; name: string; timezone: string; active: boolean; opening_hours: Hours; scheduling_config: { slot_interval_min: number } }
interface Staff { id: string; site_id: string; name: string; active: boolean; takes_bookings: boolean; working_hours: Hours }
interface Exc { id: string; site_id: string; staff_id: string | null; starts_at: string; ends_at: string; reason: string | null; public_reason?: PublicAbsenceReason | null }

const KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const SHORT = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];
const WD = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const span = (h: Hours, k: string) => {
  const r = [...(h[k] ?? [])].sort((a, b) => a.start.localeCompare(b.start));
  return r.length ? { start: r[0].start, end: r[r.length - 1].end } : null;
};
const hh = (t: string) => (t.endsWith(":00") ? String(Number(t.slice(0, 2))) : t);

export function HoursScreen(props: {
  clientId: string;
  sites: Site[];
  staff: Staff[];
  exceptions: Exc[];
  pastExceptions: Exc[];
  /** May open a professional's ficha (team.manage). */
  canTeam: boolean;
  /** «¿Por qué no hay disponibilidad?» — the existing diagnostic, kept under the lists. */
  footer?: ReactNode;
}) {
  const router = useRouter();
  const activeSites = props.sites.filter((s) => s.active);
  const [siteId, setSiteId] = useState(activeSites[0]?.id ?? props.sites[0]?.id ?? "");
  const site = props.sites.find((s) => s.id === siteId) ?? props.sites[0];
  const tz = site?.timezone ?? "America/Bogota";
  const today = todayAtSite(tz);
  const [seriesState, setSeriesState] = useState<{ siteId: string; list: SeriesView[] | null; error: boolean }>({ siteId: "", list: null, error: false });
  const series = seriesState.siteId === siteId ? seriesState.list : null;
  const seriesError = seriesState.siteId === siteId && seriesState.error;
  const [editingSite, setEditingSite] = useState(false);
  const [tab, setTab] = useState<"next" | "past">("next");
  const [panel, setPanel] = useState<null | { kind: "new"; title: string } | { kind: "dated"; block: DatedBlock } | { kind: "series"; occ: OccurrenceRef; owner: string | null }>(null);
  const [resched, setResched] = useState<{ item: AffectedItem; holds: string[] } | null>(null);
  const [recheck, setRecheck] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 2600);
    return () => window.clearTimeout(t);
  }, [notice]);

  const load = useCallback(() => {
    if (!siteId) return;
    listScheduleSeriesAction(props.clientId, siteId)
      .then((r) => setSeriesState({ siteId, list: r.ok ? r.series : null, error: !r.ok }))
      .catch(() => setSeriesState({ siteId, list: null, error: true }));
  }, [props.clientId, siteId]);
  useEffect(load, [load]);

  const staff = props.staff.filter((s) => s.site_id === siteId && s.active);
  const nameOf = (id: string | null) => (id ? props.staff.find((s) => s.id === id)?.name ?? "Profesional" : "Toda la sede");
  const blockSeries = (series ?? []).filter((s) => s.kind === "block");
  const upcoming = props.exceptions.filter((e) => e.site_id === siteId).sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  const past = props.pastExceptions.filter((e) => e.site_id === siteId).sort((a, b) => b.starts_at.localeCompare(a.starts_at));

  const done = (m: string) => {
    setPanel(null);
    setNotice(m);
    void load();
    router.refresh();
  };

  const nextOcc = (s: SeriesView): OccurrenceRef | null => {
    const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
    const row = { id: s.id, site_id: siteId, staff_id: s.staffId, kind: s.kind, weekdays: s.weekdays, start_min: toMin(s.start), end_min: toMin(s.end), starts_on: s.startsOn, ends_on: s.endsOn, reason: s.reason, public_reason: null };
    const ov = s.overrides.map((o) => ({ series_id: s.id, occurrence_date: o.date, action: o.action, start_min: o.start ? toMin(o.start) : null, end_min: o.end ? toMin(o.end) : null }));
    const [y, m, d] = today.split("-").map(Number);
    const t = new Date(Date.UTC(y, m - 1, d + 120));
    const until = `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
    const o = expandSeries([row], ov, today, until, tz).find((x) => x.from.getTime() > Date.now());
    return o ? { seriesId: s.id, kind: s.kind, staffId: s.staffId, date: o.date, startsAt: o.from.toISOString(), endsAt: o.until.toISOString(), moved: o.moved } : null;
  };

  const whenOf = (e: Exc) => {
    const allDay = fmtTime(e.starts_at, tz) === "00:00" && fmtTime(e.ends_at, tz) === "00:00";
    const last = new Date(Date.parse(e.ends_at) - 1).toISOString();
    if (allDay) return longDate(e.starts_at, tz) === longDate(last, tz) ? `${longDate(e.starts_at, tz)} · todo el día` : `${longDate(e.starts_at, tz)} → ${longDate(last, tz)}`;
    return `${longDate(e.starts_at, tz)} · ${fmtTime(e.starts_at, tz)}–${fmtTime(e.ends_at, tz)}`;
  };

  const siteWeek = useMemo(() => KEYS.map((k) => span(site?.opening_hours ?? {}, k)), [site]);

  if (!site) {
    return (
      <div className="flex flex-1 items-center justify-center p-10 text-center text-[13px] text-muted">
        Aún no hay sedes. Crea una en Configuración → Sedes para definir horarios.
      </div>
    );
  }

  return (
    <section aria-labelledby="hours-title" className="u-ag -m-[var(--content-pad)] flex min-h-0 flex-1 flex-col self-stretch overflow-hidden bg-[var(--surface)]">
      <AgPageHeader id="hours-title" title="Horarios y ausencias" subtitle={`Cuándo se atiende y cuándo no · ${timezoneLabel(tz)}`}>
        {props.sites.length > 1 ? (
          <select aria-label="Sede" value={siteId} onChange={(e) => setSiteId(e.target.value)} className="u-focus h-[40px] rounded-[10px] border border-[var(--line-strong)] bg-[var(--surface)] px-3 text-[14px]">
            {props.sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {s.active ? "" : " (inactiva)"}
              </option>
            ))}
          </select>
        ) : null}
        <button type="button" onClick={() => setPanel({ kind: "new", title: "Nuevo bloqueo" })} className={TB_BTN}>
          Nuevo bloqueo
        </button>
        <button type="button" onClick={() => setPanel({ kind: "new", title: "Nueva ausencia o cierre" })} className={TB_PRIMARY}>
          <svg aria-hidden viewBox="0 0 16 16" className="size-[14px]" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M8 3v10M3 8h10" /></svg>
          Nueva ausencia o cierre
        </button>
      </AgPageHeader>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6 pt-1">
        <div className="flex w-full flex-col gap-8">
          {/* 1 · SITE HOURS */}
          <section aria-labelledby="site-hours" className="flex flex-col gap-3">
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-0 flex-1">
                <h2 id="site-hours" className="text-[15px] font-semibold">Horario habitual de la sede</h2>
                <p className="text-[13px] text-muted">
                  {site.name} · reservas cada {site.scheduling_config.slot_interval_min} min. Es la base para quien no tiene horario propio.
                </p>
              </div>
              {!editingSite ? <Button onClick={() => setEditingSite(true)}>Editar horario</Button> : null}
            </div>
            {editingSite ? (
              seriesError ? (
                <p className="text-[13px] text-muted">No pudimos cargar las pausas. <button type="button" className="underline" onClick={() => void load()}>Reintentar</button></p>
              ) : series === null ? (
                <div aria-busy="true" className="h-64 rounded-[14px] bg-subtle" />
              ) : (
                <div className="flex flex-col gap-2">
                  <WeeklyScheduleEditor
                    clientId={props.clientId}
                    siteId={site.id}
                    staffId={null}
                    ownerLabel={site.name}
                    siteName={site.name}
                    timezone={tz}
                    today={today}
                    hours={site.opening_hours}
                    siteHours={site.opening_hours}
                    series={series.filter((s) => s.kind === "break" && s.staffId === null)}
                    canEdit
                    recheck={recheck}
                    onReschedule={(item) => setResched({ item, holds: [] })}
                    autoEdit
                    onCancel={() => setEditingSite(false)}
                    onSaved={(m) => {
                      setEditingSite(false);
                      done(m);
                    }}
                  />
                </div>
              )
            ) : (
              <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
                {KEYS.map((k, i) => {
                  const sp = siteWeek[i];
                  return (
                    <li key={k} className={`flex min-h-[70px] flex-col gap-0.5 rounded-[10px] px-3 py-2.5 ${sp ? "bg-[var(--chip)]" : "shadow-[inset_0_0_0_1px_var(--line)]"}`}>
                      <span className="text-[12px] text-muted">{SHORT[i]}</span>
                      {sp ? (
                        <span className="text-[14px] leading-[18px] tabular-nums">
                          {sp.start}
                          <br />
                          {sp.end}
                        </span>
                      ) : (
                        <span className="text-[13px] text-muted">Cerrado</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* 2 · EACH PROFESSIONAL */}
          <section aria-labelledby="staff-hours" className="flex flex-col gap-3">
            <div>
              <h2 id="staff-hours" className="text-[15px] font-semibold">Horario de cada profesional</h2>
              <p className="text-[13px] text-muted">Quien no tiene horario propio atiende en el horario de la sede (en gris). Se edita en su ficha de Equipo.</p>
            </div>
            {staff.length === 0 ? (
              <p className="rounded-[12px] border border-dashed border-line-strong px-4 py-4 text-[13px] text-muted">No hay profesionales activos en esta sede.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] border-separate border-spacing-0 text-[13px]">
                  <thead>
                    <tr className="text-left text-[12px] text-muted">
                      <th scope="col" className="border-b border-line px-2 pb-2 font-medium">Profesional</th>
                      <th scope="col" className="border-b border-line px-2 pb-2 font-medium">Origen</th>
                      {SHORT.map((d) => (
                        <th key={d} scope="col" className="border-b border-line px-2 pb-2 text-center font-medium">{d}</th>
                      ))}
                      <th scope="col" className="border-b border-line px-2 pb-2"><span className="sr-only">Acciones</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {staff.map((s) => {
                      const own = Object.keys(s.working_hours).length > 0;
                      return (
                        <tr key={s.id}>
                          <td className="border-b border-line-soft px-2 py-2.5">
                            <span className="flex items-center gap-2.5">
                              <AgAvatar name={s.name} id={s.id} size={32} tint={agTintAt([...props.staff].sort((a, b) => a.name.localeCompare(b.name, "es")).findIndex((x) => x.id === s.id))} />
                              <span className="font-medium">{s.name}</span>
                            </span>
                          </td>
                          <td className="border-b border-line-soft px-2 py-2.5">
                            <span className={`rounded-full px-2 py-0.5 text-[12px] ${own ? "bg-chip text-foreground" : "border border-line text-muted"}`}>{own ? "Horario propio" : "Hereda de la sede"}</span>
                          </td>
                          {KEYS.map((k, i) => {
                            const sp = span(own ? s.working_hours : site.opening_hours, k);
                            const siteSp = siteWeek[i];
                            const shown = own && sp && siteSp ? { start: sp.start > siteSp.start ? sp.start : siteSp.start, end: sp.end < siteSp.end ? sp.end : siteSp.end } : sp;
                            return (
                              <td key={k} className={`u-tnum border-b border-line-soft px-2 py-2.5 text-center ${own ? "" : "text-muted"}`}>
                                {shown ? `${hh(shown.start)}–${hh(shown.end)}` : "—"}
                              </td>
                            );
                          })}
                          <td className="border-b border-line-soft px-2 py-2.5 text-right">
                            {props.canTeam ? (
                              <Link href={`/clients/${props.clientId}/scheduling/staff?site=${site.id}&s=${s.id}&dtab=hours`} className="u-focus inline-flex h-[36px] items-center rounded-sch-control border border-line px-3 text-[12.5px] font-medium hover:bg-subtle">
                                Editar en Equipo
                              </Link>
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* 3 · ABSENCES AND CLOSURES */}
          <section id="ausencias" aria-labelledby="abs-title" className="flex scroll-mt-4 flex-col gap-3">
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-0 flex-1">
                <h2 id="abs-title" className="text-[15px] font-semibold">Ausencias y cierres</h2>
                <p className="text-[13px] text-muted">Retiran disponibilidad en fechas concretas o de forma recurrente. Las vacaciones de una persona no cierran la sede.</p>
              </div>
              <div role="tablist" aria-label="Ausencias" className="flex rounded-sch-control bg-chip p-1">
                {(["next", "past"] as const).map((t) => (
                  <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={`u-focus h-[36px] rounded-[9px] px-3 text-[13px] ${tab === t ? "bg-surface font-semibold shadow-[0_1px_2px_rgba(0,0,0,0.08)]" : "text-muted"}`}>
                    {t === "next" ? `Próximas ${upcoming.length + blockSeries.length}` : `Pasadas ${past.length}`}
                  </button>
                ))}
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] border-separate border-spacing-0 text-[13px]">
                <thead>
                  <tr className="text-left text-[12px] text-muted">
                    <th scope="col" className="border-b border-line px-2 pb-2 font-medium">A quién afecta</th>
                    <th scope="col" className="border-b border-line px-2 pb-2 font-medium">Cuándo</th>
                    <th scope="col" className="border-b border-line px-2 pb-2 font-medium">Se retira</th>
                    <th scope="col" className="border-b border-line px-2 pb-2 font-medium">Qué verá el cliente</th>
                    <th scope="col" className="border-b border-line px-2 pb-2 font-medium">Motivo interno</th>
                    <th scope="col" className="border-b border-line px-2 pb-2"><span className="sr-only">Acciones</span></th>
                  </tr>
                </thead>
                <tbody>
                  {tab === "next" ? (
                    <>
                      {blockSeries.map((s) => {
                        const occ = nextOcc(s);
                        return (
                          <tr key={s.id}>
                            <td className="border-b border-line-soft px-2 py-2.5 font-medium">{nameOf(s.staffId)}</td>
                            <td className="border-b border-line-soft px-2 py-2.5">
                              <span className="mr-1.5 rounded-full bg-chip px-1.5 py-0.5 text-[11.5px]">Se repite</span>
                              Cada {s.weekdays.map((d) => WD[d]).join(", ")} · {s.start === "00:00" && s.end === "24:00" ? "todo el día" : `${s.start}–${s.end}`}
                              {s.endsOn ? ` · hasta ${s.endsOn.split("-").reverse().join("/")}` : ""}
                            </td>
                            <td className="border-b border-line-soft px-2 py-2.5 text-muted">{s.staffId ? "Su disponibilidad" : "Toda la sede"}</td>
                            <td className="border-b border-line-soft px-2 py-2.5 text-muted">{s.publicReason ? PUBLIC_REASON_LABEL[s.publicReason as PublicAbsenceReason] : "Sin motivo"}</td>
                            <td className="truncate border-b border-line-soft px-2 py-2.5 text-muted">{s.reason ?? "—"}</td>
                            <td className="border-b border-line-soft px-2 py-2.5 text-right">
                              {occ ? <Button size="sm" onClick={() => setPanel({ kind: "series", occ, owner: s.staffId })}>Editar</Button> : null}
                            </td>
                          </tr>
                        );
                      })}
                      {upcoming.map((e) => (
                        <tr key={e.id}>
                          <td className="border-b border-line-soft px-2 py-2.5 font-medium">{nameOf(e.staff_id)}</td>
                          <td className="u-tnum border-b border-line-soft px-2 py-2.5">{whenOf(e)}</td>
                          <td className="border-b border-line-soft px-2 py-2.5 text-muted">{e.staff_id ? "Su disponibilidad" : "Toda la sede"}</td>
                          <td className="border-b border-line-soft px-2 py-2.5 text-muted">{e.public_reason ? PUBLIC_REASON_LABEL[e.public_reason] : "Sin motivo"}</td>
                          <td className="truncate border-b border-line-soft px-2 py-2.5 text-muted">{e.reason ?? "—"}</td>
                          <td className="border-b border-line-soft px-2 py-2.5 text-right">
                            <Button size="sm" onClick={() => setPanel({ kind: "dated", block: e })}>Editar</Button>
                          </td>
                        </tr>
                      ))}
                      {upcoming.length + blockSeries.length === 0 ? (
                        <tr>
                          <td colSpan={6} className="px-2 py-6 text-center text-[13px] text-muted">
                            {series === null && !seriesError ? "Cargando…" : "No hay ausencias ni cierres próximos."}
                          </td>
                        </tr>
                      ) : null}
                    </>
                  ) : past.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-2 py-6 text-center text-[13px] text-muted">Sin ausencias en los últimos 90 días.</td>
                    </tr>
                  ) : (
                    past.map((e) => (
                      <tr key={e.id} className="text-muted">
                        <td className="border-b border-line-soft px-2 py-2.5">{nameOf(e.staff_id)}</td>
                        <td className="u-tnum border-b border-line-soft px-2 py-2.5">{whenOf(e)}</td>
                        <td className="border-b border-line-soft px-2 py-2.5">{e.staff_id ? "Su disponibilidad" : "Toda la sede"}</td>
                        <td className="border-b border-line-soft px-2 py-2.5">{e.public_reason ? PUBLIC_REASON_LABEL[e.public_reason] : "Sin motivo"}</td>
                        <td className="truncate border-b border-line-soft px-2 py-2.5">{e.reason ?? "—"}</td>
                        <td className="border-b border-line-soft px-2 py-2.5 text-right text-[12px]">Historial</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            {seriesError ? <p className="text-[13px] text-muted">No pudimos cargar los bloqueos recurrentes. <button type="button" className="underline" onClick={() => void load()}>Reintentar</button></p> : null}
          </section>
          {props.footer}
        </div>
      </div>

      {panel?.kind === "new" || panel?.kind === "dated" ? (
        <BlockPanel
          clientId={props.clientId}
          siteId={site.id}
          siteName={site.name}
          timezone={tz}
          staff={staff.map((s) => ({ id: s.id, name: s.name }))}
          canSiteClosure
          canStaffTimeOff
          title={panel.kind === "new" ? panel.title : undefined}
          edit={panel.kind === "dated" ? panel.block : undefined}
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
          siteId={site.id}
          timezone={tz}
          occ={panel.occ}
          ownerName={panel.owner ? nameOf(panel.owner) : null}
          canEdit
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
          siteId={site.id}
          timezone={tz}
          item={resched.item}
          holds={resched.holds}
          staff={staff.map((s) => ({ id: s.id, name: s.name }))}
          openWeekdays={new Set(Object.entries(site.opening_hours).filter(([, r]) => r.length > 0).map(([k]) => k))}
          lockStaffId={null}
          returnLabel={panel?.kind === "series" ? "el bloqueo" : editingSite ? "el horario" : "la ausencia"}
          onBack={(moved) => {
            setResched(null);
            setRecheck((n) => n + 1);
            if (moved) router.refresh();
          }}
        />
      ) : null}
      {notice ? (
        <div role="status" aria-live="polite" className="fixed bottom-6 left-1/2 z-[90] flex min-h-[44px] -translate-x-1/2 items-center gap-2 rounded-sch-control bg-foreground px-4 text-sm text-background shadow-[var(--shadow-float)]">
          <span aria-hidden>✓</span>
          {notice}
        </div>
      ) : null}
    </section>
  );
}

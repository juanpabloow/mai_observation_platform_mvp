"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { listScheduleSeriesAction, type SeriesView } from "@/lib/scheduleSeriesActions";
import { nextOccurrence, seriesWhen } from "@/lib/seriesOccurrence";
import { PUBLIC_REASON_LABEL } from "@/lib/publicAbsenceReason";
import type { Exception, Site, Staff } from "../../AdminPanel";
import { BlockPanel, type DatedBlock } from "../../agenda/BlockPanel";
import { SeriesPanel, type OccurrenceRef } from "../../agenda/SeriesPanel";
import { AffectedReschedulePanel } from "../../agenda/AffectedReschedulePanel";
import type { AffectedItem } from "../../agenda/ScheduleFormParts";
import { MButton, MSegmented, MStaffAvatar, Sheet } from "../kit";
import { BLOCK_TEMPLATES, blockDraft, blockWhen, zonedParts } from "./logic";
import { CARD_M, Chevron, ErrorNote, ROW_M, Screen, SubHeader, siteStaffColors, type ConfigNav } from "./ui";

const todayIn = (tz: string) => zonedParts(new Date(), tz).key;

function TemplatePills({ onPick }: { onPick: (t: string) => void }) {
  return (
    <div className="flex flex-wrap gap-[8px]">
      {BLOCK_TEMPLATES.map((t) => (
        <button key={t} type="button" onClick={() => onPick(t)} className="flex min-h-[44px] items-center rounded-[12px] border border-m-bd bg-m-sf px-[14px] text-[15px] text-m-tx">
          {t}
        </button>
      ))}
    </div>
  );
}

/**
 * The recurring BLOCKS of every site (audit 23 Oct: the phone listed only dated
 * exceptions, so a series created from the calendar had no entry here). The SAME action
 * as the desktop's Horarios y ausencias; breaks are not blocks and stay in each schedule.
 */
export function useBlockSeries(clientId: string, sites: Site[]) {
  const siteKey = sites.map((s) => s.id).join("|");
  const [state, setState] = useState<{ key: string; list: Array<SeriesView & { siteId: string }> | null; error: boolean }>({ key: "", list: null, error: false });
  const load = useCallback(() => {
    const ids = siteKey ? siteKey.split("|") : [];
    Promise.all(ids.map((id) => listScheduleSeriesAction(clientId, id).then((r) => ({ id, r }))))
      .then((rs) => {
        const failed = rs.some((x) => !x.r.ok);
        const list = rs.flatMap((x) => (x.r.ok ? x.r.series.filter((s) => s.kind === "block").map((s) => ({ ...s, siteId: x.id })) : []));
        setState({ key: siteKey, list: failed ? null : list, error: failed });
      })
      .catch(() => setState({ key: siteKey, list: null, error: true }));
  }, [clientId, siteKey]);
  useEffect(load, [load]);
  const fresh = state.key === siteKey;
  return { series: fresh ? state.list : null, error: fresh && state.error, reload: load };
}

type Panel =
  | { kind: "new"; siteId: string; template: string | null }
  | { kind: "dated"; siteId: string; block: DatedBlock }
  | { kind: "series"; siteId: string; occ: OccurrenceRef; owner: string | null };

// ── 4.10 Bloqueos · 4.11 vacío ───────────────────────────────────────────────────

/**
 * ONE list of what takes time away — dated blocks AND recurring series — opening the SAME
 * editors as the desktop (BlockPanel, SeriesPanel, full screen on a phone), with the
 * affected appointments and «Reagendar». «Nuevo bloqueo» (and `?m=bloqueo-nuevo`, kept for
 * old links) opens BlockPanel, which also creates recurring blocks. Past blocks are history.
 */
export function BlocksList({
  nav,
  clientId,
  sites,
  staff,
  exceptions,
  past,
  toast,
  startNew = false,
  template = null,
}: {
  nav: ConfigNav;
  clientId: string;
  sites: Site[];
  staff: Staff[];
  exceptions: Exception[];
  /** Ended in the last 90 days (read-only history). */
  past: Exception[];
  toast: (m: string) => void;
  /** Open «Nuevo bloqueo» right away (the old `?m=bloqueo-nuevo` link). */
  startNew?: boolean;
  template?: string | null;
}) {
  const router = useRouter();
  const activeSites = sites.filter((s) => s.active);
  const [siteId, setSiteId] = useState(activeSites[0]?.id ?? sites[0]?.id ?? "");
  const site = sites.find((s) => s.id === siteId) ?? sites[0];
  const { series, error: seriesError, reload } = useBlockSeries(clientId, sites);
  const validTemplate = template && (BLOCK_TEMPLATES as readonly string[]).includes(template) ? template : null;
  const [panel, setPanel] = useState<Panel | null>(() => (startNew && site ? { kind: "new", siteId: site.id, template: validTemplate } : null));
  const [resched, setResched] = useState<{ item: AffectedItem; holds: string[] } | null>(null);
  const [recheck, setRecheck] = useState(0);
  const [history, setHistory] = useState<Exception | null>(null);
  const [tab, setTab] = useState<"next" | "past">("next");
  const [nowMs] = useState(() => Date.now());
  const multiSite = sites.length > 1;
  const inSite = <T extends { site_id: string }>(xs: T[]) => (multiSite ? xs.filter((x) => x.site_id === siteId) : xs);
  const upcoming = useMemo(() => [...inSite(exceptions)].sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at)), [exceptions, siteId]); // eslint-disable-line react-hooks/exhaustive-deps
  const ended = useMemo(() => [...inSite(past)].sort((a, b) => Date.parse(b.starts_at) - Date.parse(a.starts_at)), [past, siteId]); // eslint-disable-line react-hooks/exhaustive-deps
  const siteSeries = (series ?? []).filter((x) => !multiSite || x.siteId === siteId);
  const nameOf = (id: string | null) => (id ? staff.find((p) => p.id === id)?.name ?? "Profesional" : "Toda la sede");
  const colors = siteStaffColors(staff, siteId);
  const tz = site?.timezone ?? "UTC";

  const done = (message: string) => {
    setPanel(null);
    toast(message);
    reload();
    router.refresh();
  };
  const panelSite = panel ? sites.find((s) => s.id === panel.siteId) ?? site : null;
  const panelStaff = panelSite ? staff.filter((p) => p.site_id === panelSite.id && p.active).map((p) => ({ id: p.id, name: p.name })) : [];
  const openNew = (tpl: string | null = null) => site && setPanel({ kind: "new", siteId: site.id, template: tpl });
  const prefill = (tpl: string | null) => {
    if (!tpl || !panelSite) return undefined;
    const d = blockDraft(panelSite.id, todayIn(panelSite.timezone), tpl);
    return { reason: d.reason, who: d.scope, date: d.from, endDate: d.to, allDay: d.allDay, start: d.h1, end: d.h2 };
  };
  const count = upcoming.length + siteSeries.length;

  return (
    <Screen
      label="Bloqueos"
      header={<SubHeader backLabel={nav.rootLabel ?? "Configuración"} onBack={() => nav.back(null)} title="Bloqueos" sub="Horas en las que no se aceptan citas" />}
      footer={
        <MButton kind="primary" grow onClick={() => openNew()} disabled={sites.length === 0}>
          Nuevo bloqueo
        </MButton>
      }
    >
      {seriesError ? (
        <ErrorNote>
          No pudimos cargar los bloqueos recurrentes.{" "}
          <button type="button" className="underline" onClick={reload}>
            Reintentar
          </button>
        </ErrorNote>
      ) : null}
      {multiSite ? (
        <label className="flex flex-col gap-[6px] text-[14px] text-m-tx2">
          Sede
          <select value={siteId} onChange={(e) => setSiteId(e.target.value)} className="min-h-[48px] rounded-[12px] border border-m-bd bg-m-sf px-[12px] text-[16px] text-m-tx">
            {sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {s.active ? "" : " (inactiva)"}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {sites.length > 0 ? (
        <MSegmented
          label="Bloqueos"
          stretch
          value={tab}
          options={[
            { value: "next", label: `Próximos ${series === null && !seriesError ? upcoming.length : count}` },
            { value: "past", label: `Pasados ${ended.length}` },
          ]}
          onChange={setTab}
        />
      ) : null}
      {sites.length === 0 ? (
        <div className={`${CARD_M} px-[18px] py-[24px] text-[14px] text-m-tx3`}>Crea una sede para poder bloquear horarios.</div>
      ) : tab === "past" ? (
        ended.length === 0 ? (
          <div className={`${CARD_M} px-[18px] py-[24px] text-[14px] text-m-tx3`}>Todavía no hay bloqueos pasados.</div>
        ) : (
          <div className={CARD_M}>
            {ended.map((e) => (
              <button key={e.id} type="button" onClick={() => setHistory(e)} className={`${ROW_M} min-h-[76px] text-m-tx2`}>
                <span className="flex min-w-0 flex-1 flex-col gap-[4px]">
                  <span className="text-[16px] font-semibold [overflow-wrap:anywhere]">{e.reason || "Bloqueo de agenda"}</span>
                  <span className="u-tnum text-[14px]">{blockWhen(e, tz, todayIn(tz))}</span>
                  <span className="truncate text-[13px] text-m-tx3">{nameOf(e.staff_id)}</span>
                </span>
                <Chevron />
              </button>
            ))}
          </div>
        )
      ) : count === 0 && series !== null ? (
        <div className={`${CARD_M} flex flex-col gap-[14px] px-[18px] py-[24px]`}>
          <div className="flex flex-col gap-[4px]">
            <span className="text-[16px] font-semibold">No hay bloqueos próximos</span>
            <span className="text-[14px] leading-[1.45] text-m-tx3">Empieza con una plantilla. Solo rellena el formulario: nada se guarda hasta que lo confirmes.</span>
          </div>
          <TemplatePills onPick={(t) => openNew(t)} />
        </div>
      ) : (
        <section className="flex flex-col gap-[8px]">
          <h2 className="sr-only">Próximos</h2>
          <div className={CARD_M} aria-busy={series === null && !seriesError ? true : undefined}>
            {siteSeries.map((sv) => {
              const occ = nextOccurrence(sv, sv.siteId, todayIn(tz), tz, nowMs);
              const member = sv.staffId ? staff.find((p) => p.id === sv.staffId) : undefined;
              return (
                <button
                  key={sv.id}
                  type="button"
                  disabled={!occ}
                  onClick={() => occ && setPanel({ kind: "series", siteId: sv.siteId, occ, owner: sv.staffId })}
                  className={`${ROW_M} min-h-[76px] disabled:opacity-60`}
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-[4px]">
                    <span className="flex min-w-0 items-center gap-[8px]">
                      <span className="truncate text-[16px] font-semibold">{sv.reason || "Bloqueo recurrente"}</span>
                      <span className="flex-none rounded-full bg-m-sf2 px-[8px] py-[2px] text-[12px] text-m-tx2">Se repite</span>
                    </span>
                    <span className="u-tnum text-[14px] text-m-tx2">{seriesWhen(sv)}</span>
                    <span className="flex min-w-0 items-center gap-[6px] text-[13px] text-m-tx3">
                      {member ? <MStaffAvatar id={member.id} name={member.name} size={28} color={colors.get(member.id)} /> : <span aria-hidden>⌂</span>}
                      <span className="truncate">{nameOf(sv.staffId)}{sv.publicReason ? ` · El cliente ve: ${PUBLIC_REASON_LABEL[sv.publicReason as keyof typeof PUBLIC_REASON_LABEL] ?? "—"}` : ""}</span>
                    </span>
                  </span>
                  <Chevron />
                </button>
              );
            })}
            {upcoming.map((e) => {
              const member = e.staff_id ? staff.find((p) => p.id === e.staff_id) : undefined;
              return (
                <button key={e.id} type="button" onClick={() => setPanel({ kind: "dated", siteId: e.site_id, block: e })} className={`${ROW_M} min-h-[76px]`}>
                  <span className="flex min-w-0 flex-1 flex-col gap-[4px]">
                    <span className="text-[16px] font-semibold [overflow-wrap:anywhere]">{e.reason || "Bloqueo de agenda"}</span>
                    <span className="u-tnum text-[14px] text-m-tx2">{blockWhen(e, tz, todayIn(tz))}</span>
                    <span className="flex min-w-0 items-center gap-[6px] text-[13px] text-m-tx3">
                      {member ? <MStaffAvatar id={member.id} name={member.name} size={28} color={colors.get(member.id)} /> : <span aria-hidden>⌂</span>}
                      <span className="truncate">{nameOf(e.staff_id)}</span>
                    </span>
                  </span>
                  <Chevron />
                </button>
              );
            })}
            {series === null && !seriesError ? <p className="px-[14px] py-[12px] text-[14px] text-m-tx3">Cargando bloqueos recurrentes…</p> : null}
          </div>
        </section>
      )}

      {/* A past block is history: shown, not edited or deleted. */}
      <Sheet open={history !== null} onClose={() => setHistory(null)} label={history?.reason || "Bloqueo de agenda"}>
        {history ? (
          <div className="flex flex-col gap-[14px] px-[16px] pb-[max(20px,env(safe-area-inset-bottom))]">
            <div className="flex flex-col gap-[4px]">
              <span className="text-[18px] font-semibold [overflow-wrap:anywhere]">{history.reason || "Bloqueo de agenda"}</span>
              <span className="u-tnum text-[15px] text-m-tx2">{blockWhen(history, tz, todayIn(tz))}</span>
            </div>
            <div className={CARD_M}>
              {[
                ["Alcance", nameOf(history.staff_id)],
                ["Sede", sites.find((s) => s.id === history.site_id)?.name ?? "—"],
                ["Cliente", history.public_reason ? PUBLIC_REASON_LABEL[history.public_reason] : "Sin motivo"],
              ].map(([k, v], i) => (
                <div key={k} className={`flex min-h-[48px] items-center gap-[12px] px-[14px] py-[10px] ${i ? "border-t border-m-dv" : ""}`}>
                  <span className="w-[90px] flex-none text-[14px] text-m-tx3">{k}</span>
                  <span className="min-w-0 text-[15px]">{v}</span>
                </div>
              ))}
            </div>
            <MButton kind="soft" className="w-full" onClick={() => setHistory(null)}>
              Cerrar
            </MButton>
            {Date.parse(history.ends_at) > nowMs ? null : <span className="text-[13px] text-m-tx3">Ya terminó: queda como historial.</span>}
          </div>
        ) : null}
      </Sheet>

      {/* The desktop's editors, in the agenda's tokens; full screen on a phone. */}
      <div className="u-ag">
        {panel && panelSite && (panel.kind === "new" || panel.kind === "dated") ? (
          <BlockPanel
            clientId={clientId}
            siteId={panelSite.id}
            siteName={panelSite.name}
            timezone={panelSite.timezone}
            staff={panelStaff}
            canSiteClosure
            canStaffTimeOff
            title={panel.kind === "new" ? "Nuevo bloqueo" : undefined}
            prefill={panel.kind === "new" ? prefill(panel.template) : undefined}
            edit={panel.kind === "dated" ? panel.block : undefined}
            hidden={Boolean(resched)}
            recheck={recheck}
            onReschedule={(item, holds) => setResched({ item, holds })}
            onClose={() => setPanel(null)}
            onSaved={done}
          />
        ) : null}
        {panel && panelSite && panel.kind === "series" ? (
          <SeriesPanel
            clientId={clientId}
            siteId={panelSite.id}
            timezone={panelSite.timezone}
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
        {resched && panelSite ? (
          <AffectedReschedulePanel
            clientId={clientId}
            siteId={panelSite.id}
            timezone={panelSite.timezone}
            item={resched.item}
            holds={resched.holds}
            staff={panelStaff}
            openWeekdays={new Set(Object.entries(panelSite.opening_hours).filter(([, r]) => r.length > 0).map(([k]) => k))}
            lockStaffId={null}
            returnLabel={panel?.kind === "series" ? "el bloqueo" : "la ausencia"}
            onBack={(moved) => {
              setResched(null);
              setRecheck((n) => n + 1);
              if (moved) router.refresh();
            }}
          />
        ) : null}
      </div>
    </Screen>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import s from "./valueDashboard.module.css";
import { Chip, cx, InfoIcon, KindTag, TipBox, tipAttr, V } from "./bits";
import { AttentionCard, BotActionsCard, CohortCard, EstimateCard, HealthCard, OutOfHoursCard, ReservationsCard, Seg } from "./sections";
import { AssumptionsDialog } from "./AssumptionsDialog";
import { QualityDialog } from "./QualityDialog";
import { buttonClass, FIELD } from "@/components/ui/controls";
import { useIsOverlayWidth } from "@/components/ui/Overlay";
import {
  comparisonLine,
  customCompareNote,
  dailyBars,
  detailGroups,
  estimateView,
  fmtDay,
  fmtRange,
  kpis as buildKpis,
  METRIC_TEXT,
  qualityRows,
  qualitySummary,
  updatedLabel,
  type LensKey,
  type MetricId,
  type ModeKey,
} from "@/lib/valueDashboardView";
import { localToday, PERIOD_MAX_DAYS, resolvePeriod, type PeriodKey, type ValueDashboardData } from "@worker/analytics/valueDashboardModel.js";

/**
 * VALUE DASHBOARD — the client shell (prototype «Dashboard Valor», spec v3.1).
 *
 * Data: the first period is server-rendered; a period change fetches
 * /api/analytics/{client}/value. Every request carries a sequence number and aborts the one
 * before it, so a slow OLD response can never overwrite the NEW selection. While a period
 * loads, every data-dependent value becomes a neutral placeholder (no stale number, no $0)
 * and bars drop to their base; values return exact, fading in.
 */

type Sel = { key: PeriodKey; from: string; to: string };

export function ValueDashboard({
  clientId,
  initial,
  initialError,
}: {
  clientId: string;
  initial: ValueDashboardData | null;
  initialError: string | null;
}) {
  const [data, setData] = useState<ValueDashboardData | null>(initial);
  const [status, setStatus] = useState<"ready" | "loading" | "error">(initial ? "ready" : "error");
  const [errorMsg, setErrorMsg] = useState<string | null>(initialError);
  const [sel, setSel] = useState<Sel>(() =>
    initial ? { key: initial.period.key, from: initial.period.fromDay, to: initial.period.toDay } : { key: "30", from: "", to: "" },
  );
  const [lens, setLens] = useState<LensKey>("creadas");
  const [mode, setMode] = useState<ModeKey>("count");
  const [detail, setDetail] = useState<{ open: boolean; metric: MetricId }>({ open: false, metric: "res" });
  const [help, setHelp] = useState<MetricId | null>(null);
  const [pop, setPop] = useState<"quality" | "custom" | null>(null);
  // Horizontal shift of the quality popover so it always fits the viewport (on phones its
  // trigger sits mid-row and a left-anchored 320px card ran off the right edge).
  const [qualityShift, setQualityShift] = useState(0);
  const [dialog, setDialog] = useState<"assumptions" | "quality" | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [draftRange, setDraftRange] = useState<{ from: string; to: string }>({ from: sel.from, to: sel.to });
  const [today] = useState(() => localToday(new Date(), initial?.tz ?? "America/Bogota"));
  const narrow = useIsOverlayWidth(1099.98);

  const seq = useRef(0);
  const ctrl = useRef<AbortController | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const helpRef = useRef<HTMLDivElement | null>(null);
  const qualityBtnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(
    () => () => {
      ctrl.current?.abort();
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );

  // Escape and outside-click close the open popover / help.
  useEffect(() => {
    if (!pop && !help) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPop(null);
        setHelp(null);
      }
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || helpRef.current?.contains(t)) return;
      setPop(null);
      setHelp(null);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [pop, help]);

  function flash(msg: string) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(msg);
    toastTimer.current = setTimeout(() => setToast(null), 2800);
  }

  async function load(next: Sel) {
    const id = ++seq.current;
    ctrl.current?.abort();
    const ac = new AbortController();
    ctrl.current = ac;
    setSel(next);
    setStatus("loading");
    const qs = new URLSearchParams({ periodo: next.key });
    if (next.key === "custom") {
      qs.set("desde", next.from);
      qs.set("hasta", next.to);
    }
    try {
      const res = await fetch(`/api/analytics/${clientId}/value?${qs}`, { signal: ac.signal, cache: "no-store" });
      const json = await res.json();
      if (id !== seq.current) return; // a newer selection owns the screen
      if (!res.ok) {
        setErrorMsg(typeof json?.error === "string" && res.status === 400 ? json.error : null);
        setStatus("error");
        return;
      }
      setData(json as ValueDashboardData);
      setErrorMsg(null);
      setStatus("ready");
      window.history.replaceState(null, "", `${window.location.pathname}?${qs}`);
    } catch {
      if (ac.signal.aborted || id !== seq.current) return;
      setErrorMsg(null);
      setStatus("error");
    }
  }

  function pickPeriod(key: PeriodKey) {
    setHelp(null);
    if (key === "custom") {
      setDraftRange(sel.key === "custom" ? { from: sel.from, to: sel.to } : { from: data?.period.fromDay ?? "", to: data?.period.toDay ?? "" });
      setPop(pop === "custom" ? null : "custom");
      return;
    }
    setPop(null);
    const r = resolvePeriod({ key }, new Date(), data?.tz ?? "America/Bogota");
    if (r.ok) void load({ key, from: r.period.fromDay, to: r.period.toDay });
  }

  const customError =
    draftRange.from && draftRange.to
      ? draftRange.from > draftRange.to
        ? "La fecha inicial debe ser anterior a la final."
        : draftRange.to > today
          ? "El periodo no puede terminar después de hoy."
          : Math.round((Date.parse(draftRange.to) - Date.parse(draftRange.from)) / 86_400_000) + 1 > PERIOD_MAX_DAYS
            ? `Máximo ${PERIOD_MAX_DAYS} días.`
            : null
      : "Elige las dos fechas.";

  function applyCustom() {
    if (customError) return;
    setPop(null);
    void load({ key: "custom", from: draftRange.from, to: draftRange.to });
  }

  function openMetric(id: MetricId) {
    setHelp(null);
    setDetail((d) => (d.open && d.metric === id ? { ...d, open: false } : { open: true, metric: id }));
  }

  const loading = status === "loading";

  /* ----------------------------------------------------- hard error, no data -- */
  if (!data) {
    return (
      <div className={s.root}>
        <ErrorBlock message={errorMsg} onRetry={() => void load(sel)} retrying={loading} />
      </div>
    );
  }

  const ev = estimateView(data);
  const kpis = buildKpis(data, ev);
  const vk = `${data.period.fromDay}-${data.period.toDay}-${data.generatedAt}`;
  const qs = qualitySummary(data);
  const pendingRange = fmtRange(sel.from || data.period.fromDay, sel.to || data.period.toDay);
  const automatedCount = kpis[0].value;
  const noActivity =
    !loading && status !== "error" && automatedCount === "0" && data.health.executions === 0 && (!data.conversations || totalOf(data) === 0);
  const groups = detailGroups(data, detail.metric, ev);
  const bars = dailyBars(data, detail.metric, ev);
  const maxBar = Math.max(0, ...bars.map((b) => b.v ?? 0));
  const dk = kpis.find((k) => k.id === detail.metric)!;

  return (
    <div className={s.root} aria-busy={loading || undefined}>
      {/* ---------------------------------------------------------- header -- */}
      <header style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div className={s.headRow}>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, flex: 1, minWidth: 0 }}>
            <h1 className={s.h1}>El valor de tu automatización</h1>
            <div className={s.meta}>
              <span>{loading ? "Actualizando…" : updatedLabel(data.generatedAt, data.tz)}</span>
              <span aria-hidden style={{ color: "var(--faintest)" }}>
                ·
              </span>
              <div style={{ position: "relative" }} ref={pop === "quality" ? popRef : undefined}>
                <button
                  ref={qualityBtnRef}
                  type="button"
                  aria-expanded={pop === "quality"}
                  aria-haspopup="dialog"
                  onClick={(e) => {
                    setHelp(null);
                    if (pop !== "quality") {
                      const left = e.currentTarget.getBoundingClientRect().left;
                      const vw = document.documentElement.clientWidth;
                      const width = Math.min(320, vw - 32);
                      setQualityShift(Math.min(0, vw - 16 - width - left));
                    }
                    setPop(pop === "quality" ? null : "quality");
                  }}
                  className={cx(s.qualityBtn, "u-focus")}
                >
                  <span className={cx(s.dot, qs.tone === "ok" ? s.dotOk : s.dotWarn)} aria-hidden />
                  {qs.label}
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
                    <path d="M4 6l4 4 4-4" />
                  </svg>
                </button>
                {pop === "quality" ? (
                  <div role="dialog" aria-label="Calidad de los datos" className={s.popover} style={{ top: 50, left: qualityShift, width: "min(320px, calc(100vw - 32px))" }}>
                    <span style={{ fontSize: 14, fontWeight: 600 }}>Calidad de los datos</span>
                    {qualityRows(data).map((q) => (
                      <div key={q.label} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <span className={s.secondary} style={{ flex: 1 }}>
                          {q.label}
                        </span>
                        <Chip tone={q.tone}>{q.status}</Chip>
                      </div>
                    ))}
                    <span className={s.note} style={{ lineHeight: 1.45 }}>
                      Si algo no tiene evidencia suficiente lo indicamos en su sección, nunca con un cero.
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setPop(null);
                        setDialog("quality");
                      }}
                      className={buttonClass({ variant: "secondary", size: "sm" })}
                      style={{ alignSelf: "flex-start" }}
                    >
                      Ver estado de los datos
                    </button>
                  </div>
                ) : null}
              </div>
              <span className={s.metaTag}>{data.viewer === "agency" ? "Vista agencia" : "Vista dueño"}</span>
              <span
                className={s.metaChip}
                title="Las conversaciones no se pueden atribuir a una sede, por eso el resumen usa datos del negocio."
              >
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
                  <path d="M2.5 13.5V6l5.5-3.5L13.5 6v7.5z" />
                  <path d="M6.5 13.5v-4h3v4" />
                </svg>
                Datos del negocio · {data.sites.length === 1 ? "1 sede" : `${data.sites.length} sedes`}
              </span>
            </div>
          </div>
          <div className={s.periodBox} ref={pop === "custom" ? popRef : undefined}>
            <Seg
              label="Periodo"
              full
              value={sel.key}
              onChange={pickPeriod}
              options={[
                ["7", "7 días"],
                ["30", "30 días"],
                ["custom", sel.key === "custom" && sel.from ? fmtRange(sel.from, sel.to, false) : "Personalizado"],
              ]}
            />
            <span className={s.rangeLine} aria-live="polite">
              {loading ? `Cargando ${pendingRange}…` : comparisonLine(data)}
            </span>
            {pop === "custom" ? (
              <div role="dialog" aria-label="Periodo personalizado" className={cx(s.popover, s.popRight)} style={{ top: 50, right: 0, width: "min(320px, calc(100vw - 32px))", gap: 12 }}>
                <span style={{ fontSize: 14, fontWeight: 600 }}>Periodo personalizado</span>
                <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 10 }}>
                  <label style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 12.5 }} className={s.secondary}>
                    Desde
                    <input
                      type="date"
                      className={cx(FIELD, "h-[44px] lg:h-[40px]")}
                      value={draftRange.from}
                      max={today}
                      onChange={(e) => setDraftRange((r) => ({ ...r, from: e.target.value }))}
                    />
                  </label>
                  <label style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 12.5 }} className={s.secondary}>
                    Hasta
                    <input
                      type="date"
                      className={cx(FIELD, "h-[44px] lg:h-[40px]")}
                      value={draftRange.to}
                      max={today}
                      onChange={(e) => setDraftRange((r) => ({ ...r, to: e.target.value }))}
                    />
                  </label>
                </div>
                <span className={s.note} style={{ lineHeight: 1.45 }} aria-live="polite">
                  {customError ?? customCompareNote(draftRange.from, draftRange.to)}
                </span>
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                  <button type="button" onClick={() => setPop(null)} className={buttonClass({ variant: "secondary" })}>
                    Cancelar
                  </button>
                  <button type="button" onClick={applyCustom} disabled={!!customError} className={buttonClass({ variant: "primary" })}>
                    Aplicar
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </header>

      {/* --------------------------------------------------------- banners -- */}
      {!loading && status !== "error" && data.coverage ? (
        <div role="status" className={cx(s.banner, s.bannerWarn)}>
          <WarnIcon />
          <span>
            <strong style={{ fontWeight: 600 }}>Datos parciales.</strong> La agenda registra citas desde el {fmtDay(data.coverage.since, true)}, a mitad del periodo: los
            totales cubren {data.coverage.coveredDays} de {data.period.days} días y no hay comparación con el periodo anterior.
          </span>
        </div>
      ) : null}
      {noActivity ? (
        <div role="status" className={cx(s.banner, s.bannerInfo)}>
          <InfoIcon />
          <span>
            <strong style={{ fontWeight: 600, color: "var(--foreground)" }}>Sin actividad automatizada en este periodo.</strong> No hubo reservas del bot ni de la página
            ni ejecuciones: los ceros son medidos. Prueba con otro periodo o revisa que tus workflows estén activos.
          </span>
        </div>
      ) : null}

      {status === "error" ? (
        <ErrorBlock message={errorMsg} onRetry={() => void load(sel)} retrying={false} />
      ) : (
        <>
          {/* ------------------------------------------------------- KPIs -- */}
          <section aria-label="Resumen" className={s.kpis}>
            {kpis.map((k, i) => {
              const sel = detail.open && detail.metric === k.id;
              const t = METRIC_TEXT[k.id];
              return (
                <div
                  key={k.id}
                  className={cx(s.kpi, s.enter, k.kind === "estimate" && s.kpiEst, sel && s.kpiSel, help === k.id && s.kpiRaised)}
                  style={{ ["--i" as string]: i }}
                  ref={help === k.id ? helpRef : undefined}
                  // The WHOLE card opens its breakdown. Its own controls (the help button,
                  // the breakdown button, the help popover) handle their clicks themselves;
                  // keyboard users reach the same action through the inner button.
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest("button, a, input, [role=dialog]")) return;
                    openMetric(k.id);
                  }}
                >
                  <div style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
                    <span className={s.kpiLabel}>{k.label}</span>
                    <button
                      type="button"
                      className={cx(s.infoBtn, "u-focus")}
                      aria-label={`Qué mide: ${k.label}`}
                      aria-expanded={help === k.id}
                      onClick={() => {
                        setPop(null);
                        if (narrow) openMetric(k.id);
                        else setHelp(help === k.id ? null : k.id);
                      }}
                    >
                      <InfoIcon />
                    </button>
                  </div>
                  <button type="button" className={s.kpiOpen} onClick={() => openMetric(k.id)} aria-expanded={sel} aria-controls="vd-detail">
                    <span className="sr-only">Ver desglose de </span>
                    <V loading={loading} k={vk} w="6ch" className={cx(s.kpiValue, k.small && s.kpiValueSmall)}>
                      {k.value}
                    </V>
                    <V loading={loading} k={vk} w="14ch" className={cx(s.delta, s[k.delta.tone])}>
                      {k.delta.text}
                    </V>
                  </button>
                  <div className={s.kpiFoot}>
                    <KindTag kind={k.kind} />
                    <V loading={loading} k={vk} w="10ch" className={s.note}>
                      {k.note}
                    </V>
                  </div>
                  {help === k.id && !narrow ? (
                    <div role="dialog" aria-label={`Qué mide: ${k.label}`} className={s.popover} style={{ top: 44, left: 12, right: 12, minWidth: 280 }}>
                      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                        <span style={{ fontSize: 12, fontWeight: 600 }}>Qué cuenta</span>
                        <span className={s.secondary}>{t.cuenta}</span>
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                        <span style={{ fontSize: 12, fontWeight: 600 }}>Qué excluye</span>
                        <span className={s.secondary}>{t.excluye}</span>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        <KindTag kind={k.kind} />
                        <span className={s.tertiary}>{t.tipo}</span>
                      </div>
                      <button type="button" onClick={() => openMetric(k.id)} className={buttonClass({ variant: "secondary", size: "sm" })} style={{ alignSelf: "flex-start" }}>
                        Ver desglose
                      </button>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </section>

          {/* ------------------------------------------------ detail panel -- */}
          <div className={cx(s.collapse, detail.open && s.collapseOpen)} inert={!detail.open}>
            <div className={s.collapseInner}>
              <section id="vd-detail" role="region" aria-labelledby="vd-dt" className={s.detail}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                    <h2 id="vd-dt" className={s.h2}>
                      {METRIC_TEXT[detail.metric].label}
                    </h2>
                    <KindTag kind={dk.kind} />
                    <span className={s.tertiary} style={{ fontSize: 13 }}>
                      {fmtRange(data.period.fromDay, data.period.toDay)}
                    </span>
                  </div>
                  <button type="button" onClick={() => setDetail((d) => ({ ...d, open: false }))} className={buttonClass({ variant: "secondary", size: "sm" })} aria-label="Ocultar desglose">
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
                      <path d="M4 10l4-4 4 4" />
                    </svg>
                    Ocultar
                  </button>
                </div>
                <div className={s.detailCols}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <V
                        loading={loading}
                        k={`${vk}-${detail.metric}`}
                        w="6ch"
                        style={{ fontSize: dk.small ? 22 : 36, fontWeight: 600, letterSpacing: "-0.02em", lineHeight: 1.1 }}
                      >
                        {dk.value}
                      </V>
                      <V loading={loading} k={`${vk}-${detail.metric}`} w="14ch" className={cx(s.delta, s[dk.delta.tone])} style={{ fontSize: 14 }}>
                        {dk.delta.text}
                      </V>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                      <span style={{ fontSize: 12.5, fontWeight: 600 }}>Qué cuenta</span>
                      <span className={s.secondary} style={{ fontSize: 13.5, lineHeight: 1.5 }}>
                        {METRIC_TEXT[detail.metric].cuenta}
                      </span>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                      <span style={{ fontSize: 12.5, fontWeight: 600 }}>Qué excluye</span>
                      <span className={s.secondary} style={{ fontSize: 13.5, lineHeight: 1.5 }}>
                        {METRIC_TEXT[detail.metric].excluye}
                      </span>
                    </div>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
                    {groups.map((g) => (
                      <div key={g.title} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                        <span className={s.overline}>{g.title}</span>
                        {g.rows.map((r) => (
                          <div key={r.label} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                            <div style={{ display: "flex", alignItems: "baseline", gap: 10, fontSize: 14 }}>
                              <span className={s.secondary} style={{ flex: 1 }}>
                                {r.label}
                              </span>
                              <V loading={loading} k={`${vk}-${detail.metric}`} w="5ch" style={{ fontWeight: 600 }}>
                                {r.val}
                              </V>
                            </div>
                            {r.widthPct !== null ? (
                              <span className={s.track} style={{ height: 6 }} aria-hidden>
                                <span className={cx(s.fill, s[`t-${r.tone}`])} style={{ width: `${loading ? 0 : r.widthPct}%` }} />
                              </span>
                            ) : null}
                            {r.sub ? <span className={s.note}>{r.sub}</span> : null}
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
                    <span className={s.overline}>POR DÍA</span>
                    <TipBox>
                    <div role="img" aria-label={`Distribución diaria: ${METRIC_TEXT[detail.metric].label}`} className={s.days}>
                      {bars.map((b) => (
                        <span
                          key={`${detail.metric}-${b.day}`}
                          {...tipAttr(b.tip, loading)}
                          className={cx(
                            s.dayBar,
                            b.v === null ? s.dayUnknown : b.v === 0 ? s.dayEmpty : detail.metric === "time" ? s["t-time"] : s["t-n8n"],
                          )}
                          style={{ height: loading ? "2%" : b.v === null ? "18%" : `${Math.max(maxBar > 0 ? (b.v / maxBar) * 100 : 0, 2)}%` }}
                        />
                      ))}
                    </div>
                    </TipBox>
                    <div className={s.tertiary} style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                      <span>{fmtDay(data.period.fromDay)}</span>
                      <span>{fmtDay(data.period.toDay)}</span>
                    </div>
                    {bars.some((b) => b.v === null) ? (
                      <span className={s.note}>
                        {detail.metric === "time" ? "Días rayados: sin supuestos vigentes." : "Días rayados: había citas, pero ninguna con precio guardado."}
                      </span>
                    ) : null}
                    {detail.metric === "time" ? (
                      <button type="button" onClick={() => setDialog("assumptions")} className={buttonClass({ variant: "primary" })} style={{ marginTop: 8, alignSelf: "flex-start" }}>
                        Revisar supuestos
                      </button>
                    ) : null}
                  </div>
                </div>
              </section>
            </div>
          </div>

          {/* --------------------------------------------------------- grid -- */}
          <div className={s.grid}>
            <ReservationsCard data={data} loading={loading} vk={vk} lens={lens} mode={mode} onLens={setLens} onMode={setMode} style={{ ["--i" as string]: 4 }} />
            <OutOfHoursCard data={data} loading={loading} vk={vk} style={{ ["--i" as string]: 5 }} />
            <AttentionCard data={data} loading={loading} vk={vk} onOpenQuality={() => setDialog("quality")} style={{ ["--i" as string]: 6 }} />
            <EstimateCard data={data} loading={loading} vk={vk} ev={ev} onOpen={() => setDialog("assumptions")} style={{ ["--i" as string]: 7 }} />
            <CohortCard data={data} loading={loading} vk={vk} style={{ ["--i" as string]: 8 }} />
            <BotActionsCard data={data} loading={loading} vk={vk} style={{ ["--i" as string]: 9 }} />
            <HealthCard data={data} loading={loading} vk={vk} style={{ ["--i" as string]: 10 }} />
          </div>
        </>
      )}

      <span className={s.tertiary} style={{ fontSize: 12, textAlign: "center", padding: "4px 0 8px" }}>
        {data.client.name} · Impulsado por M_AI
      </span>

      {dialog === "assumptions" ? (
        <AssumptionsDialog
          clientId={clientId}
          data={data}
          today={today}
          onClose={() => setDialog(null)}
          onSaved={(msg) => {
            setDialog(null);
            flash(msg);
            void load(sel);
          }}
        />
      ) : null}
      {dialog === "quality" ? (
        <QualityDialog
          data={data}
          onClose={() => {
            setDialog(null);
            // Opened from a popover that no longer exists: return focus to its trigger.
            requestAnimationFrame(() => qualityBtnRef.current?.focus());
          }}
        />
      ) : null}
      {toast ? (
        <div role="status" className={s.toast}>
          {toast}
        </div>
      ) : null}
    </div>
  );
}

function totalOf(d: ValueDashboardData): number {
  const k = d.conversations?.classes;
  return k ? k.conIntervencionHumana + k.u2CitaBot + k.enCurso + k.u1RespondidaPorBot + k.conTurnosSinRespuesta : 0;
}

function WarnIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden style={{ flex: "none", marginTop: 2 }}>
      <circle cx="8" cy="8" r="6.2" />
      <path d="M8 4.8v3.8M8 11v.2" />
    </svg>
  );
}

function ErrorBlock({ message, onRetry, retrying }: { message: string | null; onRetry: () => void; retrying: boolean }) {
  return (
    <div
      role="alert"
      className={s.card}
      style={{ padding: "40px 24px", alignItems: "center", gap: 10, textAlign: "center" }}
    >
      <span style={{ width: 44, height: 44, borderRadius: "50%", background: "var(--vd-err-bg)", color: "var(--vd-err)", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
          <path d="M8 2.2l6.2 11H1.8z" />
          <path d="M8 6.6v3M8 11.4v.2" />
        </svg>
      </span>
      <span style={{ fontSize: 17, fontWeight: 600 }}>No pudimos cargar el dashboard</span>
      <span className={s.secondary} style={{ maxWidth: 420, fontSize: 14, lineHeight: 1.5 }}>
        {message ?? "Tus datos no se perdieron: falló la consulta. Vuelve a intentarlo en unos segundos."}
      </span>
      <button type="button" onClick={onRetry} disabled={retrying} className={buttonClass({ variant: "primary" })} style={{ marginTop: 6 }}>
        {retrying ? "Reintentando…" : "Reintentar"}
      </button>
    </div>
  );
}

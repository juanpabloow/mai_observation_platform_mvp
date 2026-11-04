"use client";

import { useEffect, useRef, useState } from "react";
import s from "@/components/value/valueDashboard.module.css";
import a from "./aiCosts.module.css";
import { cx, InfoIcon, KindTag, V } from "@/components/value/bits";
import { Seg as ValueSeg } from "@/components/value/sections";
import { buttonClass, FIELD } from "@/components/ui/controls";
import { fmtRange, updatedLabel } from "@/lib/valueDashboardView";
import type { ExecutionsReport } from "@/lib/n8nExecutions";
import { setN8nPlanAction } from "@/lib/n8nPlanActions";
import { formatDuration } from "@/lib/format";
import { DailyCostChart, dayLong, type ChartDay, type Series } from "./DailyCostChart";
import { UsageCard } from "./UsageCard";
import { baseLabelOf, baseSelOf, periodQuery, RangeControl, ScreenToggle, selOf, type BaseSel, type Sel } from "./periodControls";
import { localToday } from "@worker/analytics/valueDashboardModel.js";
import type { Change } from "@worker/analytics/aiCostModel.js";
import { changeText } from "@worker/analytics/aiCostReport.js";
import { EXEC_METRIC_DIRECTION, type ExecMetricKey, type PlanUsage } from "@worker/analytics/executionsModel.js";

/**
 * COSTOS DE IA → Ejecuciones — how many n8n executions the bots consume and how many of them
 * were worth it. Same header and dates as the costs screen. Agency: every business, the plan of
 * each n8n connection (editable: n8n's API does not tell it), who uses the platform most (per
 * business and per workflow, together or apart) and where executions end. Business owner: only
 * its own executions and workflows, no plan. Counts are MEASURED (they are n8n's own records).
 */

const nf = new Intl.NumberFormat("es-CO");
const int = (v: number | null) => (v === null ? "—" : nf.format(Math.round(v)));
const pctText = (v: number | null) => (v === null ? "—" : `${v.toLocaleString("es-CO", { maximumFractionDigits: 1 })} %`);
const dec = (v: number | null) => (v === null ? "—" : v.toLocaleString("es-CO", { maximumFractionDigits: 1 }));
const dateFmt = new Intl.DateTimeFormat("es-CO", { day: "numeric", month: "short", timeZone: "UTC" });
const shortDate = (iso: string) => dateFmt.format(new Date(iso)).replace(/\./g, "");

function toneOf(metric: ExecMetricKey, c: Change): string {
  if (c.kind !== "pct" || EXEC_METRIC_DIRECTION[metric] === "neutral" || c.pct === 0) return a.muted;
  return c.pct < 0 ? a.good : a.bad;
}

function deltaLine(metric: ExecMetricKey, c: Change, vsLabel: string): { text: string; cls: string } {
  if (c.kind === "unavailable") return { text: `Sin comparación: ${c.reason}`, cls: a.muted };
  if (c.kind === "no_prev") return { text: `Sin actividad ${vsLabel.replace(/^vs /, "en ")}`, cls: a.muted };
  return { text: `${changeText(c)} ${vsLabel}`, cls: toneOf(metric, c) };
}

/** Category colors, validated light + dark (dataviz validator): blue, amber, pink; unknown gray. */
const SERIES: Series[] = [
  { key: "ai", name: "Con IA", color: "var(--ai-s5)" },
  { key: "noai", name: "Sin IA", color: "var(--ai-s3)" },
  { key: "err", name: "Errores", color: "var(--ai-s4)" },
  { key: "unread", name: "Sin leer", color: "var(--vd-tertiary)" },
];

const HELP: Record<"production" | "withAi" | "wastePct" | "perAnswer", { cuenta: string; uso: string }> = {
  production: {
    cuenta: "Ejecuciones de producción que n8n registró: las que cuentan para el plan. Las manuales (pruebas en el editor) no cuentan y van aparte.",
    uso: "Es lo que consume el plan de n8n. Si baja sin que bajen las respuestas, el filtro funcionó.",
  },
  withAi: {
    cuenta: "Ejecuciones que llegaron a llamar al modelo: el bot respondió o trabajó con IA.",
    uso: "El trabajo útil del bot. Sube y baja con el tráfico de clientes.",
  },
  wastePct: {
    cuenta: "De las ejecuciones leídas, cuántas terminaron sin llamar al modelo: avisos de estado de WhatsApp, filtros, modo humano y errores.",
    uso: "Es el desperdicio del plan. Es la métrica que más debe bajar al filtrar los avisos en n8n.",
  },
  perAnswer: {
    cuenta: "Ejecuciones de producción leídas divididas entre las que llegaron al modelo.",
    uso: "Cuántas ejecuciones del plan cuesta cada respuesta del bot. Lo ideal es acercarse a 1.",
  },
};

export function ExecutionsView({
  initial,
  initialError,
  clientId = null,
}: {
  initial: ExecutionsReport | null;
  initialError: string | null;
  clientId?: string | null;
}) {
  const [data, setData] = useState<ExecutionsReport | null>(initial);
  const [status, setStatus] = useState<"ready" | "loading" | "error">(initial ? "ready" : "error");
  const [errorMsg, setErrorMsg] = useState<string | null>(initialError);
  const [sel, setSel] = useState<Sel>(() => (initial ? selOf(initial.period) : { key: "30", from: "", to: "" }));
  const [base, setBase] = useState<BaseSel>(() => (initial ? baseSelOf(initial.baseline) : { key: "anterior", from: "", to: "" }));
  const [open, setOpen] = useState<"range" | "notes" | null>(null);
  const [help, setHelp] = useState<keyof typeof HELP | null>(null);
  const [view, setView] = useState<"chart" | "table">("chart");
  const [today] = useState(() => localToday(new Date(), initial?.tz ?? "America/Bogota"));
  const seq = useRef(0);
  const ctrl = useRef<AbortController | null>(null);
  const actionsRef = useRef<HTMLDivElement | null>(null);
  const helpRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => () => ctrl.current?.abort(), []);
  useEffect(() => {
    if (!open && !help) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(null);
        setHelp(null);
      }
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (actionsRef.current?.contains(t) || helpRef.current?.contains(t)) return;
      setOpen(null);
      setHelp(null);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open, help]);

  async function load(nextP: Sel, nextB: BaseSel) {
    const id = ++seq.current;
    ctrl.current?.abort();
    const ac = new AbortController();
    ctrl.current = ac;
    setSel(nextP);
    setBase(nextB);
    setStatus("loading");
    const qs = periodQuery(nextP, nextB);
    try {
      const api = new URLSearchParams(qs);
      if (clientId) api.set("cliente", clientId);
      const res = await fetch(`/api/costos-ia/ejecuciones?${api}`, { signal: ac.signal, cache: "no-store" });
      const json = await res.json();
      if (id !== seq.current) return;
      if (!res.ok) {
        setErrorMsg(typeof json?.error === "string" && res.status === 400 ? json.error : null);
        setStatus("error");
        return;
      }
      setData(json as ExecutionsReport);
      setErrorMsg(null);
      setStatus("ready");
      qs.set("vista", "ejecuciones");
      window.history.replaceState(null, "", `${window.location.pathname}?${qs}`);
    } catch {
      if (ac.signal.aborted || id !== seq.current) return;
      setErrorMsg(null);
      setStatus("error");
    }
  }

  if (!data) {
    return (
      <div className={cx(s.root, a.page)}>
        <div role="alert" className={cx(s.banner, s.bannerWarn)}>
          <span>{errorMsg ?? "No pudimos cargar las ejecuciones. Intenta de nuevo."}</span>
          <button type="button" className={buttonClass({ variant: "secondary", size: "sm" })} onClick={() => void load(sel, base)}>
            Reintentar
          </button>
        </div>
      </div>
    );
  }

  const { current: cur, comparison: cmp, period: p, baseline: b } = data;
  const t = cur.totals;
  const loading = status === "loading";
  const vk = `${p.fromDay}-${p.toDay}-${b.fromDay}-${data.generatedAt}`;
  const baseLabel = baseLabelOf(b);
  const oneBusiness = data.client !== null;
  const read = t.production - t.unread;

  const notes: Array<{ title: string; text: string; warn: boolean }> = [
    {
      title: "Qué se cuenta",
      text: "Solo las ejecuciones de producción cuentan para el plan de n8n. Las manuales (pruebas en el editor) se muestran aparte. «Con IA» = la ejecución llamó al modelo.",
      warn: false,
    },
    ...(t.unread > 0
      ? [
          {
            title: "Ejecuciones sin leer",
            text: `${nf.format(t.unread)} ejecuciones aún no se han leído o n8n no guardó sus datos: no se sabe si usaron IA, así que quedan fuera de los porcentajes.`,
            warn: true,
          },
        ]
      : []),
    ...(data.plans
      ? [
          {
            title: "Ciclo del plan",
            text: "El uso del plan es del ciclo actual (no del periodo elegido), en días UTC: puede diferir en un día del contador de n8n.",
            warn: false,
          },
        ]
      : []),
  ];

  const kpis: Array<{ id: keyof typeof HELP; label: string; value: string; note: string }> = [
    {
      id: "production",
      label: "Ejecuciones de producción",
      value: int(t.production),
      note: t.manual > 0 ? `+ ${nf.format(t.manual)} manuales (no cuentan)` : "Las que cuenta el plan",
    },
    {
      id: "withAi",
      label: "Con IA",
      value: int(t.withAi),
      note: read > 0 ? `${pctText(Math.round((1000 * t.withAi) / read) / 10)} de las leídas` : "Sin ejecuciones leídas",
    },
    {
      id: "wastePct",
      label: "Sin llegar al modelo",
      value: pctText(cmp.current.wastePct),
      note: `${nf.format(t.noAi)} sin IA · ${nf.format(t.errors)} con error`,
    },
    {
      id: "perAnswer",
      label: "Ejecuciones por respuesta",
      value: dec(cmp.current.perAnswer),
      note: "Lo ideal es acercarse a 1",
    },
  ];

  const chartDays: ChartDay[] = cur.days.map((d) => ({
    day: d.day,
    usd: d.production,
    calls: d.production,
    byClient: { ai: d.withAi, noai: d.noAi, err: d.errors, unread: d.unread },
  }));
  const baselineAvg = b.days > 0 ? data.previous.totals.production / b.days : null;
  const avg = cur.days.length > 0 ? t.production / cur.days.length : null;
  const peak = cur.days.reduce<(typeof cur.days)[number] | null>((best, d) => (best === null || d.production > best.production ? d : best), null);
  const avgChange = avg !== null && baselineAvg !== null && baselineAvg > 0 ? Math.round(((avg - baselineAvg) / baselineAvg) * 1000) / 10 : null;
  const stats: Array<{ label: string; value: string; sub: string | null; cls?: string }> = [
    { label: "Total del periodo", value: int(t.production), sub: "de producción" },
    { label: "Promedio diario", value: int(avg), sub: null },
    { label: "Día más alto", value: peak && peak.production > 0 ? int(peak.production) : "—", sub: peak && peak.production > 0 ? dayLong(peak.day) : null },
    {
      label: "Promedio en la comparación",
      value: int(baselineAvg),
      sub:
        avgChange === null
          ? fmtRange(b.fromDay, b.toDay, false)
          : `Ahora ${avgChange > 0 ? "▲" : avgChange < 0 ? "▼" : "="} ${Math.abs(avgChange).toLocaleString("es-CO")} % · ${fmtRange(b.fromDay, b.toDay, false)}`,
      cls: avgChange === null || avgChange === 0 ? undefined : avgChange < 0 ? a.good : a.bad,
    },
  ];

  return (
    <div className={cx(s.root, a.page)} aria-busy={loading || undefined}>
      {/* ---------------------------------------------------------- header -- */}
      <header className={a.head}>
        <div>
          <h1 className={a.title}>Ejecuciones</h1>
          <p className={a.subtitle}>
            {data.client ? data.client.name : "Todos los negocios"} · {loading ? "actualizando…" : updatedLabel(data.generatedAt, data.tz).replace(/^Actualizado/, "actualizado")}
          </p>
        </div>
        <div className={a.headActions} ref={actionsRef}>
          <button
            type="button"
            className={cx(a.pill, a.iconBtn, a.notesBtn, "u-focus")}
            aria-label={t.unread > 0 ? "Avisos sobre los datos: ejecuciones sin leer" : "Avisos sobre los datos"}
            aria-haspopup="dialog"
            aria-expanded={open === "notes"}
            onClick={() => {
              setHelp(null);
              setOpen(open === "notes" ? null : "notes");
            }}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden>
              <path d="M8 2.2 14.2 13H1.8z" />
              <path d="M8 6.5v3M8 11.2v.1" strokeLinecap="round" />
            </svg>
            {t.unread > 0 ? <span className={a.notesDot} aria-hidden /> : null}
          </button>
          <ScreenToggle current="ejecuciones" qs={periodQuery(selOf(p), baseSelOf(b))} />
          <RangeControl
            period={p}
            baseline={b}
            sel={sel}
            base={base}
            tz={data.tz}
            today={today}
            loading={loading}
            open={open === "range"}
            onToggle={() => {
              setHelp(null);
              setOpen(open === "range" ? null : "range");
            }}
            onLoad={(np, nb) => void load(np, nb)}
          />
          {open === "notes" ? (
            <div role="dialog" aria-label="Avisos sobre los datos" className={cx(a.pop, a.notesPop)}>
              <span className={a.popLabel}>Avisos sobre los datos</span>
              {notes.map((n) => (
                <div key={n.title} className={cx(a.note, n.warn && a.noteWarn)}>
                  <span className={a.menuTitle}>{n.title}</span>
                  <span className={a.small}>{n.text}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </header>

      {status === "error" ? (
        <div role="alert" className={cx(s.banner, s.bannerWarn)}>
          <span>{errorMsg ?? "No pudimos cargar este periodo."}</span>
          <button type="button" className={buttonClass({ variant: "secondary", size: "sm" })} onClick={() => void load(sel, base)}>
            Reintentar
          </button>
        </div>
      ) : (
        <>
          {/* ------------------------------------------------------- KPIs -- */}
          <section aria-label="Resumen" className={s.kpis}>
            {kpis.map((k, i) => {
              const d = deltaLine(k.id, cmp.changes[k.id], baseLabel);
              return (
                <div key={k.id} className={cx(s.kpi, s.enter, help === k.id && s.kpiRaised)} style={{ ["--i" as string]: i }} ref={help === k.id ? helpRef : undefined}>
                  <div style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
                    <span className={s.kpiLabel}>{k.label}</span>
                    <button
                      type="button"
                      className={cx(s.infoBtn, "u-focus")}
                      aria-label={`Qué mide: ${k.label}`}
                      aria-expanded={help === k.id}
                      onClick={() => {
                        setOpen(null);
                        setHelp(help === k.id ? null : k.id);
                      }}
                    >
                      <InfoIcon />
                    </button>
                  </div>
                  <V loading={loading} k={vk} w="6ch" className={s.kpiValue}>
                    {k.value}
                  </V>
                  <V loading={loading} k={vk} w="14ch" className={cx(s.delta, d.cls)}>
                    {d.text}
                  </V>
                  <div className={s.kpiFoot}>
                    <KindTag kind="measured" />
                    <V loading={loading} k={vk} w="10ch" className={s.note}>
                      {k.note}
                    </V>
                  </div>
                  {help === k.id ? (
                    <div role="dialog" aria-label={`Qué mide: ${k.label}`} className={s.popover} style={{ top: 44, left: 12, right: 12, minWidth: 260 }}>
                      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                        <span style={{ fontSize: 12, fontWeight: 600 }}>Qué cuenta</span>
                        <span className={s.secondary}>{HELP[k.id].cuenta}</span>
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                        <span style={{ fontSize: 12, fontWeight: 600 }}>Para qué sirve</span>
                        <span className={s.secondary}>{HELP[k.id].uso}</span>
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </section>

          {/* ------------------------------------------------------ plan -- */}
          {data.plans ? <PlanCard plans={data.plans} onChanged={() => void load(sel, base)} /> : null}

          {/* ------------------------------------------ who uses it most -- */}
          <UsageCard
            byClient={data.usage.byClient}
            byWorkflow={data.usage.byWorkflow}
            days={cur.days.map((d) => d.day)}
            loading={loading}
            vk={vk}
            vsLabel={baseLabel}
            businessSlots={data.chartSlots}
          />

          {/* ----------------------------------------------------- daily -- */}
          <section aria-labelledby="ex-days" className={cx(s.card, s.enter)}>
            <div className={a.cardHead}>
              <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
                <h2 id="ex-days" className={s.h2}>
                  Ejecuciones por día
                </h2>
                <p className={s.sub}>De producción, por cómo terminaron.</p>
              </div>
              <ValueSeg label="Vista de ejecuciones por día" value={view} onChange={setView} options={[["chart", "Gráfico"], ["table", "Tabla"]]} />
            </div>
            <div className={a.legend}>
              {SERIES.map((sr) => (
                <span key={sr.key}>
                  <span className={a.sw} style={{ background: sr.color }} />
                  {sr.name}
                </span>
              ))}
              {baselineAvg !== null && baselineAvg > 0 ? (
                <span>
                  <span className={a.swLine} />
                  Promedio de la comparación {int(baselineAvg)}
                </span>
              ) : null}
            </div>
            <dl className={a.stats}>
              {stats.map((x) => (
                <div key={x.label} className={a.stat}>
                  <dt className={a.muted}>{x.label}</dt>
                  <dd>
                    <V loading={loading} k={vk} w="7ch" className={a.statValue}>
                      {x.value}
                    </V>
                    {x.sub ? (
                      <V loading={loading} k={vk} w="9ch" className={cx(a.small, x.cls)}>
                        {x.sub}
                      </V>
                    ) : null}
                  </dd>
                </div>
              ))}
            </dl>
            {view === "chart" ? (
              <DailyCostChart
                days={chartDays}
                series={SERIES}
                baselineAvgUsd={baselineAvg}
                usdCop={null}
                units={{
                  value: (v) => nf.format(v),
                  axis: (v) => nf.format(v),
                  label: "Ejecuciones de producción por día",
                  empty: "Sin ejecuciones de producción en este periodo.",
                  foot: (d) => {
                    const day = cur.days.find((x) => x.day === d.day);
                    return day && day.manual > 0 ? `+ ${nf.format(day.manual)} manuales` : null;
                  },
                }}
              />
            ) : (
              <div className={a.tableWrap} style={{ maxHeight: 360, overflowY: "auto" }}>
                <table className={a.table}>
                  <thead>
                    <tr>
                      <th>Día</th>
                      <th>Con IA</th>
                      <th>Sin IA</th>
                      <th>Errores</th>
                      <th>Sin leer</th>
                      <th>Manuales</th>
                      <th>Producción</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cur.days.map((d) => (
                      <tr key={d.day}>
                        <td className={a.name}>{dayLong(d.day)}</td>
                        <td>{nf.format(d.withAi)}</td>
                        <td>{nf.format(d.noAi)}</td>
                        <td>{nf.format(d.errors)}</td>
                        <td>{nf.format(d.unread)}</td>
                        <td>{nf.format(d.manual)}</td>
                        <td>{nf.format(d.production)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* ------------------------------------------------ inbox sends -- */}
          {data.sends && data.sends.total > 0 ? <SendsCard sends={data.sends} loading={loading} vk={vk} /> : null}

          {/* ------------------------------------------------ comparison -- */}
          <section aria-labelledby="ex-cmp" className={cx(s.card, s.enter)}>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <h2 id="ex-cmp" className={s.h2}>
                Comparación
              </h2>
              <p className={s.sub}>
                {fmtRange(p.fromDay, p.toDay)} vs {fmtRange(b.fromDay, b.toDay)}
                {cmp.perDay ? " · volúmenes por día (los periodos duran distinto)" : ""}
                {cmp.status.available ? ". Verde = mejoró." : `. Porcentajes sin comparación: ${cmp.status.reason}.`}
              </p>
            </div>
            <div className={a.tableWrap}>
              <table className={a.table}>
                <thead>
                  <tr>
                    <th>Métrica</th>
                    <th>Actual</th>
                    <th>Comparación</th>
                    <th>Cambio</th>
                  </tr>
                </thead>
                <tbody>
                  {(
                    [
                      ["production", "Ejecuciones de producción", int],
                      ["withAi", "Con IA", int],
                      ["wastePct", "Sin llegar al modelo", pctText],
                      ["perAnswer", "Ejecuciones por respuesta", dec],
                      ["manual", "Manuales (no cuentan)", int],
                      ["avgDurationMs", "Duración promedio", (v: number | null) => formatDuration(v === null ? null : Math.round(v))],
                    ] as Array<[ExecMetricKey, string, (v: number | null) => string]>
                  ).map(([k, label, fmt]) => {
                    const c = cmp.changes[k];
                    return (
                      <tr key={k}>
                        <td className={a.name}>{label}</td>
                        <td>
                          <V loading={loading} k={vk} w="6ch">
                            {fmt(cmp.current[k])}
                          </V>
                        </td>
                        <td>
                          <V loading={loading} k={vk} w="6ch">
                            {fmt(cmp.previous[k])}
                          </V>
                        </td>
                        <td>
                          <span className={toneOf(k, c)}>{c.kind === "pct" ? changeText(c) : c.kind === "no_prev" ? "nuevo" : "—"}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          {/* --------------------------------------------- where they end -- */}
          <section aria-labelledby="ex-end" className={cx(s.card, s.enter)}>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <h2 id="ex-end" className={s.h2}>
                Dónde terminan
              </h2>
              <p className={s.sub}>El último nodo de cada ejecución, por workflow: muestra qué paso corta las que no llegan al modelo.</p>
            </div>
            {cur.endings.length === 0 ? (
              <p className={s.sub}>Sin ejecuciones en este periodo.</p>
            ) : (
              <div className={a.tableWrap} style={{ maxHeight: 420, overflowY: "auto" }}>
                <table className={a.table}>
                  <thead>
                    <tr>
                      <th>Workflow</th>
                      {oneBusiness ? null : <th>Negocio</th>}
                      <th>Último nodo</th>
                      <th>Ejecuciones</th>
                      <th>Con IA</th>
                      <th>Errores</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cur.endings.map((e, i) => (
                      <tr key={`${e.workflow}-${e.lastNode}-${e.manual}-${i}`}>
                        <td className={a.name}>
                          {e.workflow}
                          {e.manual ? <span className={cx(a.small, a.muted)}> · manual</span> : null}
                        </td>
                        {oneBusiness ? null : <td>{e.clientName}</td>}
                        <td>{e.lastNode || <span className={a.muted}>sin dato</span>}</td>
                        <td>{nf.format(e.executions)}</td>
                        <td>{nf.format(e.withAi)}</td>
                        <td>{nf.format(e.errors)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- sends card -- */

/**
 * Replies people sent from the Inbox: a separate measure from execution success (a caught
 * provider error still ends the run as `success`). Shown only when there are any.
 */
function SendsCard({ sends, loading, vk }: { sends: ExecutionsReport["sends"]; loading: boolean; vk: string }) {
  const share = (n: number) => `${Math.round((100 * n) / sends.total)} %`;
  const stats: Array<{ label: string; value: string; sub: string | null; cls?: string }> = [
    { label: "Enviados", value: nf.format(sends.total), sub: "respuestas desde el Inbox" },
    { label: "Aceptados", value: nf.format(sends.accepted), sub: share(sends.accepted) },
    { label: "Fallidos", value: nf.format(sends.failed), sub: share(sends.failed), cls: sends.failed > 0 ? a.bad : undefined },
    { label: "Enviándose", value: nf.format(sends.pending), sub: sends.pending > 0 ? "aún sin respuesta del workflow" : null },
  ];
  return (
    <section aria-labelledby="ex-sends" className={cx(s.card, s.enter)}>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <h2 id="ex-sends" className={s.h2}>
          Envíos del Inbox
        </h2>
        <p className={s.sub}>Respuestas que una persona mandó desde el Inbox. «Aceptado» es que el workflow lo recibió, no que WhatsApp lo entregó.</p>
      </div>
      <dl className={a.stats}>
        {stats.map((x) => (
          <div key={x.label} className={a.stat}>
            <dt className={a.muted}>{x.label}</dt>
            <dd>
              <V loading={loading} k={vk} w="6ch" className={cx(a.statValue, x.cls)}>
                {x.value}
              </V>
              {x.sub ? <span className={a.small}>{x.sub}</span> : null}
            </dd>
          </div>
        ))}
      </dl>
      {sends.failed_by_code.length > 0 ? (
        <p className={a.small} style={{ margin: 0 }}>
          Fallidos por código: {sends.failed_by_code.map((f) => `${f.code} (${nf.format(f.count)})`).join(" · ")}
        </p>
      ) : null}
    </section>
  );
}

/* --------------------------------------------------------------- plan card -- */

function PlanCard({ plans, onChanged }: { plans: PlanUsage[]; onChanged: () => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <section aria-labelledby="ex-plan" className={cx(s.card, s.enter)}>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <h2 id="ex-plan" className={s.h2}>
          Plan de n8n
        </h2>
        <p className={s.sub}>Ejecuciones de producción del ciclo actual, por conexión de n8n, y a dónde llegan al ritmo de hoy.</p>
      </div>
      {plans.length === 0 ? <p className={s.sub}>No hay conexiones de n8n activas.</p> : null}
      {plans.map((pl) => (
        <div key={pl.connectionId} className={a.plan}>
          <div className={a.planHead}>
            <span className={a.name}>{pl.connectionName}</span>
            <span className={a.small}>
              Ciclo {shortDate(pl.cycleStart)} – {shortDate(new Date(Date.parse(pl.cycleEnd) - 86_400_000).toISOString())} · quedan {pl.daysLeft} días
            </span>
            {editing === pl.connectionId ? null : (
              <button type="button" className={a.linkBtn} onClick={() => setEditing(pl.connectionId)}>
                {pl.limit === null ? "Configurar plan" : "Editar plan"}
              </button>
            )}
          </div>
          {pl.limit !== null ? (
            <div
              className={a.meter}
              role="meter"
              aria-label={`Uso del plan de ${pl.connectionName}`}
              aria-valuemin={0}
              aria-valuemax={pl.limit}
              aria-valuenow={Math.min(pl.used, pl.limit)}
            >
              <span className={a.meterFill} style={{ width: `${Math.min(100, pl.usedPct ?? 0)}%` }} />
              {pl.projectedPct !== null ? <span className={a.meterProj} style={{ left: `${Math.min(100, pl.projectedPct)}%` }} aria-hidden /> : null}
            </div>
          ) : null}
          <div className={a.planStats}>
            <span>
              <strong className={a.num}>{nf.format(pl.used)}</strong>
              {pl.limit !== null ? ` de ${nf.format(pl.limit)} (${pctText(pl.usedPct)})` : " usadas · sin límite configurado"}
            </span>
            {pl.projected !== null ? (
              <span className={pl.projectedPct !== null && pl.projectedPct > 100 ? a.bad : undefined}>
                {pl.projectedPct !== null && pl.projectedPct > 100 ? "⚠ " : ""}
                Al cierre: ~{nf.format(pl.projected)}
                {pl.projectedPct !== null ? ` (${pctText(pl.projectedPct)}${pl.projectedPct > 100 ? ", se pasa del plan" : ""})` : ""}
              </span>
            ) : (
              <span className={a.muted}>Proyección disponible tras el primer día del ciclo</span>
            )}
          </div>
          {editing === pl.connectionId ? (
            <PlanForm
              plan={pl}
              onDone={(changed) => {
                setEditing(null);
                if (changed) onChanged();
              }}
            />
          ) : null}
        </div>
      ))}
    </section>
  );
}

function PlanForm({ plan, onDone }: { plan: PlanUsage; onDone: (changed: boolean) => void }) {
  const [limit, setLimit] = useState(plan.limit === null ? "" : String(plan.limit));
  const [day, setDay] = useState(plan.resetDay === null ? "" : String(plan.resetDay));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(clear: boolean) {
    setBusy(true);
    setError(null);
    const digits = (v: string) => v.replace(/[.\s,]/g, "");
    const res = await setN8nPlanAction({
      connectionId: plan.connectionId,
      monthlyExecutions: clear || limit.trim() === "" ? null : Number(digits(limit)),
      resetDay: clear || day.trim() === "" ? null : Number(day),
    }).catch(() => ({ ok: false as const, error: "No se pudo guardar. Intenta de nuevo." }));
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    onDone(true);
  }

  return (
    <form
      className={a.planForm}
      onSubmit={(e) => {
        e.preventDefault();
        void save(false);
      }}
    >
      <label className={a.planField}>
        <span className={a.popLabel}>Ejecuciones por ciclo</span>
        <input className={cx(FIELD, "h-[36px]")} inputMode="numeric" placeholder="8000" value={limit} onChange={(e) => setLimit(e.target.value)} />
      </label>
      <label className={a.planField}>
        <span className={a.popLabel}>Día de reinicio (1–28)</span>
        <input className={cx(FIELD, "h-[36px]")} type="number" min={1} max={28} placeholder="1" value={day} onChange={(e) => setDay(e.target.value)} />
      </label>
      <div className={a.planActions}>
        <button type="submit" disabled={busy} className={buttonClass({ variant: "primary", size: "sm" })}>
          {busy ? "Guardando…" : "Guardar"}
        </button>
        <button type="button" disabled={busy} className={buttonClass({ variant: "secondary", size: "sm" })} onClick={() => onDone(false)}>
          Cancelar
        </button>
        {plan.limit !== null ? (
          <button type="button" disabled={busy} className={a.linkBtn} onClick={() => void save(true)}>
            Quitar plan
          </button>
        ) : null}
      </div>
      <span className={a.small}>Lo ves en n8n → Settings → Usage and plan. El día de reinicio es el de tu suscripción.</span>
      {error ? (
        <span role="alert" className={a.popError}>
          {error}
        </span>
      ) : null}
    </form>
  );
}

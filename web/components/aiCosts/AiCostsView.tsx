"use client";

import { useEffect, useRef, useState } from "react";
import s from "@/components/value/valueDashboard.module.css";
import a from "./aiCosts.module.css";
import { cx, InfoIcon, KindTag, V } from "@/components/value/bits";
import { Seg as ValueSeg } from "@/components/value/sections";
import { buttonClass, FIELD } from "@/components/ui/controls";
import { fmtRange, updatedLabel } from "@/lib/valueDashboardView";
import type { AiCostsReport } from "@/lib/aiCosts";
import { DailyCostChart, dayLong, type Series } from "./DailyCostChart";
import { OpenAiBillingCard } from "./OpenAiBillingCard";
import { ClientBillingCard } from "./ClientBillingCard";
import { localToday, resolvePeriod, type PeriodKey } from "@worker/analytics/valueDashboardModel.js";
import { resolveBaseline, type BaselineKey } from "@worker/analytics/aiCostPeriods.js";
import { METRIC_DIRECTION, type Change, type DayCost, type MetricKey, type Money } from "@worker/analytics/aiCostModel.js";
import { changeText, METRIC_LABEL, usdText } from "@worker/analytics/aiCostReport.js";
import { assignChartColors } from "@worker/analytics/chartColors.js";

/**
 * COSTOS DE IA — the agency's screen. A quiet header (title, one date control whose choices
 * apply at once, a download menu) over the detailed views: KPI cards with «Medido» /
 * «Estimación», the daily spend stacked by business (with a business filter), the full
 * comparison table, and the per-business, per-workflow, per-model, meetings and prices views.
 * Every bot amount is an ESTIMATE at list price; unknown is «—» / «sin precio», never $0.
 */

type Sel = { key: PeriodKey; from: string; to: string };
type BaseSel = { key: BaselineKey; from: string; to: string };
type Draft = { p: Sel; b: BaseSel };

const nf = new Intl.NumberFormat("es-CO");
const compact = new Intl.NumberFormat("es-CO", { notation: "compact", maximumFractionDigits: 1 });
const int = (v: number | null) => (v === null ? "—" : nf.format(Math.round(v)));
const dec = (v: number | null) => (v === null ? "—" : v.toLocaleString("es-CO", { maximumFractionDigits: 2 }));

function fxLabel(fx: AiCostsReport["fx"]): string {
  if (!fx || fx.source === "env") return "tasa manual";
  const range = fx.validFrom && fx.validTo && fx.validFrom !== fx.validTo ? fmtRange(fx.validFrom, fx.validTo, false) : fx.validFrom ? fmtRange(fx.validFrom, fx.validFrom, false) : "";
  return `TRM oficial${range ? ` vigente ${range}` : ""}`;
}

function copText(usd: number | null, rate: number | null): string | null {
  if (usd === null || rate === null) return null;
  return `$${Math.round(usd * rate).toLocaleString("es-CO")} COP`;
}

function moneyText(m: Money): string {
  if (m.usd === null) return m.partial ? "sin precio" : "—";
  return m.partial ? `${usdText(m.usd)} + sin precio` : usdText(m.usd);
}

/** Green when a lower-is-better metric went down, orange when it went up; volumes stay gray. */
function toneOf(metric: MetricKey, c: Change): string {
  if (c.kind !== "pct" || METRIC_DIRECTION[metric] === "neutral" || c.pct === 0) return a.muted;
  return c.pct < 0 ? a.good : a.bad;
}

function deltaLine(metric: MetricKey, c: Change, vsLabel: string): { text: string; cls: string } {
  if (c.kind === "unavailable") return { text: `Sin comparación: ${c.reason}`, cls: a.muted };
  if (c.kind === "no_prev") return { text: `Sin actividad ${vsLabel.replace(/^vs /, "en ")}`, cls: a.muted };
  return { text: `${changeText(c)} ${vsLabel}`, cls: toneOf(metric, c) };
}

function ChangeCell({ metric, c }: { metric: MetricKey; c: Change | undefined }) {
  if (!c) return <span className={a.muted}>—</span>;
  return <span className={toneOf(metric, c)}>{c.kind === "pct" ? changeText(c) : c.kind === "no_prev" ? "nuevo" : "—"}</span>;
}

function MoneyCell({ m, rate }: { m: Money; rate: number | null }) {
  if (m.usd === null) return <span className={a.muted}>{m.partial ? "sin precio" : "—"}</span>;
  const cop = copText(m.usd, rate);
  return (
    <span>
      {usdText(m.usd)}
      {m.partial ? <span className={a.muted} title="Una parte de los tokens es de un modelo sin precio"> + sin precio</span> : null}
      {cop ? <span className={a.small}>{cop}</span> : null}
    </span>
  );
}

function Seg<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Array<[T, string]>; onChange: (v: T) => void }) {
  return (
    <div role="radiogroup" aria-label={label} className={a.seg}>
      {options.map(([v, l]) => (
        <button key={v} type="button" role="radio" aria-checked={value === v} onClick={() => onChange(v)} className="u-focus">
          {l}
        </button>
      ))}
    </div>
  );
}

function query(p: Sel, b: BaseSel): URLSearchParams {
  const qs = new URLSearchParams({ periodo: p.key });
  if (p.key === "custom") {
    qs.set("desde", p.from);
    qs.set("hasta", p.to);
  }
  if (b.key !== "anterior") qs.set("comparar", b.key);
  if (b.key === "custom") {
    qs.set("cdesde", b.from);
    qs.set("chasta", b.to);
  }
  return qs;
}

/** What a draft would load, with the same rules the server applies. */
function previewOf(d: Draft, tz: string) {
  const pr = resolvePeriod(d.p.key === "custom" ? { key: "custom", from: d.p.from, to: d.p.to } : { key: d.p.key }, new Date(), tz);
  if (!pr.ok) return { error: pr.error } as const;
  const br = resolveBaseline(pr.period, d.b.key === "custom" ? { key: "custom", from: d.b.from, to: d.b.to } : { key: d.b.key }, tz);
  if (!br.ok) return { error: br.error } as const;
  return { period: pr.period, baseline: br.baseline } as const;
}

const BASE_SHORT: Record<BaselineKey, string> = { anterior: "vs anterior", mes: "vs mes anterior", custom: "" };

const HELP: Record<"costUsd" | "perConversationUsd" | "inputPerCall" | "calls", { cuenta: string; uso: string }> = {
  costUsd: {
    cuenta: "Tokens de todas las llamadas al modelo de los bots, a precio de lista. Los de un modelo sin precio se cuentan pero no se cobran aquí.",
    uso: "El gasto del periodo. Sube y baja con el tráfico: para juzgar un cambio en el bot mira las métricas por unidad.",
  },
  perConversationUsd: {
    cuenta: "Costo estimado dividido entre las conversaciones con al menos un mensaje del cliente en el periodo.",
    uso: "Lo que cuesta atender a una persona. Es la mejor métrica para el margen por negocio.",
  },
  inputPerCall: {
    cuenta: "Tokens de entrada (prompt, herramientas e historial) divididos entre las llamadas al modelo.",
    uso: "Baja cuando se acorta el prompt o el historial: así se ve si una optimización funcionó.",
  },
  calls: {
    cuenta: "Cada vez que un workflow llamó al modelo. Un turno con herramientas hace varias llamadas.",
    uso: "Volumen. Junto a «llamadas por ejecución» muestra si el agente da vueltas de más con sus herramientas.",
  },
};

export function AiCostsView({
  initial,
  initialError,
  clientId = null,
}: {
  initial: AiCostsReport | null;
  initialError: string | null;
  /** Limit the screen to one business (its owner's view, /clients/{id}/costos-ia). */
  clientId?: string | null;
}) {
  const [data, setData] = useState<AiCostsReport | null>(initial);
  const [status, setStatus] = useState<"ready" | "loading" | "error">(initial ? "ready" : "error");
  const [errorMsg, setErrorMsg] = useState<string | null>(initialError);
  const [sel, setSel] = useState<Sel>(() =>
    initial ? { key: initial.period.key, from: initial.period.fromDay, to: initial.period.toDay } : { key: "30", from: "", to: "" },
  );
  const [base, setBase] = useState<BaseSel>(() =>
    initial ? { key: initial.baseline.key, from: initial.baseline.fromDay, to: initial.baseline.toDay } : { key: "anterior", from: "", to: "" },
  );
  const [open, setOpen] = useState<"range" | "download" | "notes" | null>(null);
  const [draft, setDraft] = useState<Draft>({ p: sel, b: base });
  const [help, setHelp] = useState<keyof typeof HELP | null>(null);
  const [view, setView] = useState<"chart" | "table">("chart");
  /** Businesses switched off in the daily chart (by client key). Colors never move. */
  const [hidden, setHidden] = useState<string[]>([]);
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
    const qs = query(nextP, nextB);
    try {
      const api = new URLSearchParams(qs);
      if (clientId) api.set("cliente", clientId);
      const res = await fetch(`/api/costos-ia?${api}`, { signal: ac.signal, cache: "no-store" });
      const json = await res.json();
      if (id !== seq.current) return;
      if (!res.ok) {
        setErrorMsg(typeof json?.error === "string" && res.status === 400 ? json.error : null);
        setStatus("error");
        return;
      }
      setData(json as AiCostsReport);
      setErrorMsg(null);
      setStatus("ready");
      window.history.replaceState(null, "", `${window.location.pathname}?${qs}`);
    } catch {
      if (ac.signal.aborted || id !== seq.current) return;
      setErrorMsg(null);
      setStatus("error");
    }
  }

  const tz = data?.tz ?? "America/Bogota";
  const preview = previewOf(draft, tz);

  /** Every choice in the date panel applies at once when it is valid — no «Aplicar». */
  function change(next: Draft) {
    setDraft(next);
    const pv = previewOf(next, tz);
    if ("error" in pv) return;
    const nextP: Sel = { key: next.p.key, from: pv.period.fromDay, to: pv.period.toDay };
    const nextB: BaseSel = { key: next.b.key, from: pv.baseline.fromDay, to: pv.baseline.toDay };
    if (query(nextP, nextB).toString() === query(sel, base).toString()) return;
    void load(nextP, nextB);
  }

  function openRange() {
    setHelp(null);
    setDraft({ p: sel, b: base });
    setOpen(open === "range" ? null : "range");
  }

  if (!data) {
    return (
      <div className={cx(s.root, a.page)}>
        <div role="alert" className={cx(s.banner, s.bannerWarn)}>
          <span>{errorMsg ?? "No pudimos cargar los costos. Intenta de nuevo."}</span>
          <button type="button" className={buttonClass({ variant: "secondary", size: "sm" })} onClick={() => void load(sel, base)}>
            Reintentar
          </button>
        </div>
      </div>
    );
  }

  const { current: cur, comparison: cmp, period: p, baseline: b, usdCop } = data;
  const t = cur.totals;
  const loading = status === "loading";
  const vk = `${p.fromDay}-${p.toDay}-${b.fromDay}-${data.generatedAt}`;
  const reportQs = query({ key: p.key, from: p.fromDay, to: p.toDay }, { key: b.key, from: b.fromDay, to: b.toDay });
  if (clientId) reportQs.set("cliente", clientId);
  const oneBusiness = data.client !== null;
  const baseLabel = BASE_SHORT[b.key] || `vs ${fmtRange(b.fromDay, b.toDay, false)}`;
  const estimatePct = t.calls > 0 ? Math.round((100 * t.estimateCalls) / t.calls) : null;
  const tokensKind = t.estimateCalls > 0 ? "estimate" : "measured";
  const partialCoverage = cur.coverage.unscanned > 0 || cur.coverage.withoutData > 0;
  const notes: Array<{ title: string; text: string; warn: boolean }> = [
    {
      title: "Estimado a precio de lista",
      text:
        (estimatePct !== null && estimatePct > 0
          ? "n8n no reporta los tokens de razonamiento ni los de caché: la factura real puede ser mayor."
          : "Puede diferir de la factura del proveedor.") +
        (usdCop === null
          ? " No hay tasa de cambio disponible: se muestran solo dólares."
          : ` Tasa: ${usdCop.toLocaleString("es-CO", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} COP por dólar (${fxLabel(data.fx)}).`),
      warn: false,
    },
    ...(partialCoverage
      ? [
          {
            title: "Cobertura parcial",
            text:
              `De ${nf.format(cur.coverage.total)} ejecuciones de workflows con IA, ` +
              [
                cur.coverage.unscanned > 0 ? `${nf.format(cur.coverage.unscanned)} aún no se han leído (corre el backfill)` : null,
                cur.coverage.withoutData > 0 ? `${nf.format(cur.coverage.withoutData)} no tienen datos guardados en n8n` : null,
              ]
                .filter(Boolean)
                .join(" y ") +
              ". Sus tokens son desconocidos, no cero.",
            warn: true,
          },
        ]
      : []),
  ];
  const prevCost = data.previous.totals.cost.partial ? null : (data.previous.totals.cost.usd ?? (data.previous.totals.calls === 0 ? 0 : null));
  const baselineAvgUsd = cmp.status.available && prevCost !== null ? prevCost / b.days : null;

  // Color follows the business: the one chosen in «Clientes y workflows», else the first free
  // palette slot by name — never this period's ranking.
  const slots = assignChartColors(cur.byClient.map((c) => ({ key: c.clientId ?? "", name: c.clientName, chartColor: c.chartColor })));
  const series: Series[] = [...cur.byClient]
    .sort((x, y) => x.clientName.localeCompare(y.clientName, "es"))
    .map((c) => {
      const slot = slots.get(c.clientId ?? "") ?? null;
      return { key: c.clientId ?? "", name: c.clientName, color: slot ? `var(--ai-${slot})` : "var(--vd-tertiary)" };
    });
  const colorOf = (id: string | null) => series.find((sr) => sr.key === (id ?? ""))?.color ?? "var(--vd-tertiary)";

  // The chart's business filter: only the chosen businesses' spend, and the comparison line
  // recomputed for the same businesses so the two stay comparable.
  const shown = series.filter((sr) => !hidden.includes(sr.key));
  const filtered = shown.length < series.length;
  const chartDays: DayCost[] = filtered
    ? cur.daily.map((d) => {
        const byClient = Object.fromEntries(shown.filter((sr) => d.byClient[sr.key] !== undefined).map((sr) => [sr.key, d.byClient[sr.key]]));
        const vals = Object.values(byClient);
        return { ...d, byClient, usd: vals.length ? vals.reduce((n, v) => n + v, 0) : null, calls: vals.length ? d.calls : 0 };
      })
    : cur.daily;
  const prevShown = data.previous.daily.reduce((n, d) => n + shown.reduce((m, sr) => m + (d.byClient[sr.key] ?? 0), 0), 0);
  const chartBaseline = filtered ? (cmp.status.available ? prevShown / b.days : null) : baselineAvgUsd;
  const pricedDays = chartDays.filter((d) => d.usd !== null);
  const chartTotal = pricedDays.reduce((n, d) => n + (d.usd ?? 0), 0);
  const chartAvg = chartDays.length > 0 && pricedDays.length > 0 ? chartTotal / chartDays.length : null;
  const peak = pricedDays.reduce<DayCost | null>((best, d) => (best === null || (d.usd ?? 0) > (best.usd ?? 0) ? d : best), null);
  const avgChange = chartAvg !== null && chartBaseline !== null && chartBaseline > 0 ? Math.round(((chartAvg - chartBaseline) / chartBaseline) * 1000) / 10 : null;
  const toggle = (key: string) => setHidden((h) => (h.includes(key) ? h.filter((k) => k !== key) : [...h, key]));

  const kpis: Array<{ id: keyof typeof HELP; label: string; value: string; kind: "measured" | "estimate"; note: string }> = [
    {
      id: "costUsd",
      label: "Costo estimado",
      value: t.cost.usd === null ? "—" : usdText(t.cost.usd),
      kind: "estimate",
      note: [copText(t.cost.usd, usdCop), t.cost.partial ? "más tokens sin precio" : null].filter(Boolean).join(" · ") || "Bots de WhatsApp",
    },
    {
      id: "perConversationUsd",
      label: "Costo por conversación",
      value: usdText(cmp.current.perConversationUsd),
      kind: "estimate",
      note: `${nf.format(t.conversations)} conversaciones con mensajes`,
    },
    {
      id: "inputPerCall",
      label: "Tokens de entrada por llamada",
      value: int(cmp.current.inputPerCall),
      kind: tokensKind,
      note: `${int(cmp.current.outputPerCall)} de salida por llamada`,
    },
    {
      id: "calls",
      label: "Llamadas al modelo",
      value: nf.format(t.calls),
      kind: "measured",
      note: cmp.current.callsPerExecution === null ? "Sin ejecuciones con IA" : `${dec(cmp.current.callsPerExecution)} por ejecución`,
    },
  ];

  const stats: Array<{ label: string; value: string; sub: string | null; cls?: string }> = [
    { label: "Total del periodo", value: pricedDays.length ? usdText(chartTotal) : "—", sub: copText(pricedDays.length ? chartTotal : null, usdCop) },
    { label: "Promedio diario", value: usdText(chartAvg), sub: copText(chartAvg, usdCop) },
    { label: "Día más alto", value: peak ? usdText(peak.usd) : "—", sub: peak ? dayLong(peak.day) : null },
    {
      label: "Promedio en la comparación",
      value: usdText(chartBaseline),
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
          <h1 className={a.title}>Costos de IA</h1>
          <p className={a.subtitle}>{data.client ? data.client.name : "Todos los negocios"} · {loading ? "actualizando…" : updatedLabel(data.generatedAt, data.tz).replace(/^Actualizado/, "actualizado")}</p>
        </div>
        <div className={a.headActions} ref={actionsRef}>
          <button
            type="button"
            className={cx(a.pill, a.iconBtn, a.notesBtn, "u-focus")}
            aria-label={partialCoverage ? "Avisos sobre los datos: cobertura parcial" : "Avisos sobre los datos"}
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
            {partialCoverage ? <span className={a.notesDot} aria-hidden /> : null}
          </button>
          <button type="button" className={cx(a.pill, "u-focus")} aria-haspopup="dialog" aria-expanded={open === "range"} onClick={openRange}>
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
              <rect x="2.5" y="3.5" width="11" height="10" rx="2" />
              <path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" />
            </svg>
            <span className={a.num}>{fmtRange(p.fromDay, p.toDay, false)}</span>
            <span className={a.muted}>{baseLabel}</span>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
              <path d="M4 6l4 4 4-4" />
            </svg>
          </button>
          <button
            type="button"
            className={cx(a.pill, a.iconBtn, "u-focus")}
            aria-label="Descargar"
            aria-haspopup="menu"
            aria-expanded={open === "download"}
            onClick={() => {
              setHelp(null);
              setOpen(open === "download" ? null : "download");
            }}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
              <path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10" />
            </svg>
          </button>

          {open === "range" ? (
            <div role="dialog" aria-label="Fechas" className={a.pop}>
              <span className={a.popLabel}>Periodo</span>
              <Seg
                label="Periodo"
                value={draft.p.key}
                onChange={(k) => change({ ...draft, p: { key: k, from: draft.p.from || p.fromDay, to: draft.p.to || p.toDay } })}
                options={[["7", "7 días"], ["30", "30 días"], ["custom", "Fechas"]]}
              />
              {draft.p.key === "custom" ? (
                <div className={a.dates}>
                  <input type="date" aria-label="Periodo desde" className={cx(FIELD, "h-[40px]")} value={draft.p.from} max={today} onChange={(e) => change({ ...draft, p: { ...draft.p, from: e.target.value } })} />
                  <input type="date" aria-label="Periodo hasta" className={cx(FIELD, "h-[40px]")} value={draft.p.to} max={today} onChange={(e) => change({ ...draft, p: { ...draft.p, to: e.target.value } })} />
                </div>
              ) : null}
              <span className={a.popLabel} style={{ marginTop: 4 }}>
                Comparar con
              </span>
              <Seg
                label="Comparar con"
                value={draft.b.key}
                onChange={(k) => change({ ...draft, b: { key: k, from: draft.b.from || b.fromDay, to: draft.b.to || b.toDay } })}
                options={[["anterior", "Anterior"], ["mes", "Mes anterior"], ["custom", "Fechas"]]}
              />
              {draft.b.key === "custom" ? (
                <div className={a.dates}>
                  <input type="date" aria-label="Comparar desde" className={cx(FIELD, "h-[40px]")} value={draft.b.from} max={today} onChange={(e) => change({ ...draft, b: { ...draft.b, from: e.target.value } })} />
                  <input type="date" aria-label="Comparar hasta" className={cx(FIELD, "h-[40px]")} value={draft.b.to} max={today} onChange={(e) => change({ ...draft, b: { ...draft.b, to: e.target.value } })} />
                </div>
              ) : null}
              <span aria-live="polite" className={"error" in preview ? a.popError : a.popRange}>
                {"error" in preview
                  ? preview.error
                  : `${fmtRange(preview.period.fromDay, preview.period.toDay)} vs ${fmtRange(preview.baseline.fromDay, preview.baseline.toDay)}${loading ? " · cargando…" : ""}`}
              </span>
            </div>
          ) : null}

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

          {open === "download" ? (
            <div role="menu" aria-label="Descargar" className={cx(a.pop, a.menu)}>
              <a role="menuitem" className={cx(a.menuItem, "u-focus")} href={`/api/costos-ia/informe?${reportQs}&formato=md`} download onClick={() => setOpen(null)}>
                <span className={a.menuTitle}>Informe (.md)</span>
                <span className={a.small}>Para leerlo o pasárselo a una IA</span>
              </a>
              <a role="menuitem" className={cx(a.menuItem, "u-focus")} href={`/api/costos-ia/informe?${reportQs}&formato=csv`} download onClick={() => setOpen(null)}>
                <span className={a.menuTitle}>Datos (.csv)</span>
                <span className={a.small}>Para Excel u hojas de cálculo</span>
              </a>
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
                <div key={k.id} className={cx(s.kpi, s.enter, k.kind === "estimate" && s.kpiEst, help === k.id && s.kpiRaised)} style={{ ["--i" as string]: i }} ref={help === k.id ? helpRef : undefined}>
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
                    <KindTag kind={k.kind} />
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

          {/* --------------------------------------------- OpenAI billing -- */}
          {data.clientBilling ? <ClientBillingCard billing={data.clientBilling} usdCop={usdCop} estimatedUsd={cur.totals.cost.partial ? null : cur.totals.cost.usd} /> : null}
          {data.billing ? (
            <OpenAiBillingCard
              billing={data.billing}
              estimatedUsd={cur.totals.cost.usd}
              estimatedPartial={cur.totals.cost.partial}
              estimates={Object.fromEntries(cur.byClient.map((c) => [c.clientId ?? "", c.cost.partial ? null : c.cost.usd]))}
              colors={Object.fromEntries(series.map((sr) => [sr.key, sr.color]))}
              usdCop={usdCop}
              tz={data.tz}
              onChanged={() => void load(sel, base)}
            />
          ) : null}

          {/* ------------------------------------------------------ daily -- */}
          <section aria-labelledby="ai-days" className={cx(s.card, s.enter)}>
            <div className={a.cardHead}>
              <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
                <h2 id="ai-days" className={s.h2}>
                  Gasto diario
                </h2>
                <p className={s.sub}>US$ estimados por día, de los modelos con precio{oneBusiness ? "" : ", por negocio"}.</p>
              </div>
              <ValueSeg label="Vista del gasto diario" value={view} onChange={setView} options={[["chart", "Gráfico"], ["table", "Tabla"]]} />
            </div>

            {series.length > 1 ? (
              <div role="group" aria-label="Negocios que se muestran" className={a.toggles}>
                {series.map((sr) => {
                  const on = !hidden.includes(sr.key);
                  return (
                    <button key={sr.key} type="button" aria-pressed={on} className={cx(a.toggle, !on && a.toggleOff, "u-focus")} onClick={() => toggle(sr.key)}>
                      <span className={a.toggleSw} style={{ background: on ? sr.color : "transparent", borderColor: sr.color }} aria-hidden />
                      {sr.name}
                    </button>
                  );
                })}
                {filtered ? (
                  <button type="button" className={a.linkBtn} onClick={() => setHidden([])}>
                    Ver todos
                  </button>
                ) : null}
              </div>
            ) : null}

            <dl className={a.stats}>
              {stats.map((x) => (
                <div key={x.label} className={a.stat}>
                  <dt className={a.muted}>{x.label}</dt>
                  <dd>
                    <V loading={loading} k={`${vk}-${hidden.join()}`} w="7ch" className={a.statValue}>
                      {x.value}
                    </V>
                    {x.sub ? (
                      <V loading={loading} k={`${vk}-${hidden.join()}`} w="9ch" className={cx(a.small, x.cls)}>
                        {x.sub}
                      </V>
                    ) : null}
                  </dd>
                </div>
              ))}
            </dl>

            {shown.length === 0 ? (
              <p className={s.sub}>Elige al menos un negocio para ver su gasto.</p>
            ) : view === "chart" ? (
              <>
                {chartBaseline !== null && chartBaseline > 0 ? (
                  <div className={a.legend} style={{ marginBottom: -6 }}>
                    <span>
                      <span className={a.swLine} />
                      Promedio de la comparación {usdText(chartBaseline)}
                    </span>
                  </div>
                ) : null}
                <DailyCostChart days={chartDays} series={shown} baselineAvgUsd={chartBaseline} usdCop={usdCop} showCalls={!filtered} />
              </>
            ) : (
              <div className={a.tableWrap} style={{ maxHeight: 360, overflowY: "auto" }}>
                <table className={a.table}>
                  <thead>
                    <tr>
                      <th>Día</th>
                      {shown.map((sr) => (
                        <th key={sr.key}>{sr.name}</th>
                      ))}
                      {filtered ? null : <th>Llamadas</th>}
                      <th>Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {chartDays.map((d) => (
                      <tr key={d.day}>
                        <td className={a.name}>{dayLong(d.day)}</td>
                        {shown.map((sr) => (
                          <td key={sr.key}>{d.byClient[sr.key] === undefined ? "—" : usdText(d.byClient[sr.key])}</td>
                        ))}
                        {filtered ? null : <td>{nf.format(d.calls)}</td>}
                        <td>{d.usd === null ? (d.calls > 0 ? "sin precio" : "—") : usdText(d.usd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* ------------------------------------------------- comparison -- */}
          <section aria-labelledby="ai-cmp" className={cx(s.card, s.enter)}>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <h2 id="ai-cmp" className={s.h2}>
                Comparación
              </h2>
              <p className={s.sub}>
                {fmtRange(p.fromDay, p.toDay)} vs {fmtRange(b.fromDay, b.toDay)}
                {cmp.perDay ? " · totales por día (los periodos duran distinto)" : ""}
                {cmp.status.available ? ". Verde = mejoró." : `. Sin comparación: ${cmp.status.reason}.`}
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
                  {(Object.keys(METRIC_LABEL) as MetricKey[]).map((k) => {
                    const fmt = (v: number | null, total: Money) =>
                      // The total keeps its priced part visible («+ sin precio»), like the card above.
                      k === "costUsd" ? moneyText(total) : k === "perConversationUsd" ? usdText(v) : k === "callsPerExecution" ? dec(v) : int(v);
                    return (
                      <tr key={k}>
                        <td className={a.name}>{METRIC_LABEL[k]}</td>
                        <td>
                          <V loading={loading} k={vk} w="6ch">
                            {fmt(cmp.current[k], cur.totals.cost)}
                          </V>
                        </td>
                        <td>
                          <V loading={loading} k={vk} w="6ch">
                            {fmt(cmp.previous[k], data.previous.totals.cost)}
                          </V>
                        </td>
                        <td>
                          <ChangeCell metric={k} c={cmp.changes[k]} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          {/* ------------------------------------------------ by business -- */}
          {oneBusiness ? null : (
          <section aria-labelledby="ai-clients" className={cx(s.card, s.enter)}>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <h2 id="ai-clients" className={s.h2}>
                Por negocio
              </h2>
              <p className={s.sub}>Gasto y costo por conversación. Cambio {baseLabel}.</p>
            </div>
            {cur.byClient.length === 0 ? (
              <p className={s.sub}>Sin llamadas al modelo en este periodo.</p>
            ) : (
              <div className={a.tableWrap}>
                <table className={a.table}>
                  <thead>
                    <tr>
                      <th>Negocio</th>
                      <th>Costo</th>
                      <th>Cambio</th>
                      <th>Conversaciones</th>
                      <th>Costo por conversación</th>
                      <th>Cambio</th>
                      <th>Citas del bot</th>
                      <th>Costo por cita</th>
                      <th>Tokens entrada / salida</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cur.byClient.map((c) => {
                      const ch = cmp.clients[c.clientId ?? ""];
                      return (
                        <tr key={c.clientId ?? "none"}>
                          <td className={a.name}>
                            <span className={a.sw} style={{ background: colorOf(c.clientId), display: "inline-block", marginRight: 8 }} aria-hidden />
                            {c.clientName}
                          </td>
                          <td>
                            <MoneyCell m={c.cost} rate={usdCop} />
                          </td>
                          <td>
                            <ChangeCell metric="costUsd" c={ch?.costUsd} />
                          </td>
                          <td>{nf.format(c.conversations)}</td>
                          <td>{usdText(c.perConversationUsd)}</td>
                          <td>
                            <ChangeCell metric="perConversationUsd" c={ch?.perConversationUsd} />
                          </td>
                          <td>{nf.format(c.botAppointments)}</td>
                          <td>{usdText(c.perAppointmentUsd)}</td>
                          <td>
                            {compact.format(c.inputTokens)} / {compact.format(c.outputTokens)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          )}

          {/* -------------------------------------------------- workflows -- */}
          <section aria-labelledby="ai-wf" className={cx(s.card, s.enter)}>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <h2 id="ai-wf" className={s.h2}>
                Por workflow
              </h2>
              <p className={s.sub}>Tokens por llamada y llamadas por ejecución: aquí se ve el efecto de cada cambio de prompt.</p>
            </div>
            {cur.byWorkflow.length === 0 ? (
              <p className={s.sub}>Sin workflows con llamadas al modelo en este periodo.</p>
            ) : (
              <div className={a.tableWrap}>
                <table className={a.table}>
                  <thead>
                    <tr>
                      <th>Workflow</th>
                      <th>Modelo</th>
                      <th>Costo</th>
                      <th>Cambio</th>
                      <th>Ejecuciones</th>
                      <th>Costo por ejecución</th>
                      <th>Tokens entrada por llamada</th>
                      <th>Cambio</th>
                      <th>Llamadas por ejecución</th>
                      <th>Cambio</th>
                      <th>Sin datos en n8n</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cur.byWorkflow.map((w) => {
                      const ch = cmp.workflows[w.workflowId];
                      return (
                        <tr key={w.workflowId}>
                          <td className={a.name}>
                            {w.workflowName}
                            <span className={a.small}>{w.clientName}</span>
                          </td>
                          <td>
                            {w.models.map((m) => (
                              <span key={m} className={a.chip} style={{ marginRight: 4 }}>
                                {m}
                              </span>
                            ))}
                          </td>
                          <td>
                            <MoneyCell m={w.cost} rate={usdCop} />
                          </td>
                          <td>
                            <ChangeCell metric="costUsd" c={ch?.costUsd} />
                          </td>
                          <td>{nf.format(w.executions)}</td>
                          <td>{usdText(w.perExecutionUsd)}</td>
                          <td>{int(w.calls > 0 ? w.inputTokens / w.calls : null)}</td>
                          <td>
                            <ChangeCell metric="inputPerCall" c={ch?.inputPerCall} />
                          </td>
                          <td>{dec(w.executions > 0 ? w.calls / w.executions : null)}</td>
                          <td>
                            <ChangeCell metric="callsPerExecution" c={ch?.callsPerExecution} />
                          </td>
                          <td>{w.coverage.withoutData > 0 ? nf.format(w.coverage.withoutData) : "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <div className={a.cols}>
            <section aria-labelledby="ai-models" className={cx(s.card, s.enter)}>
              <h2 id="ai-models" className={s.h2}>
                Por modelo
              </h2>
              {cur.byModel.length === 0 ? (
                <p className={s.sub}>Sin llamadas al modelo en este periodo.</p>
              ) : (
                <div className={a.tableWrap}>
                  <table className={a.table}>
                    <thead>
                      <tr>
                        <th>Modelo</th>
                        <th>Conteo</th>
                        <th>Tokens entrada / salida</th>
                        <th>Costo</th>
                      </tr>
                    </thead>
                    <tbody>
                      {cur.byModel.map((m) => (
                        <tr key={`${m.model}-${m.source}`}>
                          <td className={a.name}>{m.model ?? "desconocido"}</td>
                          <td>
                            <KindTag kind={m.source === "estimate" ? "estimate" : "measured"} />
                          </td>
                          <td>
                            {compact.format(m.inputTokens)} / {compact.format(m.outputTokens)}
                          </td>
                          <td>
                            <MoneyCell m={m.cost} rate={usdCop} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section aria-labelledby="ai-meet" className={cx(s.card, s.enter)}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <h2 id="ai-meet" className={s.h2} style={{ flex: 1 }}>
                  Reuniones
                </h2>
                <KindTag kind="measured" />
              </div>
              {cur.meetings.analyses === 0 ? (
                <p className={s.sub}>Sin análisis de reuniones en este periodo.</p>
              ) : (
                <div className={a.tableWrap}>
                  <table className={a.table}>
                    <tbody>
                      <tr>
                        <td>Análisis</td>
                        <td>{nf.format(cur.meetings.analyses)}</td>
                      </tr>
                      <tr>
                        <td>Tokens entrada / salida</td>
                        <td>
                          {nf.format(cur.meetings.inputTokens)} / {nf.format(cur.meetings.outputTokens)}
                        </td>
                      </tr>
                      <tr>
                        <td>Costo</td>
                        <td>
                          <MoneyCell m={cur.meetings.cost} rate={usdCop} />
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              )}
              <p className={s.sub}>Conteo real del proveedor. No se suma al costo de los bots.</p>
            </section>
          </div>

          <section aria-labelledby="ai-prices" className={cx(s.card, s.cardSlim, s.enter)}>
            <h2 id="ai-prices" className={s.h2}>
              Precios usados
            </h2>
            <div className={a.tableWrap}>
              <table className={a.table}>
                <thead>
                  <tr>
                    <th>Modelo</th>
                    <th>Entrada</th>
                    <th>Entrada en caché</th>
                    <th>Salida</th>
                    <th>Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {cur.prices.map((x) => (
                    <tr key={x.model}>
                      <td className={a.name}>{x.model}</td>
                      <td>{usdText(x.inPerM)}</td>
                      <td>{x.cachedInPerM === null ? "—" : usdText(x.cachedInPerM)}</td>
                      <td>{usdText(x.outPerM)}</td>
                      <td className={a.muted}>{x.verified ? `Verificado ${x.checkedAt}` : `Por verificar (${x.checkedAt})`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className={s.sub}>US$ por millón de tokens. Un modelo que no está aquí aparece como «sin precio»: sus tokens se cuentan, su costo no se inventa.</p>
          </section>
        </>
      )}
    </div>
  );
}

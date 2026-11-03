"use client";

import { useState } from "react";
import a from "./aiCosts.module.css";
import { cx } from "@/components/value/bits";
import type { DayCost } from "@worker/analytics/aiCostModel.js";
import { usdText } from "@worker/analytics/aiCostReport.js";

/**
 * Gasto diario — columns stacked by business (fixed color per business, legend + table view in
 * the parent), a US$ axis with recessive gridlines, a dashed line for the comparison period's
 * daily average, and a per-day detail card on hover/focus.
 */

export interface Series {
  key: string;
  name: string;
  color: string;
}

const nf = new Intl.NumberFormat("es-CO");
const dayFmt = new Intl.DateTimeFormat("es-CO", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const shortFmt = new Intl.DateTimeFormat("es-CO", { day: "numeric", month: "short", timeZone: "UTC" });
const asDate = (day: string) => new Date(`${day}T12:00:00Z`);
export const dayLong = (day: string) => {
  const t = dayFmt.format(asDate(day)).replace(/\./g, "");
  return t.charAt(0).toUpperCase() + t.slice(1);
};
const dayShort = (day: string) => shortFmt.format(asDate(day)).replace(/\./g, "");

/** 0 … top in 3–5 round steps (1, 2, 2.5, 5 × 10ⁿ). */
export function niceTicks(max: number): number[] {
  if (!(max > 0)) return [0];
  const rough = max / 4;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((v) => v >= rough)!;
  const top = step * Math.ceil(max / step - 1e-9);
  const ticks: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(Number(v.toFixed(10)));
  return ticks;
}

function axisUsd(v: number): string {
  if (v === 0) return "US$0";
  const digits = v < 1 ? 2 : v < 10 ? 1 : 0;
  return `US$${v.toLocaleString("es-CO", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export function DailyCostChart({
  days,
  series,
  baselineAvgUsd,
  usdCop,
  showCalls = true,
}: {
  days: DayCost[];
  series: Series[];
  baselineAvgUsd: number | null;
  usdCop: number | null;
  /** Calls are counted for all businesses together; hidden while the chart is filtered. */
  showCalls?: boolean;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const peak = Math.max(0, ...days.map((d) => d.usd ?? 0));
  if (!(peak > 0)) return <p className={a.muted} style={{ margin: 0, fontSize: 13 }}>Sin gasto con precio en este periodo.</p>;

  const ticks = niceTicks(Math.max(peak, baselineAvgUsd ?? 0));
  const top = ticks[ticks.length - 1] || 1;
  const pct = (v: number) => `${(100 * v) / top}%`;
  const every = days.length <= 10 ? 1 : Math.ceil(days.length / 7);
  const h = hover === null ? null : days[hover];
  const cop = (v: number | null) => (v === null || usdCop === null ? null : `$${Math.round(v * usdCop).toLocaleString("es-CO")} COP`);

  return (
    <div className={a.chart}>
      <div className={a.yAxis} aria-hidden>
        {ticks.map((t) => (
          <span key={t} style={{ bottom: pct(t) }}>
            {axisUsd(t)}
          </span>
        ))}
      </div>
      <div className={a.plot} onMouseLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <span key={t} className={a.grid} style={{ bottom: pct(t) }} aria-hidden />
        ))}
        {baselineAvgUsd !== null && baselineAvgUsd > 0 ? <span className={a.refLine} style={{ bottom: pct(baselineAvgUsd) }} aria-hidden /> : null}
        <div className={cx(a.bars, hover !== null && a.dim)} role="list" aria-label="Gasto estimado por día">
          {days.map((d, i) => {
            const segs = series.filter((sr) => (d.byClient[sr.key] ?? 0) > 0);
            return (
              <button
                key={d.day}
                type="button"
                role="listitem"
                className={cx(a.col, hover === i && a.on, "u-focus")}
                aria-label={`${dayLong(d.day)}: ${d.usd === null ? (d.calls > 0 ? "sin precio" : "sin llamadas") : usdText(d.usd)}`}
                onMouseEnter={() => setHover(i)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
              >
                {segs.length === 0 && d.calls > 0 ? <span className={a.unknown} style={{ height: "6%" }} /> : null}
                {segs.map((sr, j) => (
                  <span
                    key={sr.key}
                    className={cx(a.seg2, j === segs.length - 1 && a.top)}
                    style={{ height: pct(d.byClient[sr.key]), background: sr.color }}
                  />
                ))}
              </button>
            );
          })}
        </div>
        {h ? (
          <div
            role="status"
            className={a.tip}
            style={{
              left: `${((hover! + 0.5) / days.length) * 100}%`,
              transform: `translateX(${hover! < days.length / 4 ? "-12%" : hover! > (3 * days.length) / 4 ? "-88%" : "-50%"})`,
            }}
          >
            <span className={a.name}>{dayLong(h.day)}</span>
            {series
              .filter((sr) => h.byClient[sr.key] !== undefined)
              .map((sr) => (
                <span key={sr.key} className={a.tipRow}>
                  <span>
                    <span className={a.sw} style={{ background: sr.color }} />
                    {sr.name}
                  </span>
                  <span>{usdText(h.byClient[sr.key])}</span>
                </span>
              ))}
            <span className={cx(a.tipRow, a.tipTotal)}>
              <span>Total</span>
              <span>{h.usd === null ? (h.calls > 0 ? "sin precio" : "—") : usdText(h.usd)}</span>
            </span>
            <span className={a.small}>
              {[cop(h.usd), showCalls ? `${nf.format(h.calls)} llamadas` : null].filter(Boolean).join(" · ")}
            </span>
          </div>
        ) : null}
      </div>
      <div className={a.xAxis} aria-hidden>
        {days.map((d, i) =>
          i % every === 0 || (i === days.length - 1 && i % every >= every / 2) ? (
            <span key={d.day} style={{ left: `${((i + 0.5) / days.length) * 100}%` }}>
              {dayShort(d.day)}
            </span>
          ) : null,
        )}
      </div>
    </div>
  );
}

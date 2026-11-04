"use client";

import { useState } from "react";
import s from "@/components/value/valueDashboard.module.css";
import a from "./aiCosts.module.css";
import { cx, V } from "@/components/value/bits";
import { Seg as ValueSeg } from "@/components/value/sections";
import { DailyCostChart, type ChartDay, type Series } from "./DailyCostChart";
import { assignChartColors } from "@worker/analytics/chartColors.js";
import { changeText } from "@worker/analytics/aiCostReport.js";
import type { Change } from "@worker/analytics/aiCostModel.js";
import type { UsageBreakdown, UsageEntity } from "@worker/analytics/executionsModel.js";

/**
 * «Quién más usa la plataforma» — production executions per business or per workflow, ranked,
 * with a daily chart stacked by entity. One selector: «Todos», or a single business/workflow to
 * see it alone (chip or ranking row). Color follows the entity (a business keeps the color chosen
 * on the home, in the business ⋯ menu), never its rank; past 8 the rest is «Otros».
 */

const nf = new Intl.NumberFormat("es-CO");
const pct = (v: number | null) => (v === null ? "—" : `${v.toLocaleString("es-CO", { maximumFractionDigits: 1 })} %`);
const UNITS = {
  value: (v: number) => nf.format(v),
  axis: (v: number) => nf.format(v),
  label: "Ejecuciones de producción por día",
  empty: "Sin ejecuciones en este periodo.",
};

function changeLine(c: Change, vsLabel: string): { text: string; cls: string } {
  if (c.kind === "no_prev") return { text: "nuevo en el periodo", cls: a.muted };
  if (c.kind !== "pct") return { text: "", cls: a.muted };
  return { text: `${changeText(c)} ${vsLabel}`, cls: c.pct === 0 ? a.muted : c.pct < 0 ? a.good : a.bad };
}

/** Businesses: the tenant-wide slots (same color as every other screen). Workflows: by name. */
function colorsOf(entities: UsageEntity[], businessSlots: Record<string, string> | null): Map<string, string> {
  const slots = businessSlots
    ? new Map(Object.entries(businessSlots))
    : assignChartColors(entities.filter((e) => !e.isOther).map((e) => ({ key: e.key, name: e.name, chartColor: e.chartColor })));
  return new Map(entities.map((e) => [e.key, e.isOther ? "var(--vd-tertiary)" : slots.get(e.key) ? `var(--ai-${slots.get(e.key)})` : "var(--vd-tertiary)"]));
}

export function UsageCard({
  byClient,
  byWorkflow,
  days,
  loading,
  vk,
  vsLabel,
  businessSlots,
}: {
  /** null in a business view: only its workflows. */
  byClient: UsageBreakdown | null;
  byWorkflow: UsageBreakdown;
  days: string[];
  loading: boolean;
  vk: string;
  vsLabel: string;
  businessSlots: Record<string, string>;
}) {
  const [by, setBy] = useState<"client" | "workflow">(byClient ? "client" : "workflow");
  /** null = «Todos». A key that left the period (new dates) falls back to «Todos». */
  const [picked, setPicked] = useState<string | null>(null);
  const data = by === "client" && byClient ? byClient : byWorkflow;
  const one = data.entities.find((e) => e.key === picked) ?? null;
  const colors = colorsOf(data.entities, by === "client" && byClient ? businessSlots : null);
  const shown = one ? [one] : data.entities;
  const series: Series[] = shown.map((e) => ({ key: e.key, name: e.name, color: colors.get(e.key)! }));
  const top = Math.max(0, ...data.entities.map((e) => e.production));
  const what = by === "client" ? "negocio" : "workflow";

  const chartDays: ChartDay[] = days.map((day, i) => {
    const byKey = Object.fromEntries(shown.map((e) => [e.key, e.daily[i] ?? 0]));
    const sum = shown.reduce((n, e) => n + (e.daily[i] ?? 0), 0);
    return { day, usd: sum, calls: sum, byClient: byKey };
  });

  return (
    <section aria-labelledby="ex-usage" className={cx(s.card, s.enter)}>
      <div className={a.cardHead}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
          <h2 id="ex-usage" className={s.h2}>
            Quién más usa la plataforma
          </h2>
          <p className={s.sub}>Ejecuciones de producción por {what}, de mayor a menor.</p>
        </div>
        {byClient ? (
          <ValueSeg
            label="Agrupar por"
            value={by}
            onChange={(v) => {
              setBy(v);
              setPicked(null);
            }}
            options={[["client", "Negocios"], ["workflow", "Workflows"]]}
          />
        ) : null}
      </div>

      {data.entities.length === 0 ? (
        <p className={s.sub}>Sin ejecuciones de producción en este periodo.</p>
      ) : (
        <>
          {data.entities.length > 1 ? (
            <div role="radiogroup" aria-label={by === "client" ? "Negocio" : "Workflow"} className={a.toggles}>
              <button type="button" role="radio" aria-checked={one === null} className={cx(a.toggle, one !== null && a.toggleOff, "u-focus")} onClick={() => setPicked(null)}>
                Todos
              </button>
              {data.entities.map((e) => {
                const on = one?.key === e.key;
                return (
                  <button key={e.key} type="button" role="radio" aria-checked={on} className={cx(a.toggle, !on && a.toggleOff, "u-focus")} onClick={() => setPicked(on ? null : e.key)}>
                    <span className={a.toggleSw} style={{ background: on || one === null ? colors.get(e.key) : "transparent", borderColor: colors.get(e.key) }} aria-hidden />
                    {e.name}
                  </button>
                );
              })}
            </div>
          ) : null}

          <div className={a.usageTogether}>
            <div>
              <DailyCostChart days={chartDays} series={series} baselineAvgUsd={null} usdCop={null} units={UNITS} />
            </div>
            <ol className={a.rank} aria-label={`Ranking por ${what}`}>
              {data.entities.map((e) => {
                const ch = changeLine(e.change, vsLabel);
                const dim = one !== null && one.key !== e.key;
                return (
                  <li key={e.key}>
                    <button
                      type="button"
                      className={cx(a.rankRow, dim && a.rankDim, "u-focus")}
                      aria-pressed={one?.key === e.key}
                      aria-label={`${e.name}: ${nf.format(e.production)} ejecuciones. ${one?.key === e.key ? "Ver todos" : "Ver solo este"}`}
                      onClick={() => setPicked(one?.key === e.key ? null : e.key)}
                    >
                      <span className={a.rankTop}>
                        <span className={a.rankName}>
                          <span className={a.sw} style={{ background: colors.get(e.key) }} aria-hidden />
                          {e.name}
                        </span>
                        <V loading={loading} k={vk} w="5ch" className={a.num}>
                          {nf.format(e.production)}
                        </V>
                      </span>
                      <span className={a.rankBar} aria-hidden>
                        <span style={{ width: `${top > 0 ? (100 * e.production) / top : 0}%`, background: colors.get(e.key) }} />
                      </span>
                      <span className={a.small}>
                        {pct(e.sharePct)} del total · {nf.format(e.withAi)} con IA · {pct(e.wastePct)} sin llegar al modelo
                        {ch.text ? (
                          <>
                            {" · "}
                            <span className={ch.cls}>{ch.text}</span>
                          </>
                        ) : null}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </div>
        </>
      )}
    </section>
  );
}

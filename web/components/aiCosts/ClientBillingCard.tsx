"use client";

import s from "@/components/value/valueDashboard.module.css";
import a from "./aiCosts.module.css";
import { cx, KindTag } from "@/components/value/bits";
import type { ClientBilling } from "@/lib/aiCosts";
import { usdText } from "@worker/analytics/aiCostReport.js";

/**
 * «Facturado por OpenAI» in a business owner's view: ONLY this business's share of the invoice.
 * Exact when the business has its own OpenAI project; otherwise (or for days before it had one)
 * its part of the shared project, split by its bots' usage — and labelled approximate.
 */
export function ClientBillingCard({ billing, usdCop, estimatedUsd }: { billing: ClientBilling; usdCop: number | null; estimatedUsd: number | null }) {
  const cur = billing.current;
  const prev = billing.previous;
  const cop = (v: number | null) => (v === null || usdCop === null ? null : `$${Math.round(v * usdCop).toLocaleString("es-CO")} COP`);
  const exactOnly = !!cur && cur.sharedUsd === 0 && cur.exactUsd > 0;
  const change = cur && prev && prev.totalUsd > 0 ? Math.round(((cur.totalUsd - prev.totalUsd) / prev.totalUsd) * 1000) / 10 : null;

  return (
    <section aria-labelledby="ai-client-billing" className={cx(s.card, s.enter)}>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <h2 id="ai-client-billing" className={s.h2}>
            Facturado por OpenAI
          </h2>
          <KindTag kind={exactOnly ? "measured" : "estimate"} />
        </div>
        <p className={s.sub}>
          {exactOnly
            ? "Lo que OpenAI facturó por los bots de tu negocio, tomado directamente de su factura."
            : billing.hasOwnProject
              ? "Parte exacta de tu proyecto en OpenAI, más tu parte del proyecto compartido en los días anteriores, según el uso de tus bots (aproximado)."
              : "Tu parte de lo que OpenAI facturó, calculada según cuánto usaron tus bots cada día (aproximado)."}
        </p>
      </div>
      {!cur ? (
        <p className={s.sub}>Sin datos de OpenAI para estas fechas todavía.</p>
      ) : (
        <dl className={a.stats}>
          <div className={a.stat}>
            <dt className={a.muted}>Facturado en el periodo</dt>
            <dd>
              <span className={a.statValue}>{usdText(cur.totalUsd)}</span>
              {cop(cur.totalUsd) ? <span className={a.small}>{cop(cur.totalUsd)}</span> : null}
            </dd>
          </div>
          <div className={a.stat}>
            <dt className={a.muted}>Frente a la comparación</dt>
            <dd>
              <span className={a.statValue}>{prev ? usdText(prev.totalUsd) : "—"}</span>
              <span className={cx(a.small, change === null || change === 0 ? undefined : change < 0 ? a.good : a.bad)}>
                {change === null ? "sin datos para comparar" : `Ahora ${change > 0 ? "▲" : "▼"} ${Math.abs(change).toLocaleString("es-CO")} %`}
              </span>
            </dd>
          </div>
          <div className={a.stat}>
            <dt className={a.muted}>De eso, exacto</dt>
            <dd>
              <span className={a.statValue}>{usdText(cur.exactUsd)}</span>
              <span className={a.small}>repartido (aprox.): {usdText(cur.sharedUsd)}</span>
            </dd>
          </div>
          <div className={a.stat}>
            <dt className={a.muted}>Estimado por n8n</dt>
            <dd>
              <span className={a.statValue}>{estimatedUsd === null ? "—" : usdText(estimatedUsd)}</span>
              <span className={a.small}>lo que se ve en las ejecuciones</span>
            </dd>
          </div>
        </dl>
      )}
    </section>
  );
}

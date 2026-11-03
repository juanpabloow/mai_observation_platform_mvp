"use client";

import { useState, useTransition } from "react";
import s from "@/components/value/valueDashboard.module.css";
import a from "./aiCosts.module.css";
import { cx, KindTag } from "@/components/value/bits";
import { buttonClass, FIELD } from "@/components/ui/controls";
import { updatedLabel } from "@/lib/valueDashboardView";
import type { OpenAiBilling } from "@/lib/aiCosts";
import { connectOpenAiAction, disconnectOpenAiAction, setClientOpenAiProjectAction, syncOpenAiNowAction } from "@/lib/openaiActions";
import { usdText } from "@worker/analytics/aiCostReport.js";

/**
 * «Facturado por OpenAI» — what the organization was actually billed (Costs API), next to the
 * n8n estimate, and OpenAI's own token counts per model (Usage API). Agency only. The key is
 * pasted once, tested, stored encrypted and never shown again (only its last 4 characters).
 */

const nf = new Intl.NumberFormat("es-CO");
const compact = new Intl.NumberFormat("es-CO", { notation: "compact", maximumFractionDigits: 1 });

export function OpenAiBillingCard({
  billing,
  estimatedUsd,
  estimatedPartial,
  usdCop,
  tz,
  estimates,
  colors,
  onChanged,
}: {
  billing: OpenAiBilling;
  estimatedUsd: number | null;
  estimatedPartial: boolean;
  usdCop: number | null;
  tz: string;
  /** n8n estimate per business (client id → US$, null = unpriced). */
  estimates: Record<string, number | null>;
  /** Chart color per business (client id → CSS color). */
  colors: Record<string, string>;
  /** Reload the screen's data after connecting, syncing or disconnecting. */
  onChanged: () => void;
}) {
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);
  const [pending, start] = useTransition();

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) =>
    start(async () => {
      setError(null);
      const res = await fn();
      if (!res.ok) setError(res.error ?? "Algo salió mal.");
      else after?.();
      onChanged();
    });

  const cop = (v: number | null) => (v === null || usdCop === null ? null : `$${Math.round(v * usdCop).toLocaleString("es-CO")} COP`);
  const billed = billing.totalUsd;
  const change =
    billed !== null && billing.previousTotalUsd !== null && billing.previousTotalUsd > 0
      ? Math.round(((billed - billing.previousTotalUsd) / billing.previousTotalUsd) * 1000) / 10
      : null;
  const unseen = billed !== null && estimatedUsd !== null ? billed - estimatedUsd : null;
  const coverage = billed !== null && billed > 0 && estimatedUsd !== null ? Math.round((100 * estimatedUsd) / billed) : null;
  const inTotal = billing.models.reduce((n, m) => n + m.input_tokens, 0);
  const cachedTotal = billing.models.reduce((n, m) => n + m.cached_input_tokens, 0);

  return (
    <section aria-labelledby="ai-billing" className={cx(s.card, s.enter)}>
      <div className={a.cardHead}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <h2 id="ai-billing" className={s.h2}>
              Facturado por OpenAI
            </h2>
            {billing.connected ? <KindTag kind="measured" /> : null}
          </div>
          <p className={s.sub}>
            {billing.connected
              ? `Lo que OpenAI cobró a la organización: incluye razonamiento, caché y cualquier uso fuera de n8n. Clave ····${billing.keyHint ?? ""} · ${
                  billing.lastSyncedAt ? updatedLabel(billing.lastSyncedAt, tz).replace(/^Actualizado/, "sincronizado") : "sin sincronizar aún"
                }.`
              : "Conecta la organización de OpenAI para ver lo que realmente se facturó, no solo la estimación de n8n."}
          </p>
        </div>
        {billing.connected ? (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button type="button" disabled={pending} className={buttonClass({ variant: "secondary", size: "sm" })} onClick={() => run(syncOpenAiNowAction)}>
              {pending ? "Sincronizando…" : "Sincronizar ahora"}
            </button>
            {confirmOff ? (
              <>
                <button type="button" disabled={pending} className={buttonClass({ variant: "secondary", size: "sm" })} onClick={() => run(disconnectOpenAiAction, () => setConfirmOff(false))}>
                  Sí, desconectar
                </button>
                <button type="button" className={buttonClass({ variant: "secondary", size: "sm" })} onClick={() => setConfirmOff(false)}>
                  Cancelar
                </button>
              </>
            ) : (
              <button type="button" className={buttonClass({ variant: "secondary", size: "sm" })} onClick={() => setConfirmOff(true)}>
                Desconectar
              </button>
            )}
          </div>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className={a.popError} style={{ margin: 0 }}>
          {error}
        </p>
      ) : null}
      {billing.connected && billing.lastSyncError && !error ? (
        <p role="status" className={a.popError} style={{ margin: 0 }}>
          Última sincronización con error: {billing.lastSyncError}
        </p>
      ) : null}

      {!billing.connected ? (
        <form
          className={a.connect}
          onSubmit={(e) => {
            e.preventDefault();
            run(() => connectOpenAiAction(key), () => setKey(""));
          }}
        >
          <ol className={a.steps}>
            <li>
              En <strong>platform.openai.com</strong> → Settings → Organization → <strong>Admin keys</strong> → «Create new admin key». Solo puede crearla el dueño de la
              organización.
            </li>
            <li>Pégala aquí. Se comprueba con OpenAI, se guarda cifrada y no se vuelve a mostrar.</li>
          </ol>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              aria-label="Admin key de OpenAI"
              placeholder="sk-admin-…"
              className={cx(FIELD, "h-[40px]")}
              style={{ flex: "1 1 280px", minWidth: 0 }}
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
            <button type="submit" disabled={pending || !key.trim()} className={buttonClass({ variant: "primary", size: "sm" })}>
              {pending ? "Comprobando…" : "Conectar"}
            </button>
          </div>
        </form>
      ) : billed === null ? (
        <p className={s.sub}>Sin datos de OpenAI para estas fechas todavía.</p>
      ) : (
        <>
          <dl className={a.stats}>
            <div className={a.stat}>
              <dt className={a.muted}>Facturado en el periodo</dt>
              <dd>
                <span className={a.statValue}>{usdText(billed)}</span>
                {cop(billed) ? <span className={a.small}>{cop(billed)}</span> : null}
              </dd>
            </div>
            <div className={a.stat}>
              <dt className={a.muted}>Frente a la comparación</dt>
              <dd>
                <span className={a.statValue}>{usdText(billing.previousTotalUsd)}</span>
                <span className={cx(a.small, change === null || change === 0 ? undefined : change < 0 ? a.good : a.bad)}>
                  {change === null ? "sin datos para comparar" : `Ahora ${change > 0 ? "▲" : change < 0 ? "▼" : "="} ${Math.abs(change).toLocaleString("es-CO")} %`}
                </span>
              </dd>
            </div>
            <div className={a.stat}>
              <dt className={a.muted}>Estimado por n8n</dt>
              <dd>
                <span className={a.statValue}>{estimatedUsd === null ? "—" : usdText(estimatedUsd)}</span>
                <span className={a.small}>
                  {coverage === null ? "—" : `cubre ${coverage} % de lo facturado`}
                  {estimatedPartial ? " · hay modelos sin precio" : ""}
                </span>
              </dd>
            </div>
            <div className={a.stat}>
              <dt className={a.muted}>Lo que n8n no ve</dt>
              <dd>
                <span className={a.statValue}>{unseen === null ? "—" : usdText(Math.max(0, unseen))}</span>
                <span className={a.small}>razonamiento, pruebas y otros usos de la cuenta</span>
              </dd>
            </div>
          </dl>

          <div className={a.cols}>
            <div className={a.tableWrap}>
              <table className={a.table}>
                <thead>
                  <tr>
                    <th>Modelo</th>
                    <th>Solicitudes</th>
                    <th>Entrada</th>
                    <th>En caché</th>
                    <th>Salida</th>
                  </tr>
                </thead>
                <tbody>
                  {billing.models.map((m) => (
                    <tr key={m.model || "sin-modelo"}>
                      <td className={a.name}>{m.model || "sin modelo"}</td>
                      <td>{nf.format(m.requests)}</td>
                      <td>{compact.format(m.input_tokens)}</td>
                      <td>
                        {compact.format(m.cached_input_tokens)}
                        {m.input_tokens > 0 ? <span className={a.small}>{Math.round((100 * m.cached_input_tokens) / m.input_tokens)} %</span> : null}
                      </td>
                      <td>{compact.format(m.output_tokens)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {inTotal > 0 ? (
                <p className={s.sub} style={{ marginTop: 8 }}>
                  {Math.round((100 * cachedTotal) / inTotal)} % de la entrada salió del caché de OpenAI (se cobra al ~10 %).
                </p>
              ) : null}
            </div>
            <div className={a.tableWrap}>
              <table className={a.table}>
                <thead>
                  <tr>
                    <th>Concepto facturado</th>
                    <th>US$</th>
                  </tr>
                </thead>
                <tbody>
                  {billing.lines.slice(0, 8).map((l) => (
                    <tr key={l.line_item || "sin-concepto"}>
                      <td>{l.line_item || "sin concepto"}</td>
                      <td>{usdText(l.amount_usd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          {/* --------------------------------------------- by business -- */}
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <h3 className={a.subTitle}>Por negocio</h3>
            <p className={s.sub}>
              <strong>Exacto</strong>: el proyecto de OpenAI propio del negocio. <strong>Repartido</strong>: su parte de los proyectos compartidos, según cuánto usaron sus bots cada
              día (aproximado). Lo que ningún bot explica queda <strong>sin asignar</strong>.
            </p>
          </div>
          <div className={a.tableWrap}>
            <table className={a.table}>
              <thead>
                <tr>
                  <th>Negocio</th>
                  <th>Proyecto de OpenAI</th>
                  <th>Exacto</th>
                  <th>Repartido</th>
                  <th>Facturado</th>
                  <th>Cambio</th>
                  <th>Estimado n8n</th>
                </tr>
              </thead>
              <tbody>
                {(billing.businesses ?? []).map((b) => {
                  const part = billing.split?.byClient[b.id];
                  const prev = billing.previousSplit?.byClient[b.id];
                  const total = part?.totalUsd ?? 0;
                  const ch = prev && prev.totalUsd > 0 ? Math.round(((total - prev.totalUsd) / prev.totalUsd) * 1000) / 10 : null;
                  const own = (billing.projects ?? []).find((p) => p.client_id === b.id)?.project_id ?? "";
                  return (
                    <tr key={b.id}>
                      <td className={a.name}>
                        <span className={a.sw} style={{ background: colors[b.id] ?? "var(--vd-tertiary)", display: "inline-block", marginRight: 8 }} aria-hidden />
                        {b.name}
                      </td>
                      <td>
                        <select
                          aria-label={`Proyecto de OpenAI de ${b.name}`}
                          className={cx(FIELD, "h-[34px]")}
                          style={{ minWidth: 190 }}
                          value={own}
                          disabled={pending}
                          onChange={(e) => run(() => setClientOpenAiProjectAction({ clientId: b.id, projectId: e.target.value || null }))}
                        >
                          <option value="">Sin proyecto propio</option>
                          {(billing.projects ?? []).map((p) => (
                            <option key={p.project_id} value={p.project_id}>
                              {(p.name ?? p.project_id) + (p.status === "archived" ? " (archivado)" : "")}
                              {p.client_id && p.client_id !== b.id ? " · en otro negocio" : ""}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>{usdText(part?.exactUsd ?? 0)}</td>
                      <td className={part && part.sharedUsd > 0 ? undefined : a.muted}>{usdText(part?.sharedUsd ?? 0)}</td>
                      <td className={a.name}>
                        {usdText(total)}
                        {cop(total) ? <span className={a.small}>{cop(total)}</span> : null}
                      </td>
                      <td className={ch === null || ch === 0 ? a.muted : ch < 0 ? a.good : a.bad}>
                        {ch === null ? "—" : `${ch > 0 ? "▲" : "▼"} ${Math.abs(ch).toLocaleString("es-CO")} %`}
                      </td>
                      <td className={a.muted}>{estimates[b.id] === undefined || estimates[b.id] === null ? "—" : usdText(estimates[b.id])}</td>
                    </tr>
                  );
                })}
                <tr>
                  <td className={a.name}>Sin asignar</td>
                  <td className={a.muted}>Pruebas, editor de n8n y otros usos</td>
                  <td />
                  <td />
                  <td className={a.name}>{usdText(billing.split?.unassignedUsd ?? 0)}</td>
                  <td />
                  <td />
                </tr>
              </tbody>
            </table>
          </div>

          <p className={s.sub}>Días en UTC, como los cuenta OpenAI. Es toda la organización: incluye pruebas, el editor de n8n y cualquier otro uso de la misma cuenta.</p>
        </>
      )}
    </section>
  );
}

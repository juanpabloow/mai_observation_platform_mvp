"use client";

import s from "./valueDashboard.module.css";
import { Chip, CloseIcon, cx } from "./bits";
import { buttonClass } from "@/components/ui/controls";
import { useTrappedPanel } from "@/components/ui/Overlay";
import { evidenceCopy, fmtDay, fmtPct, qualityRows, workflowEvidenceRow } from "@/lib/valueDashboardView";
import type { ValueDashboardData } from "@worker/analytics/valueDashboardModel.js";

/**
 * «Estado de los datos». The owner sees one plain row per data source. The agency also sees
 * the evidence gate per workflow (Q9 state + reason) and the manual review — the inputs that
 * decide whether conversational metrics may be shown. No «Verificado» state exists here: a
 * row says what was measured, or why it is not shown.
 */
export function QualityDialog({ data, onClose }: { data: ValueDashboardData; onClose: () => void }) {
  const ref = useTrappedPanel({ active: true, onClose });
  const agency = data.viewer === "agency";
  const ev = data.evidence;
  const rows = qualityRows(data);
  return (
    <>
      <button type="button" aria-label="Cerrar estado de los datos" tabIndex={-1} className={s.scrim} onClick={onClose} />
      <aside ref={ref} role="dialog" aria-modal="true" aria-labelledby="vd-q" className={cx(s.dialog, agency && s.dialogWide)}>
        <div className={s.dialogHead}>
          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
            <h2 id="vd-q" style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
              Estado de los datos
            </h2>
            <span className={s.note}>{agency ? "Vista agencia · detalle por workflow" : "Vista dueño"}</span>
          </div>
          <button type="button" aria-label="Cerrar estado de los datos" onClick={onClose} className={buttonClass({ variant: "tertiary", className: "!w-[44px] !px-0" })}>
            <CloseIcon />
          </button>
        </div>
        <div className={s.dialogBody} style={{ gap: 0, paddingTop: 8 }}>
          {rows.map((q) => (
            <div key={q.label} style={{ display: "flex", flexDirection: "column", gap: 4, padding: "14px 0", borderBottom: "1px solid var(--line-soft)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ flex: 1, fontSize: 14.5, fontWeight: 590 }}>{q.label}</span>
                <Chip tone={q.tone}>{q.status}</Chip>
              </div>
              <span className={s.secondary} style={{ fontSize: 13.5, lineHeight: 1.5 }}>
                {q.text}
              </span>
            </div>
          ))}
          {agency ? (
            <div style={{ display: "flex", flexDirection: "column", paddingTop: 18, gap: 4 }}>
              <span className={s.overline}>EVIDENCIA DE CONVERSACIONES POR WORKFLOW</span>
              <span className={s.note} style={{ lineHeight: 1.5 }}>
                Contraste entre turnos reconstruidos de las ejecuciones y mensajes reportados: ventana {ev.params.ventana.replace("minutes", "min")}, tolerancia{" "}
                {ev.params.tolerancia.replace("minutes", "min")}, umbral {fmtPct(ev.params.umbral)}, mínimo {ev.params.minimo} turnos (metodología {ev.params.methodVersion}). Son
                un punto de partida, no una certificación.
              </span>
              <div role="table" aria-label="Evidencia por workflow" style={{ display: "flex", flexDirection: "column" }}>
                <div role="row" className={cx(s.qRow, s.qRowAgency)} style={{ fontSize: 12, fontWeight: 600, letterSpacing: "0.04em", color: "var(--vd-tertiary)" }}>
                  <span role="columnheader">WORKFLOW</span>
                  <span role="columnheader">FUENTE</span>
                  <span role="columnheader">ESTADO</span>
                  <span role="columnheader">MOTIVO</span>
                </div>
                {ev.workflows.length === 0 ? (
                  <div role="row" className={s.qRow}>
                    <span role="cell" className={s.secondary}>
                      Ningún workflow de este negocio tuvo ejecuciones, mensajes o mapeos de conversación en el periodo.
                    </span>
                  </div>
                ) : (
                  ev.workflows.map((w) => {
                    const r = workflowEvidenceRow(w, ev.params.minimo, ev.params.umbral);
                    return (
                      <div key={w.id} role="row" className={cx(s.qRow, s.qRowAgency)}>
                        <span role="cell" style={{ fontWeight: 590, lineHeight: 1.35, overflowWrap: "anywhere" }}>
                          {r.name}
                        </span>
                        <span role="cell" className={s.secondary}>
                          Conversaciones
                        </span>
                        <span role="cell">
                          <Chip tone={r.tone}>{r.status}</Chip>
                        </span>
                        <span role="cell" className={s.secondary} style={{ lineHeight: 1.45 }}>
                          {r.why}
                        </span>
                      </div>
                    );
                  })
                )}
                <div role="row" className={cx(s.qRow, s.qRowAgency)}>
                  <span role="cell" style={{ fontWeight: 590 }}>
                    Revisión manual
                  </span>
                  <span role="cell" className={s.secondary}>
                    Muestra de ejecuciones
                  </span>
                  <span role="cell">
                    <Chip tone={ev.review?.status === "approved" && ev.review.coversAll ? "ok" : ev.review ? "warn" : "info"}>
                      {!ev.review ? "Sin registrar" : ev.review.status === "rejected" ? "No aprobada" : ev.review.coversAll ? "Aprobada" : "Desactualizada"}
                    </Chip>
                  </span>
                  <span role="cell" className={s.secondary} style={{ lineHeight: 1.45 }}>
                    {!ev.review
                      ? "No hay una revisión manual registrada para este negocio. Sin ella las métricas conversacionales siguen ocultas aunque el contraste sea suficiente."
                      : `Revisión del ${fmtDay(ev.review.reviewedAt.slice(0, 10), true)} (metodología ${ev.review.methodVersion}).${ev.review.coversAll ? "" : " No cubre todos los workflows conversacionales actuales o usa otra metodología."}`}
                  </span>
                </div>
              </div>
              {!ev.enabled ? (
                <span className={s.note} style={{ paddingTop: 12, lineHeight: 1.5 }}>
                  {evidenceCopy(data).agencyHint}
                </span>
              ) : null}
            </div>
          ) : (
            <span className={s.note} style={{ paddingTop: 14, lineHeight: 1.5 }}>
              Tu agencia ve el detalle técnico de cada automatización.
            </span>
          )}
        </div>
      </aside>
    </>
  );
}

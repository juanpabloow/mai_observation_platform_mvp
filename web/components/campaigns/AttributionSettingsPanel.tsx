"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { PageShell } from "@/components/ui/PageShell";
import {
  setAttributionBriefWindowDaysAction,
  setAttributionTrackingStartedAtAction,
} from "@/lib/attributionActions";
import { setPipelineSettingsAction } from "@/lib/pipelineActions";

/**
 * Attribution settings (AT-2 §3) — agency only (the page + the actions both enforce it). Edits
 * the per-client tracking start and the AT-3 brief window, and shows the AT-1 health counters
 * (failed = in-memory per-process; pending = the DB backlog). Saving calls the two agency-only
 * actions; a single error surfaces the first failure.
 */

const INPUT =
  "h-[44px] lg:h-[36px] rounded-lg border border-line-strong bg-surface px-3 text-sm text-foreground outline-none transition focus:border-foreground";
const BTN =
  "inline-flex h-[44px] lg:h-[36px] items-center justify-center rounded-lg bg-foreground px-3.5 text-sm font-medium text-background transition hover:opacity-90 disabled:opacity-50";

export function AttributionSettingsPanel({
  clientId,
  clientName,
  trackingStartedAt,
  briefWindowDays,
  failedAttributions,
  pendingAttributions,
  autoLostAfterHours,
  reopenWindowDays,
  pipelineFailures,
}: {
  clientId: string;
  clientName: string;
  trackingStartedAt: string;
  briefWindowDays: number;
  failedAttributions: number;
  pendingAttributions: number;
  autoLostAfterHours: number;
  reopenWindowDays: number;
  pipelineFailures: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [tracking, setTracking] = useState(trackingStartedAt);
  const [brief, setBrief] = useState(String(briefWindowDays));
  const [autoLost, setAutoLost] = useState(String(autoLostAfterHours));
  const [reopen, setReopen] = useState(String(reopenWindowDays));

  const save = () => {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const t = await setAttributionTrackingStartedAtAction(clientId, tracking.trim() === "" ? null : tracking.trim());
      if (!t.ok) {
        setError(t.error ?? "No se pudo guardar.");
        return;
      }
      const b = await setAttributionBriefWindowDaysAction(clientId, Number(brief));
      if (!b.ok) {
        setError(b.error ?? "No se pudo guardar.");
        return;
      }
      const p = await setPipelineSettingsAction(clientId, { autoLostAfterHours: Number(autoLost), reopenWindowDays: Number(reopen) });
      if (!p.ok) {
        setError(p.error ?? "No se pudo guardar.");
        return;
      }
      setSaved(true);
      router.refresh();
    });
  };

  return (
    <div className="flex flex-col gap-[var(--content-pad)]">
      <PageShell grow={false} clip={false}>
        <div className="flex min-h-11 flex-wrap items-center gap-2.5 px-4 py-3 sm:px-5">
          <h1 className="text-xl font-semibold tracking-[-0.025em] text-foreground">Configuración de atribución</h1>
          <span className="truncate text-xs text-muted">{clientName}</span>
        </div>
      </PageShell>

      <PageShell grow={false} ariaLabel="Ajustes">
        <div className="flex flex-col gap-5 p-4 sm:p-5">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-foreground">Inicio del seguimiento</span>
            <span className="text-xs text-muted">
              Desde esta fecha, un primer mensaje sin referido cuenta como «orgánico». Antes de ella, la
              ausencia de un anuncio no prueba nada (el contacto queda «desconocido»). Vacío = sin iniciar.
            </span>
            <input type="date" value={tracking} onChange={(e) => setTracking(e.target.value)} className={`${INPUT} w-fit`} />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-foreground">Ventana del brief (días)</span>
            <span className="text-xs text-muted">
              Cuántos días aplica el brief de la campaña tras un contacto por anuncio. Entre 1 y 90.
            </span>
            <input
              type="number"
              min={1}
              max={90}
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              className={`${INPUT} w-28`}
            />
          </label>

          <div className="border-t border-line pt-5">
            <h2 className="text-sm font-semibold text-foreground">Pipeline de ventas</h2>
            <div className="mt-4 flex flex-col gap-5">
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium text-foreground">Auto-perder sin respuesta (horas)</span>
                <span className="text-xs text-muted">
                  Una oportunidad en Lead o Calificado donde el negocio respondió último y el cliente no
                  contesta en estas horas se marca perdida (no_respondio). Entre 1 y 2160.
                </span>
                <input type="number" min={1} max={2160} value={autoLost} onChange={(e) => setAutoLost(e.target.value)} className={`${INPUT} w-28`} />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium text-foreground">Ventana de reapertura (días)</span>
                <span className="text-xs text-muted">
                  Cuántos días tras perderse puede reabrirse una oportunidad (por un mensaje, una reserva o a
                  mano). Pasado ese plazo, una nueva conversación abre una oportunidad nueva. Entre 0 y 365.
                </span>
                <input type="number" min={0} max={365} value={reopen} onChange={(e) => setReopen(e.target.value)} className={`${INPUT} w-28`} />
              </label>
            </div>
          </div>

          {error ? (
            <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
              {error}
            </p>
          ) : null}
          {saved && !error ? <p className="text-sm text-success">Guardado.</p> : null}

          <div>
            <button type="button" className={BTN} disabled={pending} onClick={save}>
              Guardar cambios
            </button>
          </div>
        </div>
      </PageShell>

      <PageShell grow={false} ariaLabel="Salud de la atribución">
        <div className="flex flex-col gap-3 p-4 sm:p-5">
          <h2 className="text-[0.6875rem] font-semibold tracking-[0.06em] text-faint">SALUD DE LA ATRIBUCIÓN</h2>
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-xl border border-line bg-surface p-3">
              <p className="u-mono text-2xl font-semibold text-foreground">{pendingAttributions}</p>
              <p className="text-xs text-muted">Pendientes (backlog)</p>
              <p className="mt-1 text-[0.6875rem] text-faint">
                Mensajes con referido y contacto, aún sin registrar. El worker los drena cada 5 min.
              </p>
            </div>
            <div className="rounded-xl border border-line bg-surface p-3">
              <p className="u-mono text-2xl font-semibold text-foreground">{failedAttributions}</p>
              <p className="text-xs text-muted">Fallos</p>
              <p className="mt-1 text-[0.6875rem] text-faint">
                Fallos de atribución en vivo desde el último reinicio del proceso (señal aproximada).
              </p>
            </div>
            <div className="rounded-xl border border-line bg-surface p-3">
              <p className="u-mono text-2xl font-semibold text-foreground">{pipelineFailures}</p>
              <p className="text-xs text-muted">Fallos de pipeline</p>
              <p className="mt-1 text-[0.6875rem] text-faint">
                Errores de los hooks de pipeline (a prueba de fallos) desde el último reinicio. Los sana el barrido.
              </p>
            </div>
          </div>
        </div>
      </PageShell>
    </div>
  );
}

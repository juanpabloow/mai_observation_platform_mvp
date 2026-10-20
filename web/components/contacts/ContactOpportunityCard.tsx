import { formatStampFull, relativeAgeShort } from "@/lib/format";
import { LOST_REASON_LABEL, STAGE_LABEL, STATUS_LABEL } from "@/lib/pipelineBoard";
import type { LostReason, OpportunityStage, OpportunityStatus } from "@worker/db/repositories/pipeline.js";

/**
 * PL-2 §3 — the contact's SALES OPPORTUNITY card (current + past + the stage-event history with
 * actors). Read-only here; the moves live on the board. Shown on the crm-gated record (staff never
 * reach it). Reuses the pipeline vocabulary (STAGE_LABEL etc.) so the words never drift.
 */

export interface OppView {
  id: string;
  stage: OpportunityStage;
  status: OpportunityStatus;
  createdAt: string;
  leadAt: string | null;
  qualifiedAt: string | null;
  bookedAt: string | null;
  attendedAt: string | null;
  paidAt: string | null;
  closedAt: string | null;
  qualificationService: string | null;
  qualificationTimeframe: string | null;
  qualificationMessageId: string | null;
  qualifiedBy: string | null;
  qualifiedImplicitly: boolean;
  lostReason: LostReason | null;
  lostNote: string | null;
}

export interface ContactPipelineView {
  current: OppView | null;
  past: OppView[];
  events: Array<{
    fromStage: OpportunityStage | null;
    toStage: OpportunityStage | null;
    fromStatus: OpportunityStatus | null;
    toStatus: OpportunityStatus | null;
    actor: string;
    reason: string | null;
    at: string;
  }>;
  appointments: Array<{ id: string; at: string; status: string; service: string }>;
}

const APPT_STATUS: Record<string, string> = {
  scheduled: "Agendada",
  confirmed: "Confirmada",
  completed: "Completada",
  cancelled: "Cancelada",
  no_show: "No asistió",
};

function statusTone(status: OpportunityStatus): string {
  return status === "won" ? "bg-success/10 text-success" : status === "lost" ? "bg-warn-soft text-warn" : "bg-accent/10 text-accent";
}

function Stamp({ iso, label }: { iso: string | null; label: string }) {
  if (!iso) return null;
  return (
    <div className="flex items-center justify-between gap-2 text-[0.6875rem]">
      <span className="text-faint">{label}</span>
      <span className="text-muted" title={formatStampFull(new Date(iso))}>{relativeAgeShort(iso)}</span>
    </div>
  );
}

function OppBlock({ opp, current }: { opp: OppView; current: boolean }) {
  return (
    <div className={`flex flex-col gap-2 rounded-lg border p-2.5 ${current ? "border-line-strong" : "border-line bg-subtle/30"}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-chip px-2 py-0.5 text-[0.625rem] font-medium text-foreground">{STAGE_LABEL[opp.stage]}</span>
        <span className={`rounded-full px-2 py-0.5 text-[0.625rem] font-medium ${statusTone(opp.status)}`}>{STATUS_LABEL[opp.status]}</span>
        {opp.lostReason ? <span className="text-[0.625rem] text-warn">· {LOST_REASON_LABEL[opp.lostReason]}</span> : null}
      </div>
      <div className="flex flex-col gap-0.5">
        <Stamp iso={opp.leadAt} label="Lead" />
        <Stamp iso={opp.qualifiedAt} label="Calificado" />
        <Stamp iso={opp.bookedAt} label="Reservó" />
        <Stamp iso={opp.attendedAt} label="Asistió" />
        <Stamp iso={opp.paidAt} label="Pagó" />
      </div>
      {opp.lostNote ? <p className="text-[0.6875rem] text-muted">Nota: {opp.lostNote}</p> : null}
      {opp.qualificationService || opp.qualificationTimeframe ? (
        <div className="rounded-md bg-subtle/60 p-2 text-[0.6875rem] text-muted">
          <p className="font-medium text-foreground">Calificación</p>
          {opp.qualificationService ? <p>Servicio: {opp.qualificationService}</p> : null}
          {opp.qualificationTimeframe ? <p>Plazo: {opp.qualificationTimeframe}</p> : null}
          <p className="text-faint">
            {opp.qualifiedImplicitly ? "Calificado automáticamente al reservar" : `Calificado por ${opp.qualifiedBy ?? "—"}`}
          </p>
        </div>
      ) : null}
    </div>
  );
}

export function ContactOpportunityCard({ pipeline }: { pipeline: ContactPipelineView }) {
  const { current, past, events, appointments } = pipeline;
  if (!current && past.length === 0) return null;

  return (
    <section aria-label="Oportunidad" className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4">
      <h3 className="text-[0.6875rem] font-semibold uppercase tracking-wide text-faint">Oportunidad</h3>

      {current ? <OppBlock opp={current} current /> : <p className="text-xs text-muted">Sin oportunidad abierta.</p>}

      {current && appointments.length > 0 ? (
        <div className="flex flex-col gap-1">
          <p className="text-[0.6875rem] font-medium text-foreground">Citas</p>
          {appointments.map((a) => (
            <div key={a.id} className="flex items-center justify-between gap-2 text-[0.6875rem] text-muted">
              <span className="truncate">{a.service}</span>
              <span className="shrink-0 text-faint" title={formatStampFull(new Date(a.at))}>
                {APPT_STATUS[a.status] ?? a.status} · {relativeAgeShort(a.at)}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {events.length > 0 ? (
        <details className="group">
          <summary className="cursor-pointer text-[0.6875rem] font-medium text-muted hover:text-foreground">Historial ({events.length})</summary>
          <ol className="mt-1.5 flex flex-col gap-1">
            {events.map((e, i) => (
              <li key={i} className="flex items-start justify-between gap-2 text-[0.6875rem]">
                <span className="text-muted">
                  {e.fromStage && e.toStage && e.fromStage !== e.toStage
                    ? `${STAGE_LABEL[e.fromStage]} → ${STAGE_LABEL[e.toStage]}`
                    : e.toStatus === "lost"
                      ? "Perdida"
                      : e.toStatus === "won"
                        ? "Ganada"
                        : e.toStage
                          ? STAGE_LABEL[e.toStage]
                          : "Cambio"}
                  {e.reason ? <span className="text-faint"> · {e.reason}</span> : null}
                  <span className="text-faint"> · {e.actor}</span>
                </span>
                <span className="shrink-0 text-faint" title={formatStampFull(new Date(e.at))}>{relativeAgeShort(e.at)}</span>
              </li>
            ))}
          </ol>
        </details>
      ) : null}

      {past.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-[0.6875rem] font-medium text-foreground">Oportunidades anteriores ({past.length})</p>
          {past.map((o) => (
            <OppBlock key={o.id} opp={o} current={false} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

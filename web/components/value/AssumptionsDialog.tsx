"use client";

import { useState, useTransition } from "react";
import s from "./valueDashboard.module.css";
import { Chip, CloseIcon, cx } from "./bits";
import { buttonClass, FIELD } from "@/components/ui/controls";
import { useTrappedPanel } from "@/components/ui/Overlay";
import { confirmValueAssumptionsAction, proposeValueAssumptionsAction } from "@/lib/valueAssumptionActions";
import { fmtCOP, fmtDateTime, fmtDay, fmtHours, fmtN } from "@/lib/valueDashboardView";
import {
  ASSUMPTION_LIMITS,
  computeEstimate,
  isValidDay,
  pendingProposal,
  type AssumptionVersion,
  type ValueDashboardData,
} from "@worker/analytics/valueDashboardModel.js";

/**
 * «Supuestos de la estimación». The agency proposes; ONLY the business owner confirms (the
 * server actions re-check both). Starts from the pending proposal, else the latest
 * confirmed version, else EMPTY — there are no defaults to mistake for confirmed values.
 * The effective date is an explicit choice; a date in the past says, before confirming,
 * that it will reach those days.
 */

type Draft = { m1: string; m2: string; m3: string; cost: string; from: string };

const toDraft = (v: AssumptionVersion | null, today: string): Draft =>
  v
    ? { m1: String(v.minConversacionAtendida), m2: String(v.minConversacionConCita), m3: String(v.minAgendarManual), cost: String(v.costoHora), from: v.effectiveFrom }
    : { m1: "", m2: "", m3: "", cost: "", from: today };

const intOrNull = (x: string, max: number): number | null => {
  if (!/^\d+$/.test(x)) return null;
  const n = Number(x);
  return n <= max ? n : null;
};

export function AssumptionsDialog({
  clientId,
  data,
  today,
  onClose,
  onSaved,
}: {
  clientId: string;
  data: ValueDashboardData;
  today: string;
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const versions = data.assumptions.versions;
  const pending = pendingProposal(versions);
  const latestConfirmed =
    versions.filter((v) => v.status === "confirmed").sort((a, b) => ((a.confirmedAt ?? "") < (b.confirmedAt ?? "") ? 1 : -1))[0] ?? null;
  const source = pending ?? latestConfirmed;
  const [draft, setDraft] = useState<Draft>(() => toDraft(source, today));
  const [fromMode, setFromMode] = useState<"today" | "period" | "other">(() =>
    !source || source.effectiveFrom === today ? "today" : source.effectiveFrom === data.period.fromDay ? "period" : "other",
  );
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, startTransition] = useTransition();
  const ref = useTrappedPanel({ active: true, onClose });

  const enabled = data.evidence.enabled;
  const m1 = intOrNull(draft.m1, ASSUMPTION_LIMITS.minutesMax);
  const m2 = intOrNull(draft.m2, ASSUMPTION_LIMITS.minutesMax);
  const m3 = intOrNull(draft.m3, ASSUMPTION_LIMITS.minutesMax);
  const cost = intOrNull(draft.cost, ASSUMPTION_LIMITS.costMax);
  const from = fromMode === "today" ? today : fromMode === "period" ? data.period.fromDay : draft.from;
  const complete = m1 !== null && m2 !== null && m3 !== null && cost !== null && isValidDay(from);
  const values = complete ? { minConversacionAtendida: m1!, minConversacionConCita: m2!, minAgendarManual: m3!, costoHora: cost!, effectiveFrom: from } : null;
  const unchangedFromPending =
    !!pending &&
    !!values &&
    pending.minConversacionAtendida === values.minConversacionAtendida &&
    pending.minConversacionConCita === values.minConversacionConCita &&
    pending.minAgendarManual === values.minAgendarManual &&
    pending.costoHora === values.costoHora &&
    pending.effectiveFrom === values.effectiveFrom;

  const preview = values
    ? computeEstimate(
        data.units,
        [{ ...values, id: "preview", status: "confirmed", methodVersion: "v1", proposedBy: null, proposedAt: "", confirmedBy: null, confirmedAt: "9999", basedOnId: null }],
        enabled,
      )
    : null;
  const u = data.units.reduce((a, d) => ({ u1: a.u1 + (d.u1 ?? 0), u2: a.u2 + (d.u2 ?? 0), u3: a.u3 + d.u3 }), { u1: 0, u2: 0, u3: 0 });

  const status = pending ? { tone: "warn" as const, text: "Propuesto · sin confirmar" } : latestConfirmed ? { tone: "ok" as const, text: "Confirmado por el negocio" } : { tone: "info" as const, text: "Sin configurar" };
  const people = data.assumptions.people;
  const who = (id: string | null) => (id ? (people[id] ?? "Usuario") : "—");

  function save(kind: "propose" | "confirm") {
    if (!values) return;
    setError(null);
    startTransition(async () => {
      const input = { ...values, proposalId: kind === "confirm" && unchangedFromPending ? pending!.id : null };
      const r = kind === "propose" ? await proposeValueAssumptionsAction(clientId, input) : await confirmValueAssumptionsAction(clientId, input);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      onSaved(kind === "propose" ? "Propuesta guardada · pendiente de confirmar" : "Supuestos confirmados por el negocio");
    });
  }

  const fields: Array<{ key: "m1" | "m2" | "m3"; label: string; help: string; basis: string; disabledNote?: string }> = [
    {
      key: "m1",
      label: "Minutos de atención manual por conversación",
      help: "Conversación que el bot respondió sin intervención y que no terminó en reserva.",
      basis: enabled ? `× ${fmtN(u.u1)} conv.` : "Sin evidencia: aún no se aplica",
    },
    {
      key: "m2",
      label: "Minutos por conversación que termina en reserva",
      help: "Incluye responder y agendar la cita a mano.",
      basis: enabled ? `× ${fmtN(u.u2)} conv.` : "Sin evidencia: aún no se aplica",
    },
    { key: "m3", label: "Minutos por reserva en la página pública", help: "Tiempo de tomar la reserva por teléfono o chat.", basis: `× ${fmtN(u.u3)} reservas` },
  ];

  return (
    <>
      <button type="button" aria-label="Cerrar supuestos" tabIndex={-1} className={s.scrim} onClick={onClose} />
      <aside ref={ref} role="dialog" aria-modal="true" aria-labelledby="vd-as" className={s.dialog}>
        <div className={s.dialogHead}>
          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
            <h2 id="vd-as" style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
              Supuestos de la estimación
            </h2>
            <span className={s.note}>Definen cómo calculamos el tiempo liberado.</span>
          </div>
          <button type="button" aria-label="Cerrar supuestos" onClick={onClose} className={buttonClass({ variant: "tertiary", className: "!w-[44px] !px-0" })}>
            <CloseIcon />
          </button>
        </div>
        <div className={s.dialogBody}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span className={s.secondary} style={{ fontSize: 13 }}>
              Estado
            </span>
            <Chip tone={status.tone}>{status.text}</Chip>
            {pending ? (
              <span className={s.note}>
                Propuesto por {who(pending.proposedBy)} el {fmtDateTime(pending.proposedAt, data.tz)}
              </span>
            ) : null}
          </div>
          {fields.map((f) => {
            const n = intOrNull(draft[f.key], ASSUMPTION_LIMITS.minutesMax);
            const id = `vd-f-${f.key}`;
            return (
              <div key={f.key} className={s.field}>
                <label htmlFor={id} style={{ fontSize: 14, fontWeight: 590, lineHeight: 1.35 }}>
                  {f.label}
                </label>
                <span className={s.note} style={{ lineHeight: 1.45 }}>
                  {f.help}
                </span>
                <div className={s.stepper}>
                  <button
                    type="button"
                    className={cx(s.stepBtn, "u-focus")}
                    aria-label={`Restar un minuto: ${f.label}`}
                    disabled={n === null || n <= 0}
                    onClick={() => setDraft((d) => ({ ...d, [f.key]: String(Math.max(0, (n ?? 0) - 1)) }))}
                  >
                    −
                  </button>
                  <input
                    id={id}
                    inputMode="numeric"
                    className={cx(s.stepInput, "u-focus")}
                    value={draft[f.key]}
                    placeholder="—"
                    aria-describedby={`${id}-u`}
                    aria-invalid={draft[f.key] !== "" && n === null}
                    onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value.replace(/\D/g, "").slice(0, 3) }))}
                  />
                  <button
                    type="button"
                    className={cx(s.stepBtn, "u-focus")}
                    aria-label={`Sumar un minuto: ${f.label}`}
                    disabled={n !== null && n >= ASSUMPTION_LIMITS.minutesMax}
                    onClick={() => setDraft((d) => ({ ...d, [f.key]: String(Math.min(ASSUMPTION_LIMITS.minutesMax, (n ?? 0) + 1)) }))}
                  >
                    +
                  </button>
                  <span id={`${id}-u`} className={s.note}>
                    min · {f.basis}
                  </span>
                </div>
              </div>
            );
          })}
          <div className={s.field}>
            <label htmlFor="vd-cost" style={{ fontSize: 14, fontWeight: 590 }}>
              Costo por hora del equipo
            </label>
            <span className={s.note} style={{ lineHeight: 1.45 }}>
              Valor de referencia de una hora de recepción o atención, en pesos colombianos.
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 6, maxWidth: 240 }}>
              <span className={s.tertiary} style={{ fontSize: 16 }}>
                $
              </span>
              <input
                id="vd-cost"
                inputMode="numeric"
                placeholder="—"
                className={cx(FIELD, "h-[44px]")}
                value={draft.cost === "" ? "" : fmtN(Number(draft.cost))}
                aria-invalid={draft.cost !== "" && cost === null}
                onChange={(e) => setDraft((d) => ({ ...d, cost: e.target.value.replace(/\D/g, "").slice(0, 9) }))}
              />
              <span className={s.tertiary} style={{ fontSize: 13, whiteSpace: "nowrap" }}>
                / hora
              </span>
            </span>
          </div>
          <div className={s.field}>
            <span id="vd-from" style={{ fontSize: 14, fontWeight: 590 }}>
              Aplican desde
            </span>
            <div role="radiogroup" aria-labelledby="vd-from" style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {(
                [
                  ["today", `Hoy · ${fmtDay(today)}`],
                  ...(data.period.fromDay < today ? ([["period", `Inicio del periodo · ${fmtDay(data.period.fromDay)}`]] as const) : []),
                  ["other", "Otra fecha"],
                ] as Array<[typeof fromMode, string]>
              ).map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  role="radio"
                  aria-checked={fromMode === k}
                  onClick={() => setFromMode(k)}
                  className={buttonClass({ variant: fromMode === k ? "primary" : "secondary", size: "sm" })}
                >
                  {label}
                </button>
              ))}
            </div>
            {fromMode === "other" ? (
              <input
                type="date"
                aria-label="Fecha desde la que aplican"
                className={cx(FIELD, "h-[44px]")}
                style={{ maxWidth: 220 }}
                value={draft.from}
                onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))}
              />
            ) : null}
            <span className={s.note} style={{ lineHeight: 1.45 }} aria-live="polite">
              {!isValidDay(from)
                ? "Elige una fecha."
                : from < today
                  ? `Se aplicará también a los días pasados desde el ${fmtDay(from, true)}. Antes de esa fecha nada cambia.`
                  : from === today
                    ? "Se aplica desde hoy: los días anteriores no se recalculan."
                    : `Empieza el ${fmtDay(from, true)}: hasta entonces no se estima tiempo con estos valores.`}
            </span>
          </div>
          <div className={s.preview}>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--vd-est)" }}>Con estos supuestos · vista previa, sin guardar</span>
            <span style={{ fontSize: 20, fontWeight: 600 }} aria-live="polite">
              {!preview
                ? "Completa los supuestos para ver la estimación"
                : preview.state !== "confirmed"
                  ? "No aplica a este periodo"
                  : `${fmtHours(preview.minutes ?? 0)} ≈ ${fmtCOP(preview.value ?? 0)}`}
            </span>
            <span className={s.secondary} style={{ fontSize: 12.5, lineHeight: 1.5 }}>
              {enabled
                ? `(${fmtN(u.u1)} × ${draft.m1 || "?"}) + (${fmtN(u.u2)} × ${draft.m2 || "?"}) + (${fmtN(u.u3)} × ${draft.m3 || "?"}) minutos, por ${cost !== null ? fmtCOP(cost) : "$?"} la hora.`
                : `${fmtN(u.u3)} reservas de la página × ${draft.m3 || "?"} minutos, por ${cost !== null ? fmtCOP(cost) : "$?"} la hora. Estimación parcial: las conversaciones se suman cuando haya evidencia del registro de mensajes.`}{" "}
              Solo cuentan los días desde la fecha de inicio.
            </span>
          </div>
          <span className={s.note} style={{ lineHeight: 1.5 }}>
            La agencia puede proponer supuestos; solo el dueño del negocio los confirma. Hasta entonces el dashboard no muestra un tiempo liberado. Cada cambio queda en el
            historial.
          </span>
          {versions.length > 0 ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span className={s.overline}>HISTORIAL</span>
              <div className={s.history}>
                {versions.slice(0, 12).map((v) => (
                  <div key={v.id} className={s.historyRow}>
                    <span style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      <Chip tone={v.status === "confirmed" ? "ok" : "warn"}>{v.status === "confirmed" ? "Confirmado" : "Propuesto"}</Chip>
                      <span className={s.secondary}>
                        {v.status === "confirmed"
                          ? `por ${who(v.confirmedBy)} el ${fmtDateTime(v.confirmedAt!, data.tz)}`
                          : `por ${who(v.proposedBy)} el ${fmtDateTime(v.proposedAt, data.tz)}`}
                      </span>
                    </span>
                    <span className={s.tertiary}>
                      Desde el {fmtDay(v.effectiveFrom, true)} · {v.minConversacionAtendida} / {v.minConversacionConCita} / {v.minAgendarManual} min · {fmtCOP(v.costoHora)}/h
                      {v.status === "confirmed" && v.basedOnId ? ` · propuesta de ${who(v.proposedBy)}` : ""}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {error ? (
            <span role="alert" style={{ color: "var(--danger)", fontSize: 13.5 }}>
              {error}
            </span>
          ) : null}
        </div>
        <div className={s.dialogFoot}>
          {data.canPropose ? (
            <button
              type="button"
              disabled={!complete || pendingAction}
              onClick={() => save("propose")}
              className={buttonClass({ variant: data.canConfirm ? "secondary" : "primary" })}
            >
              Guardar como propuesta
            </button>
          ) : null}
          {data.canConfirm ? (
            <button type="button" disabled={!complete || pendingAction} onClick={() => save("confirm")} className={buttonClass({ variant: "primary" })}>
              Confirmar supuestos
            </button>
          ) : (
            <span className={s.note} style={{ alignSelf: "center", flexBasis: "100%", textAlign: "right" }}>
              Solo el dueño del negocio puede confirmar.
            </span>
          )}
        </div>
      </aside>
    </>
  );
}

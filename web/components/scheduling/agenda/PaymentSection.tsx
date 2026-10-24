"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { getAppointmentPaymentHistoryAction, voidPaymentAction, type PaymentDTO } from "@/lib/paymentActions";
import { ADJUSTMENT_LABEL, type AdjustmentReason } from "@/lib/chargeDraft";
import { priceLabelCOP } from "@/lib/money";
import type { Appt } from "../AgendaView";
import { stamp } from "./AppointmentCard";

type History = Array<PaymentDTO & { methodLabel: string; recordedByMe: boolean }>;

/** What the card needs from the agenda to show and act on the «Cobro» (payments.view only). */
export interface PaymentHooks {
  clientId: string;
  canRecord: boolean;
  canVoid: boolean;
  onRecord: () => void;
  onChanged: (message: string) => void;
}

/**
 * PY-2 «Cobro» inside the appointment card (card language 5a), desktop and phone. Shown only to
 * payments.view — the agenda page does not even load payment states without it, and the
 * actions re-check permission AND reach. Appointment and payment are independent: two chips,
 * «Completada» (the state) and «Cobro pendiente / registrado» (here).
 *
 *   not completed → one line: the charge is recorded when the appointment is completed
 *                   (cancelled / no-show: there is no charge).
 *   recorded      → the lines with aligned amounts, the total, «Método · registrado por ti
 *                   (or «por el equipo») · fecha»; «Anular registro» with a required reason
 *                   (payments.void) — voiding does NOT give money back to the client.
 *   pending       → «Cobro pendiente» + the amber «Sin cobro registrado». The action is the
 *                   card's footer primary «Registrar cobro» (payments.record).
 *   history       → voided records stay visible (who/when/why), never deleted.
 * Completed history from before payments started being tracked is not «pendiente»: it reads
 * «Sin cobro registrado» without the chip, and can still be recorded.
 */
export function CobroSection(props: { appt: Appt; timezone: string; hooks: PaymentHooks }) {
  const { appt } = props;
  const note =
    appt.status === "cancelled" ? "Cita cancelada: no hay cobro." : appt.status === "no_show" ? "Inasistencia: no hay cobro." : appt.status === "completed" ? null : "El cobro se registra cuando la cita se completa.";
  if (note) {
    return (
      <section aria-labelledby="appt-sec-cobro" className="c5-sec">
        <h3 id="appt-sec-cobro" className="c5-cap">
          Cobro
        </h3>
        <p className="c5-small text-[var(--c5-sec)]">{note}</p>
      </section>
    );
  }
  return <PaymentSection {...props} />;
}

function PaymentSection(props: { appt: Appt; timezone: string; hooks: PaymentHooks }) {
  const { appt, hooks } = props;
  const [state, setState] = useState<{ state: "loading" } | { state: "error"; error: string } | { state: "ready"; history: History }>({ state: "loading" });
  const [voiding, setVoiding] = useState<{ id: string; reason: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const sending = useRef(false);

  // Loads on open and reloads when the appointment's payment state changes (a record or a void
  // elsewhere). A reload keeps what is on screen until the answer arrives — no flicker on the
  // background refresh; only the first load shows «Cargando».
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    getAppointmentPaymentHistoryAction(hooks.clientId, appt.id)
      .then((r) => alive && setState(r.ok ? { state: "ready", history: r.value } : { state: "error", error: r.error }))
      .catch(() => alive && setState({ state: "error", error: "No pudimos cargar el cobro." }));
    return () => {
      alive = false;
    };
  }, [hooks.clientId, appt.id, appt.payment_state, tick]);
  const load = () => setTick((n) => n + 1);

  const recorded = state.state === "ready" ? state.history.find((p) => p.status === "recorded") ?? null : null;
  const voided = state.state === "ready" ? state.history.filter((p) => p.status === "voided") : [];
  const pendingChip = state.state === "ready" && !recorded && appt.payment_state === "pending";

  const doVoid = () => {
    if (!voiding || sending.current) return;
    if (!voiding.reason.trim()) return setError("Escribe el motivo para anular el registro.");
    sending.current = true;
    setError(null);
    startTransition(async () => {
      try {
        const r = await voidPaymentAction(hooks.clientId, voiding.id, voiding.reason.trim());
        if (!r.ok) setError(r.error);
        else {
          setVoiding(null);
          load();
          hooks.onChanged("Registro de cobro anulado");
        }
      } catch {
        setError("No se pudo anular: revisa la conexión. Nada cambió.");
      } finally {
        sending.current = false;
      }
    });
  };

  return (
    <section aria-labelledby="appt-sec-cobro" className="c5-sec">
      <div className="flex items-center pb-0.5">
        <h3 id="appt-sec-cobro" className="c5-cap flex-1">
          Cobro
        </h3>
        {recorded ? <span className="c5-chip c5-ok">Cobro registrado</span> : pendingChip ? <span className="c5-chip c5-amber">Cobro pendiente</span> : null}
      </div>
      {error ? (
        <div role="alert" className="c5-box c5-red">
          {error}
        </div>
      ) : null}
      {state.state === "loading" ? (
        <p role="status" className="c5-small flex items-center gap-2 text-[var(--c5-sec)]">
          <span aria-hidden className="u-ag-busy-dot size-[7px] rounded-full bg-current" />
          Cargando el cobro…
        </p>
      ) : state.state === "error" ? (
        <p className="c5-small flex items-center gap-3">
          <span className="text-[var(--c5-red-fg)]">{state.error}</span>
          <button type="button" className="u-focus c5-link" onClick={load}>
            Reintentar
          </button>
        </p>
      ) : recorded ? (
        <>
          <dl className="flex flex-col gap-1.5">
            {[...recorded.lines]
              .sort((x, y) => (x.kind === y.kind ? 0 : x.kind === "service" ? -1 : 1))
              .map((l, i) => (
                <div key={i} className="c5-text c5-num flex items-baseline justify-between gap-3">
                  <dt className="min-w-0 text-[var(--c5-tx2)]">
                    <span className="block truncate">
                      {l.description}
                      {l.quantity > 1 ? ` × ${l.quantity}` : ""}
                    </span>
                    {l.adjustmentReason ? (
                      <span className="block text-[12px] text-[var(--c5-sec)]">
                        {ADJUSTMENT_LABEL[l.adjustmentReason as AdjustmentReason] ?? l.adjustmentReason}
                        {l.adjustmentNote ? `: ${l.adjustmentNote}` : ""}
                        {l.unitListPrice ? ` · lista ${priceLabelCOP(l.unitListPrice)}` : ""}
                      </span>
                    ) : null}
                  </dt>
                  <dd className="shrink-0">{priceLabelCOP(l.lineTotal)}</dd>
                </div>
              ))}
            <div className="c5-num flex items-baseline justify-between gap-3 border-t border-[var(--c5-bd)] pt-1.5 text-[16px] font-[590]">
              <dt>Total</dt>
              <dd>{priceLabelCOP(recorded.total)}</dd>
            </div>
          </dl>
          <span className="c5-note">
            {recorded.methodLabel} · registrado {recorded.recordedByMe ? "por ti" : "por el equipo"} · {stamp(recorded.paidAt, props.timezone)}
            {recorded.note ? ` · ${recorded.note}` : ""}
          </span>
          {hooks.canVoid ? (
            voiding?.id === recorded.id ? (
              <div role="group" aria-label="Anular registro" className="c5-box c5-red mt-1 gap-2.5">
                <span className="text-[13px] leading-[1.45]">
                  <span className="font-[590]">Anular el registro no devuelve dinero al cliente.</span> Solo corrige lo anotado: la cita sigue completada, vuelve a «Cobro pendiente» y el registro anulado queda en el historial.
                </span>
                <textarea
                  autoFocus
                  className="u-focus c5-field resize-none bg-[var(--c5-bg)] text-[15px]"
                  rows={2}
                  maxLength={500}
                  value={voiding.reason}
                  onChange={(e) => setVoiding({ ...voiding, reason: e.target.value })}
                  aria-label="Motivo de la anulación"
                  placeholder="Motivo (obligatorio)"
                />
                <div className="flex justify-end gap-2">
                  <button type="button" data-size="sm" className="u-focus c5-btn" onClick={() => setVoiding(null)} disabled={pending}>
                    Volver
                  </button>
                  <button type="button" data-size="sm" data-kind="danger" aria-busy={pending || undefined} className="u-focus c5-btn" onClick={doVoid} disabled={!voiding.reason.trim() && !pending}>
                    {pending ? "Anulando…" : "Anular registro"}
                  </button>
                </div>
              </div>
            ) : (
              <div>
                <button type="button" className="u-focus c5-link" onClick={() => setVoiding({ id: recorded.id, reason: "" })}>
                  Anular registro
                </button>
              </div>
            )
          ) : null}
        </>
      ) : (
        <div className={`c5-box ${appt.payment_state === "pending" ? "c5-amber" : ""}`}>
          <span className="text-[14px] font-[590]">Sin cobro registrado</span>
          <span className="text-[12px]">
            {appt.payment_state === "pending"
              ? `La cita está completada; el cobro se puede registrar ahora o después.${hooks.canRecord ? "" : " Registrarlo requiere el permiso de cobros."}`
              : "Cita anterior al inicio del seguimiento de cobros."}
          </span>
        </div>
      )}
      {voided.length > 0 ? (
        <details className="mt-1 rounded-[12px] border border-[var(--c5-bd)]">
          <summary className="u-focus flex min-h-[40px] cursor-pointer list-none items-center px-3 text-[13px] text-[var(--c5-sec)]">
            {voided.length === 1 ? "1 registro anulado" : `${voided.length} registros anulados`}
          </summary>
          <ul className="flex flex-col border-t border-[var(--c5-bd)]">
            {voided.map((p) => (
              <li key={p.id} className="flex flex-col gap-0.5 px-3 py-2 text-[13px]">
                <span className="c5-num text-[var(--c5-sec)] line-through">
                  {priceLabelCOP(p.total)} · {p.methodLabel}
                </span>
                <span>Motivo: {p.voidReason}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { getAppointmentPaymentHistoryAction, voidPaymentAction, type PaymentDTO } from "@/lib/paymentActions";
import { ADJUSTMENT_LABEL, type AdjustmentReason } from "@/lib/chargeDraft";
import { priceLabelCOP } from "@/lib/money";
import { fmtTime } from "@/lib/siteCalendar";
import type { Appt } from "../AgendaView";
import { Alert, Button, TEXTAREA } from "../ui/system";

type History = Array<PaymentDTO & { methodLabel: string }>;

/**
 * PY-2 «Cobro» of a COMPLETED appointment, inside its detail (desktop panel and phone sheet).
 * Shown only to payments.view; nothing here is sent to anyone else — the agenda page does not
 * even load payment states without it, and the actions re-check permission AND reach.
 *
 *   recorded → total, method, the lines (and the discount reasons); «Anular registro» with a
 *              required reason (payments.void) — voiding does NOT give money back to the client,
 *              it only corrects what was noted, and the appointment returns to «Cobro pendiente».
 *   pending  → «Cobro pendiente» and «Registrar cobro» (payments.record).
 *   history  → voided records stay visible (who/when/why), never deleted.
 * Completed history from before payments started being tracked is not «pendiente»: it reads
 * «Sin cobro registrado», and can still be recorded.
 */
export function PaymentSection(props: {
  clientId: string;
  appt: Appt;
  timezone: string;
  canRecord: boolean;
  canVoid: boolean;
  onRecord: () => void;
  onChanged: (message: string) => void;
  /** Phone sheet styling. */
  compact?: boolean;
}) {
  const { appt } = props;
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
    getAppointmentPaymentHistoryAction(props.clientId, appt.id)
      .then((r) => alive && setState(r.ok ? { state: "ready", history: r.value } : { state: "error", error: r.error }))
      .catch(() => alive && setState({ state: "error", error: "No pudimos cargar el cobro." }));
    return () => {
      alive = false;
    };
  }, [props.clientId, appt.id, appt.payment_state, tick]);
  const load = () => setTick((n) => n + 1);

  const recorded = state.state === "ready" ? state.history.find((p) => p.status === "recorded") ?? null : null;
  const voided = state.state === "ready" ? state.history.filter((p) => p.status === "voided") : [];

  const doVoid = () => {
    if (!voiding || sending.current) return;
    if (!voiding.reason.trim()) return setError("Escribe el motivo para anular el registro.");
    sending.current = true;
    setError(null);
    startTransition(async () => {
      try {
        const r = await voidPaymentAction(props.clientId, voiding.id, voiding.reason.trim());
        if (!r.ok) setError(r.error);
        else {
          setVoiding(null);
          load();
          props.onChanged("Registro de cobro anulado");
        }
      } catch {
        setError("No se pudo anular: revisa la conexión. Nada cambió.");
      } finally {
        sending.current = false;
      }
    });
  };

  const text = props.compact ? "text-[15px]" : "text-[13.5px]";
  return (
    <section aria-labelledby="appt-payment" className="flex flex-col gap-2 py-3">
      <div className="flex items-center gap-2">
        <h3 id="appt-payment" className={props.compact ? "text-[16px] font-semibold" : "text-[15px] font-medium"}>
          Cobro
        </h3>
        {state.state === "ready" && !recorded && appt.payment_state === "pending" ? (
          <span className="rounded-[6px] bg-[var(--warn-soft)] px-1.5 text-[12px] font-medium leading-[20px] text-[var(--warn)]">Cobro pendiente</span>
        ) : null}
      </div>
      {error ? <Alert>{error}</Alert> : null}
      {state.state === "loading" ? (
        <p role="status" className={`flex items-center gap-2 ${text} text-muted`}>
          <span aria-hidden className="u-ag-busy-dot size-[7px] rounded-full bg-[var(--ag-ink2,currentColor)]" />
          Cargando el cobro…
        </p>
      ) : state.state === "error" ? (
        <div className={`flex items-center gap-3 ${text} text-muted`}>
          {state.error}
          <Button size="sm" onClick={load}>Reintentar</Button>
        </div>
      ) : recorded ? (
        <div className="flex flex-col gap-2">
          <dl className={`flex flex-col ${text}`}>
            {[...recorded.lines].sort((x, y) => (x.kind === y.kind ? 0 : x.kind === "service" ? -1 : 1)).map((l, i) => (
              <div key={i} className="flex items-baseline justify-between gap-3 py-1.5 shadow-[inset_0_-1px_0_var(--line-soft)]">
                <dt className="min-w-0">
                  <span className="block truncate">
                    {l.description}
                    {l.quantity > 1 ? ` × ${l.quantity}` : ""}
                  </span>
                  {l.adjustmentReason ? (
                    <span className="block text-[12.5px] text-muted">
                      {ADJUSTMENT_LABEL[l.adjustmentReason as AdjustmentReason] ?? l.adjustmentReason}
                      {l.adjustmentNote ? `: ${l.adjustmentNote}` : ""}
                      {l.unitListPrice ? ` · precio ${priceLabelCOP(l.unitListPrice)}` : ""}
                    </span>
                  ) : null}
                </dt>
                <dd className="shrink-0 tabular-nums">{priceLabelCOP(l.lineTotal)}</dd>
              </div>
            ))}
            <div className="flex items-baseline justify-between gap-3 pt-2 font-medium">
              <dt>
                Total · {recorded.methodLabel}
              </dt>
              <dd className="tabular-nums">{priceLabelCOP(recorded.total)}</dd>
            </div>
          </dl>
          <p className="text-[12.5px] text-muted">
            Registrado el {fmtDay(recorded.paidAt, props.timezone)}
            {recorded.note ? ` · ${recorded.note}` : ""}
          </p>
          {props.canVoid ? (
            voiding?.id === recorded.id ? (
              <div className="flex flex-col gap-2 rounded-[10px] border border-[var(--line)] p-3">
                <p className="text-[13px] leading-[1.45]">
                  <span className="font-medium">Anular el registro no devuelve dinero al cliente.</span> Solo corrige lo anotado: la cita sigue completada, vuelve a «Cobro pendiente» y el registro anulado queda en el historial.
                </p>
                <textarea className={TEXTAREA} rows={2} maxLength={500} value={voiding.reason} onChange={(e) => setVoiding({ ...voiding, reason: e.target.value })} aria-label="Motivo de la anulación" placeholder="Motivo (obligatorio)" />
                <div className="flex justify-end gap-2">
                  <Button onClick={() => setVoiding(null)} disabled={pending}>
                    Volver
                  </Button>
                  <Button variant="destructive" onClick={doVoid} loading={pending} loadingLabel="Anulando…" disabled={!voiding.reason.trim()}>
                    Anular registro
                  </Button>
                </div>
              </div>
            ) : (
              <div>
                <Button variant="tertiary" size="sm" onClick={() => setVoiding({ id: recorded.id, reason: "" })}>
                  Anular registro
                </Button>
              </div>
            )
          ) : null}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <p className={`${text} text-muted`}>
            {appt.payment_state === "pending" ? "La cita está completada y aún no tiene un cobro registrado." : "Sin cobro registrado."}
          </p>
          {props.canRecord ? (
            <div>
              <Button variant={appt.payment_state === "pending" ? "primary" : "secondary"} onClick={props.onRecord}>
                Registrar cobro
              </Button>
            </div>
          ) : null}
        </div>
      )}
      {voided.length > 0 ? (
        <details className="rounded-[10px] border border-[var(--line)]">
          <summary className="u-focus flex min-h-[40px] cursor-pointer list-none items-center px-3 text-[13px] text-muted">
            {voided.length === 1 ? "1 registro anulado" : `${voided.length} registros anulados`}
          </summary>
          <ul className="flex flex-col border-t border-[var(--line-soft)]">
            {voided.map((p) => (
              <li key={p.id} className="flex flex-col gap-0.5 px-3 py-2 text-[13px]">
                <span className="tabular-nums text-muted line-through">
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

function fmtDay(iso: string, tz: string): string {
  const d = new Intl.DateTimeFormat("es-CO", { day: "numeric", month: "short", timeZone: tz }).format(new Date(iso)).replace(".", "");
  return `${d} a las ${fmtTime(iso, tz)}`;
}

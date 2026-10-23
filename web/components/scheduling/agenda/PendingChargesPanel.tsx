"use client";

import { useEffect, useState } from "react";
import { listPendingPaymentsAction, type PendingPaymentDTO } from "@/lib/paymentActions";
import { priceLabelCOP } from "@/lib/money";
import { fmtTime, siteDayKey } from "@/lib/siteCalendar";
import { Button } from "../ui/system";
import { SidePanel } from "./SidePanel";

/**
 * PY-2 «Cobros pendientes» — the completed appointments (since payments started being
 * tracked) with no recorded charge, newest first, within this login's reach (the server
 * filters by site and professional). A way IN to each appointment, where «Registrar cobro»
 * lives — not a point of sale. History before tracking started never appears here.
 */
export function PendingChargesPanel(props: { clientId: string; timezone: string; onOpen: (item: { appointmentId: string; dayKey: string }) => void; onClose: () => void }) {
  const [state, setState] = useState<{ state: "loading" } | { state: "error"; error: string } | { state: "ready"; items: PendingPaymentDTO[] }>({ state: "loading" });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    listPendingPaymentsAction(props.clientId)
      .then((r) => alive && setState(r.ok ? { state: "ready", items: r.items } : { state: "error", error: r.error }))
      .catch(() => alive && setState({ state: "error", error: "No pudimos cargar los cobros pendientes." }));
    return () => {
      alive = false;
    };
  }, [props.clientId, tick]);
  const load = () => {
    setState({ state: "loading" });
    setTick((n) => n + 1);
  };
  const tz = props.timezone;
  return (
    <SidePanel
      name="pending-charges"
      title="Cobros pendientes"
      subtitle={state.state === "ready" ? (state.items.length === 1 ? "1 cita completada sin cobro registrado" : `${state.items.length} citas completadas sin cobro registrado`) : "Citas completadas sin cobro registrado"}
      onClose={props.onClose}
    >
      <div className="flex flex-col gap-3">
        <p className="text-[12.5px] leading-[1.45] text-muted">Completada no significa cobrada. Abre la cita y usa «Registrar cobro». Las citas anteriores al inicio del seguimiento de pagos no aparecen.</p>
        {state.state === "loading" ? (
          <p role="status" className="flex items-center gap-2 text-[13px] text-muted">
            <span aria-hidden className="u-ag-busy-dot size-[7px] rounded-full bg-[var(--ag-ink2)]" />
            Cargando cobros pendientes…
          </p>
        ) : state.state === "error" ? (
          <div className="flex items-center gap-3 text-[13px] text-muted">
            {state.error}
            <Button size="sm" onClick={load}>Reintentar</Button>
          </div>
        ) : state.items.length === 0 ? (
          <p role="status" className="rounded-[10px] bg-[var(--chip)] px-3 py-3 text-[13px] text-[var(--ag-ink2)]">No hay cobros pendientes.</p>
        ) : (
          <ul className="flex flex-col">
            {state.items.map((it) => {
              const day = siteDayKey(it.startAt, tz);
              return (
                <li key={it.appointmentId}>
                  <button
                    type="button"
                    onClick={() => props.onOpen({ appointmentId: it.appointmentId, dayKey: day })}
                    className="u-focus flex min-h-[56px] w-full items-center gap-3 rounded-[10px] px-2 py-2 text-left hover:bg-[var(--subtle)]"
                  >
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-[14px]">{it.contactName ?? "Sin contacto"}</span>
                      <span className="truncate text-[12.5px] text-muted">
                        {new Intl.DateTimeFormat("es-CO", { weekday: "short", day: "numeric", month: "short", timeZone: tz }).format(new Date(it.startAt)).replace(/\./g, "")} · {fmtTime(it.startAt, tz)} · {it.serviceName}
                        {it.staffName ? ` · ${it.staffName}` : ""}
                      </span>
                    </span>
                    <span className="shrink-0 text-[13px] tabular-nums text-muted">{it.priceSnapshot == null ? "Sin precio" : priceLabelCOP(it.priceSnapshot)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </SidePanel>
  );
}

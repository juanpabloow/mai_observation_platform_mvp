"use client";

import { useEffect, useMemo, useState, useTransition, type ReactNode } from "react";
import { changeAppointmentServiceAction } from "@/lib/schedulingActions";
import { priceLabelCOP } from "@/lib/money";
import { Button } from "../ui/system";
import { formatDuration } from "./AppointmentCard";
import type { Appt } from "../AgendaView";

/**
 * JP-4 «Cambiar servicio» inside the appointment's own panel (desktop) / sheet (phone). It
 * changes the SAME appointment's service (changeAppointmentServiceAction): same id, contact,
 * staff, start and history — "Corte + barba" → "Corte". The new service's duration/buffers/price
 * are resolved by the server for THIS professional from the SAME start; if the new duration
 * overlaps the next booking the server refuses and names it (nothing is moved or shortened).
 *
 * A completed appointment WITH a recorded payment cannot change its service here — the payment
 * snapshots the service/price/commission. It must go through void → re-charge (the server
 * refuses it too); this panel says so instead of offering the picker.
 */
export interface ServiceOption {
  id: string;
  name: string;
  duration_min: number;
  price: string | null;
}

export function ServiceChangeInline(props: {
  clientId: string;
  appt: Appt;
  services: ServiceOption[];
  onCancel: () => void;
  onDirty: (dirty: boolean) => void;
  onDone: (message: string) => void;
  /** The parent panel draws the body and the footer. */
  frame: (body: ReactNode, footer: ReactNode) => ReactNode;
}) {
  const { appt } = props;
  const paidLock = appt.status === "completed" && appt.payment_state === "recorded";
  const [choice, setChoice] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // The current service always shows, marked «Actual», even if it is no longer offered at the
  // site (so the operator sees what they are changing from); the rest are the site's catalogue.
  const options = useMemo(() => {
    const list = [...props.services];
    if (!list.some((s) => s.id === appt.service_id)) {
      list.unshift({ id: appt.service_id, name: appt.service_name, duration_min: appt.duration_min, price: appt.price });
    }
    return list;
  }, [props.services, appt.service_id, appt.service_name, appt.duration_min, appt.price]);

  const picked = choice && choice !== appt.service_id ? options.find((s) => s.id === choice) ?? null : null;
  const dirty = Boolean(picked);
  const onDirty = props.onDirty;
  useEffect(() => onDirty(dirty), [dirty, onDirty]);

  const submit = () => {
    if (!picked || pending) return;
    setFailed(null);
    const wanted = picked.id;
    startTransition(async () => {
      try {
        const r = await changeAppointmentServiceAction(props.clientId, appt.id, wanted);
        if (!r.ok) {
          setFailed(r.error);
          return;
        }
        props.onDone("Servicio actualizado");
      } catch {
        setFailed("No se pudo guardar: revisa la conexión. Tu selección se conserva.");
      }
    });
  };

  if (paidLock) {
    const body = (
      <div className="flex flex-col gap-4">
        <p className="rounded-[12px] border border-[var(--warn-rule)] bg-[var(--warn-soft)] px-3.5 py-3 text-[13px] leading-[1.5] text-[var(--warn)]">
          Esta cita ya tiene un cobro registrado, que guarda el servicio, el precio y la comisión. Para cambiar el servicio,
          anula el cobro, cambia el servicio y vuelve a cobrar — así el historial de dinero y las comisiones quedan correctos.
        </p>
        <p className="text-[12.5px] leading-5 text-muted">Anula el cobro desde «Cobro», en el detalle de la cita.</p>
      </div>
    );
    const footer = (
      <div className="flex justify-end">
        <Button onClick={props.onCancel}>Volver</Button>
      </div>
    );
    return <>{props.frame(body, footer)}</>;
  }

  const fromLabel = `${appt.service_name} · ${formatDuration(appt.duration_min)}${appt.price ? ` · ${priceLabelCOP(appt.price)}` : ""}`;
  const toLabel = picked ? `${picked.name} · ${formatDuration(picked.duration_min)}${picked.price ? ` · ${priceLabelCOP(picked.price)}` : ""}` : null;

  const body = (
    <div className="flex flex-col gap-5">
      <section aria-labelledby="sc-list" className="flex flex-col gap-2">
        <h3 id="sc-list" className="text-[13px] font-semibold">Servicio</h3>
        <div role="radiogroup" aria-labelledby="sc-list" className="flex max-h-[280px] flex-col gap-1.5 overflow-y-auto pr-0.5">
          {options.map((s) => {
            const current = s.id === appt.service_id;
            const sel = s.id === (choice ?? appt.service_id);
            return (
              <button
                key={s.id}
                type="button"
                role="radio"
                aria-checked={sel}
                onClick={() => {
                  setChoice(s.id);
                  setFailed(null);
                }}
                className={`u-focus flex min-h-[52px] items-center gap-3 rounded-[12px] border px-3.5 py-2.5 text-left transition-colors ${
                  sel ? "border-foreground shadow-[inset_0_0_0_1px_var(--foreground)]" : "border-line hover:bg-subtle"
                }`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium">
                    {s.name}
                    {current ? <span className="ml-2 text-[11.5px] font-normal text-muted">Actual</span> : null}
                  </span>
                  <span className="block text-[12.5px] text-muted">{formatDuration(s.duration_min)}</span>
                </span>
                <span className="u-tnum shrink-0 text-[12.5px] text-muted">{s.price ? priceLabelCOP(s.price) : "Sin precio"}</span>
              </button>
            );
          })}
        </div>
      </section>

      <section aria-label="Antes y después" className="rounded-[12px] border border-line px-3.5 py-3 text-[13px]">
        <dl className="grid grid-cols-[4.5rem_1fr] gap-x-3 gap-y-1.5">
          <dt className="text-muted">Antes</dt>
          <dd className="text-muted line-through decoration-1">{fromLabel}</dd>
          <dt className="text-muted">Después</dt>
          <dd className="font-semibold">{toLabel ?? "Elige un servicio distinto"}</dd>
        </dl>
        <p className="mt-2 text-[12.5px] leading-5 text-muted">
          La hora de inicio no cambia; la cita termina según la duración del nuevo servicio. El precio de la cita pasa a ser
          el del nuevo servicio. No se avisa al cliente automáticamente.
        </p>
      </section>
      {failed ? (
        <p role="alert" className="rounded-[10px] bg-[var(--danger-soft,rgba(192,38,45,0.08))] px-3 py-2.5 text-[13px] text-danger">
          {failed}
        </p>
      ) : null}
    </div>
  );

  const footer = (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <Button onClick={props.onCancel} disabled={pending}>Volver</Button>
      <Button variant="primary" onClick={submit} disabled={!picked || pending} loading={pending} loadingLabel="Guardando…">
        {failed ? "Reintentar" : "Guardar servicio"}
      </Button>
    </div>
  );

  return <>{props.frame(body, footer)}</>;
}

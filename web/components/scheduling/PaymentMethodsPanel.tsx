"use client";

import { useState, useTransition } from "react";
import { ModuleSurface, SurfaceHeader } from "@/components/ui/module/ModuleSurface";
import { Alert, Button, INPUT } from "@/components/ui/controls";
import {
  addPaymentMethodAction,
  renamePaymentMethodAction,
  reorderPaymentMethodsAction,
  setPaymentMethodActiveAction,
  setPaymentsTrackingStartedAtAction,
} from "@/lib/paymentActions";

/**
 * PY-1 «Métodos de pago» settings panel. Add, rename, reorder (up/down) and deactivate the
 * per-business payment methods (a used method is deactivated, never deleted), plus the date from
 * which a completed appointment counts as "cobro pendiente". UI only — every write goes through a
 * payments.settings-gated server action. The completion step (PY-2) reads the ACTIVE methods.
 */

interface Method {
  id: string;
  key: string;
  label: string;
  active: boolean;
}

// Shared controls (components/ui/controls): 44px on phones and tablets, the desktop
// density from lg — they were a private 30px/34px set, smaller than every other screen.
const MOVE = "u-focus u-tap inline-flex size-[44px] shrink-0 items-center justify-center rounded-sch-control border border-line-strong bg-surface text-muted transition-colors hover:bg-subtle hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 lg:size-[36px]";

export function PaymentMethodsPanel({
  clientId,
  methods,
  trackingStartedAt,
}: {
  clientId: string;
  /** Kept for callers; the breadcrumb names the business, so the title no longer does. */
  clientName?: string;
  methods: Method[];
  trackingStartedAt: string | null;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [newLabel, setNewLabel] = useState("");
  const [editing, setEditing] = useState<{ id: string; label: string } | null>(null);
  const trackingDate = trackingStartedAt ? trackingStartedAt.slice(0, 10) : "";
  const [date, setDate] = useState(trackingDate);

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setError(null);
    startTransition(async () => {
      const r = await fn();
      if (!r.ok) setError(r.error ?? "No se pudo guardar.");
    });
  };

  const ids = methods.map((m) => m.id);
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    const next = [...ids];
    [next[i], next[j]] = [next[j], next[i]];
    run(() => reorderPaymentMethodsAction(clientId, next));
  };

  return (
    // The approved settings surface (auditoría UI 2026-11-03, F07): ONE surface with the shared
    // title band, like Reglas or Sedes — not a header card over two more cards. The business is
    // named by the breadcrumb (and the rail with the bar hidden), so the title no longer repeats it.
    <ModuleSurface label="Métodos de pago">
      <SurfaceHeader title="Métodos de pago" summary="Cómo cobra el negocio al completar una cita. Un método en uso se desactiva, nunca se borra." />
      <div className="flex min-h-0 flex-1 flex-col gap-8 overflow-y-auto px-4 pb-8 pt-2 md:px-[20px]">
        {error ? <Alert>{error}</Alert> : null}

        <section aria-labelledby="pm-methods" className="flex max-w-3xl flex-col gap-3">
          <h2 id="pm-methods" className="text-[0.9375rem] font-semibold text-foreground">Métodos</h2>
          <ul className="flex flex-col divide-y divide-line-soft border-y border-line-soft">
            {methods.map((m, i) => (
              <li key={m.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5">
                <span className="flex shrink-0 gap-1.5">
                  <button type="button" aria-label={`Subir ${m.label}`} className={MOVE} disabled={pending || i === 0} onClick={() => move(i, -1)}>
                    <svg aria-hidden viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M8 12.5v-9M4.5 7 8 3.5 11.5 7" /></svg>
                  </button>
                  <button type="button" aria-label={`Bajar ${m.label}`} className={MOVE} disabled={pending || i === methods.length - 1} onClick={() => move(i, 1)}>
                    <svg aria-hidden viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M8 3.5v9M4.5 9 8 12.5 11.5 9" /></svg>
                  </button>
                </span>
                {editing?.id === m.id ? (
                  <form
                    className="flex min-w-[min(100%,16rem)] flex-1 flex-wrap items-center gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const label = editing.label;
                      run(async () => {
                        const r = await renamePaymentMethodAction(clientId, m.id, label);
                        if (r.ok) setEditing(null);
                        return r;
                      });
                    }}
                  >
                    <input autoFocus value={editing.label} maxLength={80} onChange={(e) => setEditing({ id: m.id, label: e.target.value })} className={`${INPUT} min-w-[10rem] flex-1`} aria-label="Nombre del método" />
                    <Button type="submit" variant="primary" size="sm" disabled={pending || editing.label.trim() === ""}>Guardar</Button>
                    <Button size="sm" disabled={pending} onClick={() => setEditing(null)}>Cancelar</Button>
                  </form>
                ) : (
                  <>
                    {/* The whole name, wrapped: at 390px it was cut to «Davipl…». */}
                    <span className="min-w-[8rem] flex-1 break-words text-sm text-foreground">
                      {m.label}
                      {!m.active ? <span className="ml-2 rounded-full bg-chip px-2 py-0.5 text-[0.6875rem] text-muted">Inactivo</span> : null}
                    </span>
                    <span className="flex shrink-0 gap-2 max-sm:w-full max-sm:justify-end">
                      <Button size="sm" disabled={pending} onClick={() => setEditing({ id: m.id, label: m.label })} aria-label={`Renombrar ${m.label}`}>
                        Renombrar
                      </Button>
                      <Button size="sm" disabled={pending} onClick={() => run(() => setPaymentMethodActiveAction(clientId, m.id, !m.active))} aria-label={`${m.active ? "Desactivar" : "Activar"} ${m.label}`}>
                        {m.active ? "Desactivar" : "Activar"}
                      </Button>
                    </span>
                  </>
                )}
              </li>
            ))}
          </ul>

          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const label = newLabel;
              run(async () => {
                const r = await addPaymentMethodAction(clientId, label);
                if (r.ok) setNewLabel("");
                return r;
              });
            }}
          >
            <input value={newLabel} maxLength={80} placeholder="Nuevo método (p. ej. PSE)" onChange={(e) => setNewLabel(e.target.value)} className={`${INPUT} min-w-[12rem] flex-1`} aria-label="Nuevo método de pago" />
            <Button type="submit" variant="primary" size="sm" disabled={pending || newLabel.trim() === ""}>Agregar</Button>
          </form>
        </section>

        <section aria-labelledby="pm-since" className="flex max-w-3xl flex-col gap-3">
          <div>
            <h2 id="pm-since" className="text-[0.9375rem] font-semibold text-foreground">Desde cuándo se cobra</h2>
            <p className="mt-1 text-[0.8125rem] text-muted">
              Las citas completadas en esta fecha o después, sin cobro registrado, aparecen como “cobro pendiente”.
            </p>
          </div>
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!date) return;
              run(() => setPaymentsTrackingStartedAtAction(clientId, `${date}T00:00:00.000Z`));
            }}
          >
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={`${INPUT} max-w-[14rem]`} aria-label="Fecha de inicio de cobros" />
            <Button type="submit" variant="primary" size="sm" disabled={pending || !date}>Guardar fecha</Button>
          </form>
        </section>
      </div>
    </ModuleSurface>
  );
}

"use client";

import { useState, useTransition } from "react";
import { PageShell } from "@/components/ui/PageShell";
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

const BTN = "inline-flex h-[34px] items-center justify-center rounded-lg bg-foreground px-3 text-xs font-medium text-background transition hover:opacity-90 disabled:opacity-50";
const GHOST = "inline-flex h-[30px] items-center justify-center rounded-lg border border-line px-2.5 text-xs text-muted transition hover:bg-subtle hover:text-foreground disabled:opacity-40";
const INPUT = "h-[34px] rounded-lg border border-line-strong bg-surface px-2.5 text-sm text-foreground outline-none transition focus:border-foreground";

export function PaymentMethodsPanel({
  clientId,
  clientName,
  methods,
  trackingStartedAt,
}: {
  clientId: string;
  clientName: string;
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
    <main className="flex min-h-0 w-full flex-1 flex-col gap-[var(--content-pad)]">
      <PageShell grow={false} clip={false}>
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5">
          <div className="min-w-0">
            <div className="flex items-baseline gap-2.5">
              <h1 className="truncate text-xl font-semibold tracking-[-0.025em] text-foreground">Métodos de pago</h1>
              <span className="truncate text-xs text-muted">{clientName}</span>
            </div>
            <p className="mt-0.5 hidden text-xs text-muted sm:block">
              Cómo cobra el negocio al completar una cita. Un método en uso se desactiva, nunca se borra.
            </p>
          </div>
        </div>
      </PageShell>

      {error ? (
        <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      ) : null}

      <PageShell grow={false} clip={false}>
        <div className="flex flex-col gap-2 p-3 sm:p-4">
          <ul className="flex flex-col gap-2">
            {methods.map((m, i) => (
              <li key={m.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2">
                <div className="flex flex-col gap-0.5">
                  <span className="flex gap-1">
                    <button type="button" aria-label="Subir" className={GHOST} disabled={pending || i === 0} onClick={() => move(i, -1)}>↑</button>
                    <button type="button" aria-label="Bajar" className={GHOST} disabled={pending || i === methods.length - 1} onClick={() => move(i, 1)}>↓</button>
                  </span>
                </div>
                {editing?.id === m.id ? (
                  <form
                    className="flex min-w-0 flex-1 items-center gap-2"
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
                    <input autoFocus value={editing.label} maxLength={80} onChange={(e) => setEditing({ id: m.id, label: e.target.value })} className={`${INPUT} min-w-0 flex-1`} aria-label="Nombre del método" />
                    <button type="submit" className={BTN} disabled={pending || editing.label.trim() === ""}>Guardar</button>
                    <button type="button" className={GHOST} disabled={pending} onClick={() => setEditing(null)}>Cancelar</button>
                  </form>
                ) : (
                  <>
                    <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                      {m.label}
                      {!m.active ? <span className="ml-2 rounded-full bg-chip px-2 py-0.5 text-[0.625rem] text-faint">Inactivo</span> : null}
                    </span>
                    <button type="button" className={GHOST} disabled={pending} onClick={() => setEditing({ id: m.id, label: m.label })}>Renombrar</button>
                    <button
                      type="button"
                      className={GHOST}
                      disabled={pending}
                      onClick={() => run(() => setPaymentMethodActiveAction(clientId, m.id, !m.active))}
                    >
                      {m.active ? "Desactivar" : "Activar"}
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>

          <form
            className="mt-1 flex items-center gap-2"
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
            <input value={newLabel} maxLength={80} placeholder="Nuevo método (p. ej. PSE)" onChange={(e) => setNewLabel(e.target.value)} className={`${INPUT} min-w-0 flex-1`} aria-label="Nuevo método de pago" />
            <button type="submit" className={BTN} disabled={pending || newLabel.trim() === ""}>Agregar</button>
          </form>
        </div>
      </PageShell>

      <PageShell grow={false} clip={false}>
        <div className="flex flex-col gap-2 p-3 sm:p-4">
          <h2 className="text-sm font-semibold text-foreground">Desde cuándo se cobra</h2>
          <p className="text-xs text-muted">
            Las citas completadas en esta fecha o después, sin cobro registrado, aparecen como “cobro pendiente”.
          </p>
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!date) return;
              run(() => setPaymentsTrackingStartedAtAction(clientId, `${date}T00:00:00.000Z`));
            }}
          >
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={INPUT} aria-label="Fecha de inicio de cobros" />
            <button type="submit" className={BTN} disabled={pending || !date}>Guardar fecha</button>
          </form>
        </div>
      </PageShell>
    </main>
  );
}

"use client";

import type { ComponentProps, ReactNode, RefObject } from "react";
import { Button, ConfirmDialog, useModalLayer } from "@/components/ui/controls";
import { useTrappedPanel } from "@/components/ui/Overlay";

/**
 * A page-level confirmation (discard changes, archive, delete…) for screens that are not
 * themselves a trapped overlay — the in-page editors and the lists. Focus is trapped in
 * the dialog, the SAFE choice has focus, Escape cancels, and focus returns to the
 * control that opened it.
 */
export function ConfirmLayer(props: Omit<ComponentProps<typeof ConfirmDialog>, "layerRef">) {
  const trapRef = useTrappedPanel({ active: true, onClose: props.onCancel });
  const layer = useModalLayer(true);
  return (
    <div ref={trapRef as RefObject<HTMLDivElement>} className="fixed inset-0 z-50">
      <ConfirmDialog {...props} layerRef={layer.layerRef} />
    </div>
  );
}

/** «¿Descartar los cambios?» — one wording for every editor. */
export function DiscardChanges({ onKeep, onDiscard, body }: { onKeep: () => void; onDiscard: () => void; body?: string }) {
  return (
    <ConfirmLayer
      id="discard-changes"
      title="¿Descartar los cambios?"
      body={body ?? "Hay cambios sin guardar. Si sales ahora, se pierden."}
      cancelLabel="Seguir editando"
      confirmLabel="Descartar"
      onCancel={onKeep}
      onConfirm={onDiscard}
    />
  );
}

/** A read-only dialog (a history, a detail): focus trapped, Escape and «Cerrar» close it,
 *  focus returns to what opened it. */
export function InfoDialog({ id, title, onClose, children }: { id: string; title: string; onClose: () => void; children: ReactNode }) {
  const trapRef = useTrappedPanel({ active: true, onClose });
  return (
    <div ref={trapRef as RefObject<HTMLDivElement>} className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:items-center sm:p-4">
      <div role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} className="flex max-h-[min(640px,calc(100dvh-2rem))] w-full max-w-md flex-col rounded-sch-card border border-line bg-popover text-popover-foreground shadow-[0_16px_40px_rgba(18,21,27,0.2)] sm:rounded-sch-modal">
        <div className="flex items-center gap-3 border-b border-line px-5 py-3.5">
          <h3 id={`${id}-title`} className="min-w-0 flex-1 truncate text-base font-semibold tracking-tight">
            {title}
          </h3>
          <Button size="sm" onClick={onClose}>
            Cerrar
          </Button>
        </div>
        <div className="min-h-0 overflow-y-auto px-5 py-4 text-sm">{children}</div>
      </div>
    </div>
  );
}

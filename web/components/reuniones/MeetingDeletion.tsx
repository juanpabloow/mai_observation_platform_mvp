"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * «Eliminar reunión», desde la ficha y desde cada fila del listado.
 *
 * ── UN diálogo, no dos ─────────────────────────────────────────────────────
 *
 * La acción vive en dos menús, pero el diálogo es literalmente el mismo nodo:
 * el proveedor guarda cuál es la reunión pendiente y renderiza una sola
 * instancia. No es purismo — dos diálogos con el mismo texto divergen a la
 * primera corrección que sólo se aplica a uno, y el que se quede atrás será el
 * que confirme un borrado sin decir que también se va el audio.
 *
 * Por la misma razón hay una sola función que llama al servidor. Los dos menús
 * no «hacen lo mismo»: hacen ESTO.
 *
 * ── Lo que el navegador manda ──────────────────────────────────────────────
 *
 * `clientId` y nada más. La ruta lleva el `meetingId`; el tenant sale de la
 * sesión y el prefijo de almacenamiento lo deriva el servidor. No hay ningún
 * campo donde meter una clave.
 */

export interface DeletableMeeting {
  readonly id: string;
  readonly title: string;
  readonly deletionState: "live" | "deleting" | "delete_failed";
}

interface DeletionContext {
  readonly clientId: string;
  /** false para un `member`: la acción ni siquiera aparece. */
  readonly canDelete: boolean;
  readonly pedirEliminar: (meeting: DeletableMeeting) => void;
  /** La reunión pendiente de confirmación, o null. */
  readonly pendiente: DeletableMeeting | null;
}

const Ctx = createContext<DeletionContext | null>(null);

/** Lanza si se usa fuera del proveedor: un menú sin diálogo sería un botón muerto. */
export function useMeetingDeletion(): DeletionContext {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useMeetingDeletion fuera de <MeetingDeletionProvider>");
  return ctx;
}

export function MeetingDeletionProvider({
  clientId,
  canDelete,
  children,
}: {
  clientId: string;
  canDelete: boolean;
  children: React.ReactNode;
}) {
  const [pendiente, setPendiente] = useState<DeletableMeeting | null>(null);
  const pedirEliminar = useCallback((m: DeletableMeeting) => setPendiente(m), []);

  return (
    <Ctx.Provider value={{ clientId, canDelete, pedirEliminar, pendiente }}>
      {children}
      {pendiente ? (
        <DeleteMeetingDialog
          meeting={pendiente}
          clientId={clientId}
          onClose={() => setPendiente(null)}
        />
      ) : null}
    </Ctx.Provider>
  );
}

// ══════════════════════════════════════════════════════════════════════════
//  El diálogo
// ══════════════════════════════════════════════════════════════════════════

export function DeleteMeetingDialog({
  meeting,
  clientId,
  onClose,
}: {
  meeting: DeletableMeeting;
  clientId: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [enVuelo, setEnVuelo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelar = useRef<HTMLButtonElement>(null);

  // El foco arranca en CANCELAR, no en el botón rojo: un Enter reflejo no debe
  // destruir una grabación.
  useEffect(() => {
    cancelar.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !enVuelo) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [enVuelo, onClose]);

  const eliminar = async () => {
    if (enVuelo) return;
    setEnVuelo(true);
    setError(null);
    try {
      const res = await fetch(`/api/meetings/v1/meetings/${meeting.id}/delete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId }),
      });
      if (!res.ok) {
        const cuerpo = (await res.json().catch(() => null)) as { message?: string } | null;
        setError(
          res.status === 403
            ? "No tienes permisos para eliminar esta reunión."
            : (cuerpo?.message ?? "No se pudo eliminar la reunión."),
        );
        setEnVuelo(false);
        return;
      }
      onClose();
      // La limpieza del almacenamiento termina después; lo que ya es cierto es
      // que la reunión quedó marcada, y eso es lo que la pantalla debe reflejar.
      router.refresh();
    } catch {
      setError("No se pudo contactar con el servidor.");
      setEnVuelo(false);
    }
  };

  const reintento = meeting.deletionState === "delete_failed";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(0,0,0,0.45)] p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !enVuelo) onClose();
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="eliminar-reunion-titulo"
        aria-describedby="eliminar-reunion-detalle"
        className="w-full max-w-md rounded-xl border border-line bg-surface p-4 shadow-[var(--shadow-float)]"
      >
        <h2 id="eliminar-reunion-titulo" className="text-[0.9375rem] font-semibold tracking-[-0.01em]">
          {reintento ? "Reintentar la eliminación" : "Eliminar reunión"}
        </h2>

        <p className="mt-2 truncate text-[0.8125rem] font-medium text-foreground" title={meeting.title}>
          {meeting.title}
        </p>

        {/* Se enumera lo que desaparece. «Eliminar reunión» es el nombre
            correcto precisamente porque no es sólo la transcripción. */}
        <div id="eliminar-reunion-detalle" className="mt-2 text-[0.78125rem] leading-relaxed text-muted">
          <p>Desaparecen para siempre:</p>
          <ul className="mt-1 list-disc pl-4">
            <li>el audio original</li>
            <li>las transcripciones y sus versiones</li>
            <li>los resúmenes y análisis</li>
            <li>todos los artefactos del procesamiento</li>
          </ul>
          <p className="mt-2">No se puede deshacer.</p>
        </div>

        {error ? (
          <p role="alert" className="mt-3 text-[0.78125rem] text-brand">
            {error}
          </p>
        ) : null}

        <div className="mt-4 flex justify-end gap-2">
          <button
            ref={cancelar}
            type="button"
            onClick={onClose}
            disabled={enVuelo}
            className="u-focus inline-flex min-h-8 items-center rounded-lg border border-line px-3 text-[0.8125rem] text-foreground transition-colors hover:bg-subtle disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={eliminar}
            disabled={enVuelo}
            className="u-focus inline-flex min-h-8 items-center rounded-lg bg-brand px-3 text-[0.8125rem] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {enVuelo ? "Eliminando…" : reintento ? "Reintentar" : "Eliminar reunión"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
//  El menú de tres puntos, el MISMO en la ficha y en la fila
// ══════════════════════════════════════════════════════════════════════════

export function MeetingActionsMenu({
  meeting,
  align = "right",
  size = 8,
}: {
  meeting: DeletableMeeting;
  align?: "right" | "left";
  /** 8 en la cabecera de la ficha, 7 en la fila del listado. */
  size?: 7 | 8;
}) {
  const { canDelete, pedirEliminar } = useMeetingDeletion();
  const [abierto, setAbierto] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Mismo comportamiento que el menú de filtros de la barra: clic fuera y
  // Escape cierran.
  useEffect(() => {
    if (!abierto) return;
    const fuera = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setAbierto(false);
    };
    const tecla = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAbierto(false);
    };
    document.addEventListener("mousedown", fuera);
    document.addEventListener("keydown", tecla);
    return () => {
      document.removeEventListener("mousedown", fuera);
      document.removeEventListener("keydown", tecla);
    };
  }, [abierto]);

  const enCurso = meeting.deletionState === "deleting";
  const fallida = meeting.deletionState === "delete_failed";

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setAbierto((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={abierto}
        aria-label={`Más acciones para ${meeting.title}`}
        // Clases literales: Tailwind no ve una interpolada y no la generaría.
        className={`u-focus inline-flex ${size === 8 ? "size-8" : "size-7"} items-center justify-center rounded-lg text-muted transition-colors hover:bg-subtle hover:text-foreground`}
      >
        <svg viewBox="0 0 16 16" className="size-3.5" fill="currentColor" aria-hidden>
          <circle cx="3" cy="8" r="1.3" />
          <circle cx="8" cy="8" r="1.3" />
          <circle cx="13" cy="8" r="1.3" />
        </svg>
      </button>
      {abierto ? (
        <div
          role="menu"
          className={`absolute ${align === "right" ? "right-0" : "left-0"} top-[calc(100%+0.25rem)] z-30 w-56 overflow-hidden rounded-lg border border-line bg-surface py-1 shadow-[var(--shadow-float)]`}
        >
          {canDelete ? (
            <button
              type="button"
              role="menuitem"
              disabled={enCurso}
              onClick={() => {
                setAbierto(false);
                pedirEliminar(meeting);
              }}
              className="flex min-h-9 w-full items-center px-3 text-left text-sm text-brand transition-colors hover:bg-subtle disabled:cursor-default disabled:text-muted disabled:hover:bg-transparent"
            >
              {enCurso ? "Eliminando…" : fallida ? "Reintentar eliminación" : "Eliminar reunión"}
            </button>
          ) : (
            <p className="px-3 py-2 text-[0.78125rem] text-muted">No hay acciones disponibles.</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

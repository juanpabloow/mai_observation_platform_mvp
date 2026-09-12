"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { MeetingToast } from "@/components/reuniones/MeetingToast";
import {
  errorDeRed,
  HANDOFF_KEY,
  leerRespuesta,
  trasAceptar,
  TOAST_ELIMINADA,
  type DeletionSurface,
} from "@/lib/meetingsDeletionFlow";

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
  /**
   * true en cuanto el servidor aceptó la eliminación de esa reunión, sin
   * esperar a que R2 quede vacío. El listado la usa para retirar la fila.
   */
  readonly estaRetirada: (meetingId: string) => boolean;
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
  surface = "list",
  children,
}: {
  clientId: string;
  canDelete: boolean;
  /**
   * Dónde está montado. Lo único que cambia es qué pasa DESPUÉS del 202: el
   * listado retira la fila; la ficha se va al listado, porque lo que se acaba
   * de eliminar es justo lo que se estaba mirando.
   */
  surface?: DeletionSurface;
  children: React.ReactNode;
}) {
  const [pendiente, setPendiente] = useState<DeletableMeeting | null>(null);
  const [retiradas, setRetiradas] = useState<readonly string[]>([]);
  const [aviso, setAviso] = useState<string | null>(null);
  const pedirEliminar = useCallback((m: DeletableMeeting) => setPendiente(m), []);

  // El relevo desde la ficha. La redirección desmontó el proveedor de allí, así
  // que el aviso lo pinta el que acaba de montarse aquí, y se consume una sola
  // vez: una recarga posterior no vuelve a anunciar un borrado antiguo.
  useEffect(() => {
    let pendienteDeAviso: string | null = null;
    try {
      pendienteDeAviso = window.sessionStorage.getItem(HANDOFF_KEY);
      if (pendienteDeAviso !== null) window.sessionStorage.removeItem(HANDOFF_KEY);
    } catch {
      // Almacenamiento bloqueado (modo privado, política del navegador). Se
      // pierde un aviso; no se pierde la eliminación.
      return;
    }
    // El relevo es estado del NAVEGADOR, no de React. Leerlo en el
    // inicializador del `useState` haría que el primer render del cliente
    // difiriera del HTML del servidor; esto corre una vez por montaje y se
    // consume, así que no hay cascada que evitar.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (pendienteDeAviso !== null) setAviso(TOAST_ELIMINADA);
  }, []);

  const retirar = useCallback((meetingId: string) => {
    setRetiradas((previas) => (previas.includes(meetingId) ? previas : [...previas, meetingId]));
  }, []);

  const estaRetirada = useCallback(
    (meetingId: string) => retiradas.includes(meetingId),
    [retiradas],
  );

  const valor = useMemo(
    () => ({ clientId, canDelete, pedirEliminar, pendiente, estaRetirada }),
    [clientId, canDelete, pedirEliminar, pendiente, estaRetirada],
  );

  return (
    <Ctx.Provider value={valor}>
      {children}
      {pendiente ? (
        <DeleteMeetingDialog
          meeting={pendiente}
          clientId={clientId}
          surface={surface}
          onClose={() => setPendiente(null)}
          onAceptada={(meetingId) => {
            const plan = trasAceptar(surface, clientId);
            if (plan.retirarDelListado) retirar(meetingId);
            if (plan.redirigirA === null) setAviso(plan.toast);
          }}
        />
      ) : null}
      <MeetingToast texto={aviso} onCerrar={() => setAviso(null)} />
    </Ctx.Provider>
  );
}

// ══════════════════════════════════════════════════════════════════════════
//  El diálogo
// ══════════════════════════════════════════════════════════════════════════

export function DeleteMeetingDialog({
  meeting,
  clientId,
  surface = "list",
  onClose,
  onAceptada,
}: {
  meeting: DeletableMeeting;
  clientId: string;
  surface?: DeletionSurface;
  onClose: () => void;
  /** Sólo se llama con un 2xx en la mano. */
  onAceptada?: (meetingId: string) => void;
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
      const cuerpo = res.ok
        ? null
        : ((await res.json().catch(() => null)) as { message?: string } | null);
      const resultado = leerRespuesta(res.status, cuerpo?.message ?? null);

      // NO ACEPTADA. El diálogo se queda abierto con su reunión intacta, el
      // botón vuelve a estar disponible y nadie ha retirado ninguna fila: si
      // esto ocultara la reunión, la siguiente recarga la traería de vuelta y
      // el usuario creería que «se deshizo».
      if (!resultado.aceptada) {
        setError(resultado.error);
        setEnVuelo(false);
        return;
      }

      // ACEPTADA (202). A partir de aquí no se espera nada: ni el vaciado de
      // R2, ni el barrido, ni una segunda consulta. La reunión ya no está viva
      // en la base, así que las lecturas de la pantalla tampoco la devuelven.
      const plan = trasAceptar(surface, clientId);
      onClose();
      onAceptada?.(meeting.id);

      if (plan.redirigirA !== null) {
        // El aviso tiene que sobrevivir a la navegación: lo pinta el proveedor
        // del listado en cuanto monte.
        try {
          window.sessionStorage.setItem(HANDOFF_KEY, plan.toast);
        } catch {
          // Sin almacenamiento no hay aviso, pero sí redirección.
        }
        // `replace` y no `push`: la ficha de una reunión eliminada es un 404, y
        // dejarla en el historial convierte el botón «atrás» en un error.
        router.replace(plan.redirigirA);
        return;
      }

      // En el listado la fila ya se fue del estado visual. El refresco es para
      // que los recuentos, las facetas y la paginación del servidor se pongan
      // al día; la pantalla no depende de que llegue.
      router.refresh();
    } catch {
      setError(errorDeRed().error);
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

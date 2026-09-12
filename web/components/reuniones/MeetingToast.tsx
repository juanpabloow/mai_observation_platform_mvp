"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * EL AVISO de la pantalla de Reuniones. Uno solo, compartido.
 *
 * Nació dentro de «Eliminar reunión» —era «Reunión eliminada»— y ahora lo usan
 * también copiar y descargar el transcript. Está aquí y no duplicado en cada
 * sitio por la misma razón por la que el diálogo de eliminación es un solo
 * nodo: dos avisos con el mismo aspecto divergen a la primera corrección que
 * sólo se aplica a uno, y el que se quede atrás será el que pierda el
 * `aria-live`.
 *
 * ── Accesibilidad, y por qué está siempre montado ──────────────────────────
 *
 * `role="status"` con `aria-live="polite"`, no `alert`: es la confirmación de
 * algo que el usuario acaba de pedir, no una interrupción.
 *
 * La región vive SIEMPRE en el árbol, aunque no haya texto. Una región viva que
 * se monta a la vez que su contenido no siempre se anuncia: el lector de
 * pantalla no la estaba observando cuando apareció. Montada desde el principio,
 * lo que cambia es su contenido, y eso sí se anuncia.
 *
 * Y no depende del color: lo que informa es el texto. El único color es el
 * borde de la tarjeta, igual que en el resto de la pantalla.
 */
export function MeetingToast({
  texto,
  onCerrar,
}: {
  texto: string | null;
  onCerrar: () => void;
}) {
  useEffect(() => {
    if (texto === null) return;
    const t = setTimeout(onCerrar, 6000);
    return () => clearTimeout(t);
  }, [texto, onCerrar]);

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed bottom-4 right-4 z-[60] flex justify-end"
    >
      {texto !== null ? (
        <div className="pointer-events-auto flex max-w-sm items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 shadow-[var(--shadow-float)]">
          <span className="text-[0.8125rem] text-foreground">{texto}</span>
          <button
            type="button"
            onClick={onCerrar}
            aria-label="Cerrar el aviso"
            className="u-focus -mr-1 inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-subtle hover:text-foreground"
          >
            <svg viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden>
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * El estado del aviso, para quien lo dispara.
 *
 * Un `useState` y un `useCallback` que cualquiera podría escribir, pero
 * escritos una vez: así el que añada el tercer sitio que avisa no tiene que
 * decidir de nuevo si el cierre va en el cuerpo del render o en un callback
 * estable —y con uno inestable, el `useEffect` del temporizador se reinicia en
 * cada pasada y el aviso no se va nunca—.
 */
export function useMeetingToast(): {
  readonly texto: string | null;
  readonly avisar: (texto: string) => void;
  readonly cerrar: () => void;
} {
  const [texto, setTexto] = useState<string | null>(null);
  const avisar = useCallback((t: string) => setTexto(t), []);
  const cerrar = useCallback(() => setTexto(null), []);
  return { texto, avisar, cerrar };
}

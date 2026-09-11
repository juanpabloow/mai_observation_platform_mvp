"use client";

import { useCallback, useEffect, useState } from "react";
import { AudioPlayer, type AudioState, type FollowState, type SpeakerTurn } from "@/components/reuniones/AudioPlayer";

/**
 * EL DOCK FLOTANTE. Un solo reproductor por reunión, fijo a la ventana.
 *
 * ── Por qué `fixed` y no pegado dentro del panel ───────────────────────────
 *
 * Antes el reproductor era el último hijo de la tarjeta de contenido, así que
 * dependía de la geometría de la pestaña activa: en Transcript era una franja
 * de 70 px de extremo a extremo, en las demás una barra fina en otro sitio, y
 * al desplazar podía acabar junto a la cabecera. `position: fixed` lo saca de
 * ese flujo: se posiciona contra la ventana, así que no lo mueve ningún scroll
 * ni ningún cambio de pestaña, y queda EXACTAMENTE en el mismo lugar visual en
 * Resumen, Transcript, Reportes y Evidencia.
 *
 * ── Y por qué no ocupa todo el ancho ───────────────────────────────────────
 *
 * Una barra de extremo a extremo se lee como parte del marco de la aplicación y
 * compite con la cabecera. Flotando, con un ancho máximo y separada de los
 * bordes, se lee como lo que es: un objeto sobre el contenido, que se puede
 * compactar.
 *
 * ── El montaje ─────────────────────────────────────────────────────────────
 *
 * Este componente se monta POR ENCIMA del contenido variable de las pestañas,
 * como hermano del área de trabajo y no dentro de ella. Es lo que garantiza que
 * cambiar de pestaña no toque el `<AudioPlayer>` ni, con él, el `<audio>`: React
 * no reconcilia lo que no ha cambiado de sitio en el árbol.
 *
 * No se puede arrastrar. No estaba pedido, y un dock arrastrable necesita
 * además recordar posición, mantenerse dentro de la ventana al redimensionar y
 * no taparse con el propio contenido que indexa.
 */

/** La preferencia sobrevive a la navegación dentro de la reunión y al recargar. */
const CLAVE = "mai.reuniones.dock";

type Modo = "expanded" | "compact";

function modoGuardado(): Modo {
  // `localStorage` no existe en el servidor y puede lanzar con las cookies de
  // terceros bloqueadas. Un reproductor que no se pinta porque no pudo leer una
  // preferencia sería un fallo peor que perder la preferencia.
  try {
    return window.localStorage.getItem(CLAVE) === "compact" ? "compact" : "expanded";
  } catch {
    return "expanded";
  }
}

export function AudioDock({
  meetingId,
  durationSeconds,
  startAt,
  state,
  src,
  speakers,
  onTimeChange,
  followState,
  onFollowToggle,
  onFollowResume,
}: {
  meetingId: string;
  durationSeconds: number;
  startAt: number;
  state: AudioState;
  src: string | null;
  speakers: SpeakerTurn[];
  onTimeChange: (seconds: number) => void;
  followState: FollowState;
  onFollowToggle: () => void;
  onFollowResume: () => void;
}) {
  // Arranca en `expanded` en las dos pasadas (servidor y primera del cliente) y
  // se corrige tras montar: leer `localStorage` durante el render daría una
  // marca distinta en cada lado y React se quejaría de la hidratación.
  const [modo, setModo] = useState<Modo>("expanded");
  useEffect(() => setModo(modoGuardado()), []);

  const alternar = useCallback(() => {
    setModo((m) => {
      const siguiente: Modo = m === "compact" ? "expanded" : "compact";
      try {
        window.localStorage.setItem(CLAVE, siguiente);
      } catch {
        // Sin persistencia, pero la sesión mantiene la preferencia en memoria.
      }
      return siguiente;
    });
  }, []);

  const compacto = modo === "compact";

  return (
    <div
      // `pointer-events-none` en la capa y `auto` en la cápsula: la franja
      // invisible que centra el dock no debe robar clics al contenido que hay
      // debajo, que es justo lo que pasa con un contenedor fijo a todo el ancho.
      className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center px-3 pb-3 sm:px-4 sm:pb-4"
    >
      <div
        role="group"
        aria-label="Reproductor de la reunión"
        className={`pointer-events-auto flex items-center rounded-xl border border-line bg-surface shadow-[var(--shadow-float)] ${
          compacto
            ? // Cápsula: a la derecha en escritorio, centrada y estrecha en móvil.
              "ml-auto gap-2 px-2.5 py-2"
            : // Expandido: casi todo el ancho en móvil, con tope en escritorio.
              "w-full max-w-[54rem] flex-wrap gap-2.5 px-3 py-2.5"
        }`}
      >
        <AudioPlayer
          meetingId={meetingId}
          durationSeconds={durationSeconds}
          startAt={startAt}
          state={state}
          src={src}
          speakers={speakers}
          onTimeChange={onTimeChange}
          mode={modo}
          density="dock"
          variant="waveform"
          followState={followState}
          onFollowToggle={onFollowToggle}
          onFollowResume={onFollowResume}
          onToggleMode={alternar}
          className="min-w-0 flex-1"
        />
      </div>
    </div>
  );
}

/**
 * El hueco que el dock necesita al pie de un contenedor desplazable.
 *
 * Sin esto el dock tapa las últimas líneas del transcript y los controles del
 * final de las demás pantallas. Es una clase y no un `margin` en el dock porque
 * el dock está fuera del flujo: no empuja nada, así que el espacio lo tiene que
 * reservar quien scrollea.
 */
export const DOCK_GAP_CLS = "pb-28 sm:pb-24";

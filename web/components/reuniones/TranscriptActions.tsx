"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import {
  serializeTranscript,
  transcriptFileName,
} from "@/lib/meetingsTranscriptExport";
import { copyText, downloadTextFile } from "@/lib/meetingsTranscriptActions";
import type { MeetingDetail } from "@/lib/meetingsData";

/**
 * Copiar y descargar el transcript. UNA fuente para los dos sitios que lo
 * ofrecen.
 *
 * El «Exportar» de la cabecera y el «Copiar transcript» de la pestaña no son
 * dos funciones parecidas: son la misma, y el documento que producen sale del
 * mismo serializador. Si cada botón armara su texto, lo que se pega y lo que se
 * descarga divergirían en la primera corrección de formato.
 *
 * ── Qué se copia ───────────────────────────────────────────────────────────
 *
 * TODO el transcript de la versión activa, no lo que hay en pantalla. La
 * pantalla agrupa los segmentos en bloques de intervención y desplaza; el texto
 * sale de `meeting.transcript`, que es la lista completa tal como la devolvió el
 * servidor.
 *
 * ── Por qué no toca el audio ───────────────────────────────────────────────
 *
 * Porque no hay nada que tocar: ni pausa, ni `currentTime`, ni remontaje. El
 * `<audio>` vive en el dock y esto no lo conoce. Copiar mientras suena es
 * copiar mientras suena.
 */

export const TOAST_COPIADO = "Transcript copiado";
export const TOAST_DESCARGADO = "Transcript descargado";
export const TOAST_ERROR_COPIA = "No pudimos copiar el transcript. Inténtalo nuevamente.";

export interface TranscriptExport {
  /** El documento, o `null` si no hay transcript que exportar. */
  readonly texto: string | null;
  /** false = no hay nada que copiar ni descargar. */
  readonly disponible: boolean;
  /** Una operación en curso. Bloquea la segunda pulsación. */
  readonly enVuelo: boolean;
  readonly copiar: () => void;
  readonly descargar: () => void;
}

export function useTranscriptExport(
  meeting: MeetingDetail,
  clientName: string | null,
  avisar: (texto: string) => void,
): TranscriptExport {
  // Se serializa una vez por transcript, no por pulsación: con media hora de
  // audio son cientos de segmentos, y rearmar el documento en el `onClick`
  // metería el trabajo en el mismo cuadro que la interacción.
  const texto = useMemo(
    () =>
      serializeTranscript(
        {
          title: meeting.title,
          clientName,
          date: meeting.when,
          durationSeconds: meeting.durationSeconds,
        },
        meeting.transcript.map((s) => ({ at: s.at, speaker: s.speaker, text: s.text })),
      ),
    [meeting.title, meeting.when, meeting.durationSeconds, meeting.transcript, clientName],
  );

  const [enVuelo, setEnVuelo] = useState(false);
  // Un `ref` ADEMÁS del estado: dos clics en el mismo cuadro ven el mismo valor
  // de estado —React lo actualiza en el siguiente render— y los dos pasarían.
  // El ref cambia en el acto.
  const ocupado = useRef(false);

  const copiar = useCallback(() => {
    if (ocupado.current || texto === null) return;
    ocupado.current = true;
    setEnVuelo(true);
    void copyText(texto)
      .then((ok) => avisar(ok ? TOAST_COPIADO : TOAST_ERROR_COPIA))
      .finally(() => {
        ocupado.current = false;
        setEnVuelo(false);
      });
  }, [texto, avisar]);

  const descargar = useCallback(() => {
    if (ocupado.current || texto === null) return;
    ocupado.current = true;
    setEnVuelo(true);
    try {
      downloadTextFile(transcriptFileName(meeting.title), texto);
      avisar(TOAST_DESCARGADO);
    } finally {
      ocupado.current = false;
      setEnVuelo(false);
    }
  }, [texto, meeting.title, avisar]);

  return { texto, disponible: texto !== null, enVuelo, copiar, descargar };
}

/**
 * La fila de acciones del transcript. Discreta y a la derecha, alineada con el
 * texto que acompaña.
 *
 * No es una barra pegada arriba. Aquí hubo una —la del seguimiento del audio— y
 * se quitó porque gobernaba la reproducción desde dos regiones de distancia del
 * reproductor. Esto es distinto: son acciones SOBRE EL TEXTO, y su sitio es
 * junto al texto.
 *
 * En estrecho el rótulo se acorta en vez de esconderse en un menú: el menú de
 * tres puntos de la cabecera es el de la reunión —eliminarla—, y meter aquí una
 * acción del transcript mezclaría dos ámbitos.
 */
export function TranscriptActionsRow({
  acciones,
  hayTranscript,
}: {
  acciones: TranscriptExport;
  /** false = la reunión no tiene transcript todavía. */
  hayTranscript: boolean;
}) {
  if (!hayTranscript || !acciones.disponible) {
    // Se DICE por qué no están, en vez de dejar dos botones muertos.
    return (
      <p className="px-1 text-[0.71875rem] text-muted">
        {hayTranscript
          ? "Este transcript no tiene texto que copiar ni descargar."
          : "Todavía no hay transcript que copiar ni descargar."}
      </p>
    );
  }

  const cls =
    "u-focus inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-line px-2.5 text-xs text-foreground transition-colors hover:bg-subtle disabled:cursor-not-allowed disabled:text-muted";

  return (
    <div className="flex flex-wrap items-center justify-end gap-1.5 px-1">
      <button
        type="button"
        onClick={acciones.copiar}
        disabled={acciones.enVuelo}
        aria-busy={acciones.enVuelo}
        className={cls}
      >
        <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
          <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
          <path d="M10.5 3.5H4A1.5 1.5 0 0 0 2.5 5v6.5" />
        </svg>
        <span className="hidden sm:inline">Copiar transcript</span>
        <span className="sm:hidden">Copiar</span>
      </button>
      <button
        type="button"
        onClick={acciones.descargar}
        disabled={acciones.enVuelo}
        aria-busy={acciones.enVuelo}
        className={cls}
      >
        <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
          <path d="M8 2.5v7.5M5 7.5 8 10.5l3-3M3 13h10" />
        </svg>
        <span className="hidden sm:inline">Descargar TXT</span>
        <span className="sm:hidden">TXT</span>
      </button>
    </div>
  );
}

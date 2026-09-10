"use client";

import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AudioPlayer } from "../components/reuniones/AudioPlayer";
import { Transcript } from "../components/reuniones/MeetingWorkspace";
import type { MeetingDetail, TranscriptSegment } from "../lib/meetingsData";

/**
 * ARNÉS INTERACTIVO DEL TRANSCRIPT — para comprobar los EFECTOS, no la pintura.
 *
 * El arnés de SSR (renderTranscriptCheck.tsx) valida la presentación: medida de la
 * columna, interlineado, cuántas cabeceras. Lo que no puede validar es nada que ocurra
 * en ejecución: el `useEffect` que desplaza, un clic que salta al tiempo del segmento,
 * el foco moviéndose con el tabulador. Para eso hace falta React vivo.
 *
 * No es una ruta de la aplicación a propósito: el middleware de Next manda a `/login`
 * todo lo que no esté en su lista pública, así que una página de prueba habría exigido
 * tocar esa lista — cambiar la puerta de la aplicación para poder probar el salón. Esto
 * se empaqueta con esbuild y se sirve como HTML estático, sin Next y sin sesión.
 *
 * `next/link` se sustituye por un stub en el empaquetado (ver buildTranscriptHarness):
 * la única razón por la que aparece en el grafo es que `ui/primitives` lo importa.
 */

let seq = 0;
const stamp = (s: number) =>
  `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

function seg(at: number, endsAt: number, label: string, text: string, name: string): TranscriptSegment {
  seq += 1;
  return {
    index: seq,
    at,
    endsAt,
    stamp: stamp(at),
    speakerLabel: label,
    speaker: name,
    initials: name.split(" ").map((w) => w[0]).join("").slice(0, 2),
    text,
  };
}

/** Intervención larga: los segmentos cortos que produce Whisper, una frase cada uno. */
const LARGO = [
  "Entonces, que lo de las cotizaciones, porque me decía Sandra, que de esto me dice,",
  "las cosas que más nos quitan tiempo son la transcripción de actas y cotizaciones.",
  "Entonces, yo que por decir algo, cosa que no necesito unos términos de referencia,",
  "sino por decir que Juanita necesito hacer el lavado del tanque,",
  "y todavía no tiene proveedor, o le están pidiendo otras cotizaciones,",
  "entonces que ella emita un correo, cierto, necesito lavar un tanque de tales dimensiones,",
  "y ese correo nosotros tenemos una base de datos, que ya la tengo, ya tengo 43 empresas,",
  "con correos que a esas 43 empresas nosotros le mandamos ese correo,",
  "diciendo que se abrió una oferta de trabajo por la lavada de tanque a la media tierra grata.",
  "El proveedor inmediatamente le dice, subo a su documentación,",
  "o sea, como que pueda entrar y subir esas cotizaciones.",
  "Lo puedo hacer como en un Excel?",
  "Sí, claro.",
  "Sí, eso se hace algo así, mira, esto ya lo he hecho, mira cómo funciona.",
  "Entonces yo hice este dashboard para una empresa de colecciones,",
  "entonces acá, digamos, quiero, digamos que esto le quiero subir,",
  "acá le hace el formato esperado, digamos, una cotización,",
  "que sea dentro de la misma página del conjunto,",
  "entonces acá te dice cómo que tiene que tener formato esperado,",
  "que es obligatorio, que no es obligatorio,",
  "le das acá en esto, te abre acá y le mandamos una plantilla,",
];

const largo: TranscriptSegment[] = LARGO.map((text, n) =>
  seg(4 + n * 4, 4 + n * 4 + 3.6, "SPEAKER_01", text, "Hablante 2"),
);

/** Turnos cortos: tres voces alternando, el caso opuesto. */
const TURNOS: Array<[string, string, string]> = [
  ["SPEAKER_00", "Ana Ruiz", "¿Y eso lo tenemos que hacer antes del viernes?"],
  ["SPEAKER_01", "Hablante 2", "Sí, antes del viernes."],
  ["SPEAKER_02", "Carlos Díaz", "Yo lo puedo mirar mañana por la mañana."],
  ["SPEAKER_00", "Ana Ruiz", "Perfecto."],
  ["SPEAKER_01", "Hablante 2", "Vale, entonces lo dejamos así y el viernes lo revisamos con el resto del equipo, que si no se nos junta todo."],
  ["SPEAKER_02", "Carlos Díaz", "De acuerdo."],
];

const turnos: TranscriptSegment[] = TURNOS.map(([label, name, text], n) =>
  seg(92 + n * 5, 92 + n * 5 + 4, label, text, name),
);

const SEGMENTS = [...largo, ...turnos];
const ULTIMO_DEL_LARGO = largo[largo.length - 1];
const PRIMERO_DEL_LARGO = largo[0];
const MEDIO_DEL_LARGO = largo[8];

/** Las cuatro pestañas del área real, para poder cambiarlas y ver si el audio sigue. */
const TABS = ["transcript", "resumen", "reportes", "evidencia"] as const;

function Harness() {
  const [focusedAt, setFocusedAt] = useState<number | null>(null);
  const [seeks, setSeeks] = useState<number[]>([]);
  // El MISMO reparto que MeetingWorkspace: la preferencia y el playhead viven aquí,
  // fuera de la vista, para que sobrevivan al cambio de pestaña.
  const [tab, setTab] = useState<(typeof TABS)[number]>("transcript");
  const [follow, setFollow] = useState(false);
  const [playhead, setPlayhead] = useState(0);
  const [at, setAt] = useState(0);

  // El "reproductor": registra a qué segundo se le pidió saltar. Es lo que hay que
  // poder comprobar de un clic — que llega el tiempo del SEGMENTO, no el del bloque.
  const onSeek = (s: number) => {
    setSeeks((prev) => [...prev, s]);
    setFocusedAt(s);
    setAt(s);
  };

  const meeting = { transcript: SEGMENTS } as unknown as MeetingDetail;
  const ultimo = seeks[seeks.length - 1];

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2 text-[0.8125rem]">
        <button type="button" data-test="jump-first" onClick={() => setFocusedAt(PRIMERO_DEL_LARGO.at)}
          className="rounded-md border border-line-strong px-2 py-1">saltar al 1.º del bloque largo</button>
        <button type="button" data-test="jump-middle" onClick={() => setFocusedAt(MEDIO_DEL_LARGO.at)}
          className="rounded-md border border-line-strong px-2 py-1">al del medio</button>
        <button type="button" data-test="jump-last" onClick={() => setFocusedAt(ULTIMO_DEL_LARGO.at)}
          className="rounded-md border border-line-strong px-2 py-1">al ÚLTIMO del bloque largo</button>
        <span data-test="seek-readout" className="u-mono text-faint">
          último seek: {ultimo === undefined ? "—" : `${ultimo}s`} · total {seeks.length}
        </span>
      </div>
      {/* Las pestañas, con el MISMO patrón que el área real: el contenido cambia y el
          reproductor NO se desmonta. */}
      <div className="flex items-center gap-1 text-[0.8125rem]">
        {TABS.map((t) => (
          <button key={t} type="button" data-test={`tab-${t}`} onClick={() => setTab(t)}
            className={`rounded-md px-2 py-1 ${tab === t ? "bg-ink text-ink-fg" : "border border-line-strong"}`}>
            {t}
          </button>
        ))}
        <span data-test="follow-readout" className="u-mono ml-2 text-faint">
          follow: {String(follow)} · playhead: {playhead.toFixed(1)}s · tab: {tab}
        </span>
      </div>

      {/* El scroller: el mismo contrato que la tarjeta real (min-h-0 + overflow-y-auto),
          con altura fija para que haya algo que desplazar. */}
      <div data-test="scroller" className="h-[420px] min-h-0 overflow-y-auto rounded-xl border border-line bg-surface">
        <div className="mx-auto w-full max-w-[68.75rem] px-6">
          {tab === "transcript" ? (
            <Transcript
              meeting={meeting}
              focusedAt={focusedAt}
              onSeek={onSeek}
              follow={follow}
              playhead={playhead}
              onFollowChange={setFollow}
            />
          ) : (
            <p data-test="otra-pestaña" className="p-6 text-sm text-muted">Contenido de «{tab}»</p>
          )}
        </div>
      </div>

      {/* UNA sola instancia, fuera del conmutador de pestañas — igual que en el área
          real después del arreglo. Sólo cambian sus props. */}
      <div data-test="player">
        <AudioPlayer
          meetingId="harness"
          durationSeconds={130}
          src="/w3-tone.wav"
          startAt={at}
          speakers={[]}
          onTimeChange={setPlayhead}
          density={tab === "transcript" ? "dock" : "compact"}
          variant={tab === "transcript" ? "waveform" : "bar"}
        />
      </div>
    </div>
  );
}

const host = document.getElementById("root");
if (host) createRoot(host).render(<Harness />);

"use client";

import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { MeetingWorkspace } from "../components/reuniones/MeetingWorkspace";
import { MeetingDeletionProvider } from "../components/reuniones/MeetingDeletion";
import type { MeetingDetail, TranscriptSegment } from "../lib/meetingsData";

/**
 * ARNÉS DEL DOCK FLOTANTE — el workspace COMPLETO, con audio que suena.
 *
 * Lo que hay que comprobar aquí no se puede comprobar leyendo el código: que el
 * `<audio>` sea uno solo, que cambiar de pestaña cuatro veces no lo pause, que
 * `currentTime` y la velocidad sobrevivan, que compactar no lo remonte y que el
 * dock no se mueva al desplazar. Todo eso son EFECTOS en un navegador.
 *
 * ── Por qué un WAV sintético y no la grabación real ────────────────────────
 *
 * Dos razones, y ninguna es comodidad. Las credenciales de R2 viven sólo en
 * Railway, así que en local no hay forma de firmar el audio normalizado. Y
 * aunque la hubiera, meter una reunión privada en capturas de pantalla que van a
 * un informe sería exactamente lo que no se debe hacer. El elemento de audio, el
 * `currentTime`, la velocidad y los eventos son idénticos con cualquier fichero:
 * lo que se prueba es el reproductor, no el contenido.
 *
 * Fuera de Next: `next/link` y `next/navigation` se sustituyen por stubs en el
 * empaquetado. El middleware manda a `/login` todo lo que no esté en su lista
 * pública, y no se toca la puerta de la aplicación para poder probar el salón.
 */

const stamp = (s: number) =>
  `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

let n = 0;
function seg(at: number, endsAt: number, speaker: string, initials: string, text: string): TranscriptSegment {
  n += 1;
  return {
    index: n,
    at,
    endsAt,
    stamp: stamp(at),
    speaker,
    initials,
    text,
    speakerLabel: `SPEAKER_0${initials === "A" ? 0 : 1}`,
    cited: false,
    overlap: false,
    speakerUncertain: false,
  } as unknown as TranscriptSegment;
}

/** Suficientes intervenciones para que el transcript SCROLLEE de verdad. */
const transcript: TranscriptSegment[] = [];
const FRASES = [
  "Empecemos por el estado del índice de búsqueda.",
  "La reindexación tarda unos cuarenta minutos con el volumen actual.",
  "Claro.",
  "Propongo moverlo a la ventana de mantenimiento del viernes.",
  "Eso nos deja sin búsqueda durante ese rato, hay que avisar.",
  "De acuerdo, lo anuncio yo en el canal general.",
  "¿Y el plan si falla a mitad?",
  "Se puede volver al índice anterior, que se conserva una semana.",
  "Entonces el riesgo real es la ventana, no la pérdida de datos.",
  "Exacto.",
];
for (let i = 0; i < 40; i += 1) {
  const at = i * 6;
  transcript.push(
    seg(at, at + 5, i % 2 === 0 ? "Ana" : "Bruno", i % 2 === 0 ? "A" : "B", FRASES[i % FRASES.length]),
  );
}

const meeting = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "Reunión sintética · arnés del reproductor",
  when: "hoy, 10:30",
  duration: "4:00",
  durationSeconds: 240,
  participants: [
    { initials: "A", name: "Ana", role: "Producto", share: 55 },
    { initials: "B", name: "Bruno", role: "Infraestructura", share: 45 },
  ],
  extraParticipants: 0,
  // `done` es el kind real; no existe "ready". Con uno inventado `statusFace`
  // devolvía undefined y el workspace reventaba al leer `.tone`.
  status: { kind: "done" },
  tasks: null,
  reports: null,
  updated: "hace un momento",
  transcript,
  evidence: [],
  reportList: [],
  summary: {
    executive: "Se revisó el estado del índice y se acordó migrarlo el viernes.",
    highlights: [],
    themes: [],
    findings: [],
    // El caso del defecto real: `owner` y la etiqueta de fecha llegaron como la
    // CADENA "null" desde el proveedor. La pantalla debe escribir «Sin
    // responsable» y «Sin fecha», no la palabra.
    nextSteps: [
      {
        id: "s0",
        text: "Anunciar la ventana de mantenimiento",
        owner: "null",
        ownerInitials: "N",
        due: { label: "null", state: "scheduled" },
        evidence: { initials: "A", stamp: "0:30", at: 30 },
        state: "todo",
      },
      {
        id: "s1",
        text: "Confirmar el plan de vuelta atrás",
        owner: null,
        ownerInitials: null,
        due: null,
        evidence: { initials: "B", stamp: "0:42", at: 42 },
        state: "todo",
      },
    ],
  },
  analysis: null,
  isTestFixture: true,
  deletionState: "live",
} as unknown as MeetingDetail;

function App() {
  const [key] = useState(0);
  const m = useMemo(() => meeting, []);
  return (
    // CON BARRA LATERAL. Sin ella el panel está centrado en la ventana y el
    // desalineamiento del dock no se puede ver: era exactamente el caso que
    // fallaba en staging, donde el centro de la ventana no es el del panel.
    <div className="flex h-screen" key={key}>
      <aside className="hidden w-[17rem] shrink-0 border-r border-line bg-surface sm:block" aria-hidden />
      <div className="flex min-w-0 flex-1 flex-col p-3">
      <MeetingDeletionProvider clientId="22222222-2222-4222-8222-222222222222" canDelete>
      <MeetingWorkspace
          meeting={m}
          // El arnés existe para el DOCK. Sin plantillas ni reportes, la pestaña
          // Reportes muestra su estado vacío, que es lo correcto aquí: lo que
          // hay que poder ver es que el reproductor no se mueve al cambiar de
          // pestaña, y para eso la pestaña sólo tiene que renderizar.
          clientName="Cliente de prueba"
          templates={[]}
          reports={[]}
          canEditTemplates={false}
          clientId="22222222-2222-4222-8222-222222222222"
          backHref="#"
          audioState="ready"
          // Un WAV de verdad, servido junto al HTML. Suena.
          audioSrc="./tono.wav"
        />
      </MeetingDeletionProvider>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);

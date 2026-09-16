/**
 * ARNÉS DE COMPROBACIÓN VISUAL DEL TRANSCRIPT.
 *
 *   cd web && npx tsx tools/renderTranscriptCheck.tsx <ruta-al-css> > salida.html
 *
 * Renderiza el componente `Transcript` REAL con react-dom/server contra tres
 * escenarios fijos, y escribe un HTML estático. No es una imitación del markup: si el
 * JSX cambia, esto cambia con él, que es la única forma de que la comprobación no
 * envejezca en silencio.
 *
 * Tres escenarios, uno por cosa que hay que poder ver:
 *   A · una intervención LARGA con los segmentos cortos que produce Whisper — el caso
 *       que se leía como un log, con una cabecera cada renglón;
 *   B · conversación con TURNOS CORTOS de tres voces — el caso opuesto, donde cada
 *       cabecera sí tiene que aparecer;
 *   C · el mismo A con un segmento del medio ENFOCADO — comprueba que el bloque lleva
 *       `data-block-focused` (el objetivo del desplazamiento) y que se resalta el
 *       segmento exacto, no el párrafo entero.
 *
 * El CSS se pasa como argumento porque sale del build (`web/.next/static/css/*.css`):
 * usar el compilado de verdad es lo que hace que las medidas —columna de lectura,
 * interlineado— sean las que verá el usuario y no las que yo creo que puse.
 *
 * Por qué `Transcript` está exportado: por esto. No tiene otro consumidor.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { Transcript } from "../components/reuniones/MeetingWorkspace";
import type { MeetingDetail, TranscriptSegment } from "../lib/meetingsData";

let i = 0;
const stamp = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
function seg(at: number, endsAt: number, label: string, text: string, name: string): TranscriptSegment {
  i += 1;
  return { index: i, at, endsAt, stamp: stamp(at), speakerLabel: label, speaker: name,
           initials: name.split(" ").map((w) => w[0]).join("").slice(0, 2), text };
}

// ESCENARIO A · una intervención larga, con los segmentos cortos de Whisper que se
// veían en la captura (una frase por segmento, 3-4 s cada uno).
const largo = [
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
const a: TranscriptSegment[] = largo.map((text, n) => seg(572 + n * 4, 572 + n * 4 + 3.6, "SPEAKER_01", text, "Hablante 2"));

// ESCENARIO B · conversación con turnos cortos: tres voces alternando.
const turnos: Array<[string, string, string]> = [
  ["SPEAKER_00", "Ana Ruiz", "¿Y eso lo tenemos que hacer antes del viernes?"],
  ["SPEAKER_01", "Hablante 2", "Sí, antes del viernes."],
  ["SPEAKER_02", "Carlos Díaz", "Yo lo puedo mirar mañana por la mañana."],
  ["SPEAKER_00", "Ana Ruiz", "Perfecto."],
  ["SPEAKER_01", "Hablante 2", "Vale, entonces lo dejamos así y el viernes lo revisamos con el resto del equipo, que si no se nos junta todo."],
  ["SPEAKER_02", "Carlos Díaz", "De acuerdo."],
];
const b: TranscriptSegment[] = turnos.map(([label, name, text], n) => seg(60 + n * 5, 60 + n * 5 + 4, label, text, name));

const shell = (title: string, segments: TranscriptSegment[], focusedAt: number | null = null) => {
  const meeting = { transcript: segments } as unknown as MeetingDetail;
  const html = renderToStaticMarkup(
    createElement(Transcript, { meeting, focusedAt, onSeek: () => {} }),
  );
  return `<section style="margin-bottom:3rem"><h2 style="font:600 13px system-ui;color:#888;padding:0 1rem 0.5rem">${title}</h2>${html}</section>`;
};

const css = process.argv[2];
process.stdout.write(`<!doctype html><html lang="es"><head><meta charset="utf-8">
<title>Transcript · comprobación visual</title><link rel="stylesheet" href="${css}">
</head><body class="bg-background"><div class="mx-auto w-full max-w-[68.75rem] bg-surface px-6 py-6">
${shell("A · una intervención larga (21 segmentos de Whisper de una sola voz)", a)}
${shell("B · conversación con turnos cortos (tres voces alternando)", b)}
${shell("C · salto a un segmento del medio de la intervención larga", a, a[8].at)}
</div></body></html>`);

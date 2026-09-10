import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import {
  MIN_WORDS_PER_SPLIT,
  alignSegments,
  parseTranscriptArtifact,
} from '../../src/meetings/artifacts.js';
import type { DiarizationTurn, TranscriptSegment, TranscriptWord } from '../../src/meetings/artifacts.js';

/**
 * La atribución de hablante AL TEXTO.
 *
 * Lo que se afirma no es que la diarización acierte —eso se mide contra el oído, fuera
 * de aquí— sino que, DADOS unos turnos, el texto se reparte donde de verdad cambia la
 * voz, que no se parte por proporción de caracteres, y que un artefacto v1 sin
 * palabras sigue comportándose exactamente como antes.
 */

function turn(startSec: number, endSec: number, speaker: string): DiarizationTurn {
  return { startSec, endSec, speaker };
}
function word(startSec: number, endSec: number, text: string): TranscriptWord {
  return { startSec, endSec, text };
}
function segment(
  index: number,
  startSec: number,
  endSec: number,
  text: string,
  words?: TranscriptWord[],
): TranscriptSegment {
  return { index, startSec, endSec, text, confidence: null, ...(words ? { words } : {}) };
}

// ── v1: nada cambia ───────────────────────────────────────────────────────────

test('sin palabras (v1) el segmento no se parte y conserva sus tiempos', () => {
  const segments = [segment(0, 0.96, 10.72, 'Bueno, ¿y qué te gustaría almorzar? No sé.')];
  const turns = [turn(0.96, 4.0, 'SPEAKER_00'), turn(5.0, 10.72, 'SPEAKER_01')];

  const { segments: out } = alignSegments(segments, turns);

  assert.equal(out.length, 1, 'un segmento entra, un segmento sale');
  assert.equal(out[0].startSec, 0.96);
  assert.equal(out[0].endSec, 10.72);
  // 5,72 s de SPEAKER_01 contra 3,04 de SPEAKER_00: gana el mayor solape, como siempre.
  assert.equal(out[0].speakerLabel, 'SPEAKER_01');
  assert.equal(out[0].overlap, true, 'y queda marcado como mezclado');
});

test('sin diarización, todo queda sin etiqueta y sin reparto', () => {
  const segments = [segment(0, 0, 5, 'hola', [word(0, 1, 'hola')])];
  const { segments: out, talkSharePct } = alignSegments(segments, null);
  assert.equal(out[0].speakerLabel, null);
  assert.deepEqual(talkSharePct, {});
});

// ── v2: el caso real ──────────────────────────────────────────────────────────

test('el segmento que contiene a dos personas se parte en frontera de palabra', () => {
  // Reproduce el segmento 0,96–10,72 de la reunión de prueba: la pregunta es de una
  // voz y la respuesta de la otra, y por mayor solape el bloque entero se iba a quien
  // decía la SEGUNDA mitad.
  const words = [
    word(0.96, 1.52, 'Bueno,'), word(1.8, 2.02, ' ¿y'), word(2.02, 2.12, ' qué'),
    word(2.12, 2.4, ' te'), word(2.4, 3.02, ' gustaría'), word(3.02, 3.94, ' almorzar?'),
    word(5.02, 5.46, ' No'), word(5.46, 6.3, ' sé.'), word(7.9, 8.46, ' Podríamos'),
    word(8.46, 9.14, ' comer'), word(9.14, 10.72, ' pollo.'),
  ];
  const segments = [segment(0, 0.96, 10.72, 'Bueno, ¿y qué te gustaría almorzar? No sé. Podríamos comer pollo.', words)];
  const turns = [turn(0.96, 3.94, 'SPEAKER_00'), turn(5.02, 10.72, 'SPEAKER_01')];

  const { segments: out } = alignSegments(segments, turns);

  assert.equal(out.length, 2, 'dos voces, dos bloques');
  assert.equal(out[0].speakerLabel, 'SPEAKER_00');
  assert.equal(out[0].text, 'Bueno, ¿y qué te gustaría almorzar?');
  assert.deepEqual([out[0].startSec, out[0].endSec], [0.96, 3.94], 'tiempos de las palabras, no inventados');
  assert.equal(out[1].speakerLabel, 'SPEAKER_01');
  assert.equal(out[1].text, 'No sé. Podríamos comer pollo.');
  assert.deepEqual([out[1].startSec, out[1].endSec], [5.02, 10.72]);
});

test('el texto se parte por TIEMPO de palabra, nunca por proporción de caracteres', () => {
  // Una primera intervención larguísima y una segunda de tres palabras cortas. Partir
  // por proporción de caracteres pondría la frontera cerca del medio del texto; por
  // tiempo cae donde cambia la voz, que es al final.
  const words = [
    word(0, 1, 'palabra'), word(1, 2, ' larguísima'), word(2, 3, ' interminable'),
    word(3, 4, ' verdaderamente'), word(4, 5, ' extensa'), word(5, 6, ' innecesariamente'),
    word(9, 9.3, ' sí'), word(9.3, 9.6, ' no'), word(9.6, 10, ' ya'),
  ];
  const segments = [segment(0, 0, 10, 'x', words)];
  const turns = [turn(0, 6, 'A'), turn(9, 10, 'B')];

  const { segments: out } = alignSegments(segments, turns);

  assert.equal(out.length, 2);
  assert.equal(out[0].text.split(' ').length, 6, 'las seis primeras van juntas');
  assert.equal(out[1].text, 'sí no ya');
});

// ── la guarda ─────────────────────────────────────────────────────────────────

test('un tramo por debajo de la guarda no abre bloque: se absorbe', () => {
  assert.equal(MIN_WORDS_PER_SPLIT, 3);
  // «y no» son dos palabras del otro hablante en mitad de una frase — fluctuación del
  // diarizador. Emitirlo partiría la frase en tres bloques ilegibles.
  const words = [
    word(0, 1, 'No,'), word(1, 2, ' pero'), word(2, 3, ' es'), word(3, 4, ' que'),
    word(4, 5, ' pollo'), word(5, 6, ' comí'), word(6, 7, ' el'), word(7, 8, ' lunes'),
    word(8, 8.2, ' y'), word(8.2, 8.4, ' no'),
    word(8.4, 9, ' quiero'), word(9, 10, ' más.'),
  ];
  const texto = 'No, pero es que pollo comí el lunes y no quiero más.';
  const segments = [segment(0, 0, 10, texto, words)];
  const turns = [turn(0, 8, 'A'), turn(8, 8.4, 'B'), turn(8.4, 10, 'A')];

  const { segments: out } = alignSegments(segments, turns);

  assert.equal(out.length, 1, 'no se parte por dos palabras sueltas');
  assert.equal(out[0].speakerLabel, 'A');
  // Al no partirse, se emite el segmento ORIGINAL: su texto tal cual vino, con su
  // puntuación y sus espacios, y sus tiempos. No una reconstrucción desde las palabras.
  assert.equal(out[0].text, texto, 'el texto original, no una reconstrucción');
  assert.deepEqual([out[0].startSec, out[0].endSec], [0, 10], 'y los tiempos originales');
});

test('un tramo que SÍ llega a la guarda sí abre bloque, aunque dure poco', () => {
  // Tres palabras en medio segundo son una intervención real. Un suelo de DURACIÓN se
  // las tragaría, y por eso no hay suelo de duración.
  const words = [
    word(0, 1, 'uno'), word(1, 2, ' dos'), word(2, 3, ' tres'), word(3, 4, ' cuatro'),
    word(4, 4.2, ' sí'), word(4.2, 4.4, ' claro'), word(4.4, 4.5, ' vale'),
    word(5, 6, ' seguimos'), word(6, 7, ' entonces'), word(7, 8, ' ahora'),
  ];
  const segments = [segment(0, 0, 8, 'x', words)];
  const turns = [turn(0, 4, 'A'), turn(4, 4.5, 'B'), turn(5, 8, 'A')];

  const { segments: out } = alignSegments(segments, turns);

  assert.equal(out.length, 3);
  assert.deepEqual(out.map((s) => s.speakerLabel), ['A', 'B', 'A']);
  assert.equal(out[1].text, 'sí claro vale');
  assert.equal(Math.round((out[1].endSec - out[1].startSec) * 10) / 10, 0.5, 'medio segundo, y cuenta');
});

test('al absorber, dos tramos vecinos con la misma etiqueta se funden en uno', () => {
  // A(3) · B(1) · A(3) · C(3). La B suelta se absorbe y deja dos tramos «A» pegados,
  // que NO deben salir como dos bloques con la misma cabecera.
  const words = [
    word(0, 1, 'a'), word(1, 2, ' b'), word(2, 3, ' c'),
    word(3, 3.2, ' x'),
    word(4, 5, ' d'), word(5, 6, ' e'), word(6, 7, ' f'),
    word(8, 9, ' g'), word(9, 10, ' h'), word(10, 11, ' i'),
  ];
  const segments = [segment(0, 0, 11, 'a b c x d e f g h i', words)];
  const turns = [turn(0, 3, 'A'), turn(3, 3.2, 'B'), turn(4, 7, 'A'), turn(8, 11, 'C')];

  const { segments: out } = alignSegments(segments, turns);

  assert.equal(out.length, 2, 'no quedan dos bloques «A» seguidos');
  assert.deepEqual(out.map((s) => s.speakerLabel), ['A', 'C']);
  assert.equal(out[0].text, 'a b c x d e f', 'la B absorbida no pierde su palabra');
  assert.equal(out[1].text, 'g h i');
});

// ── invariantes de la ingesta ─────────────────────────────────────────────────

test('los índices salen densos desde 0 aunque se partan segmentos', () => {
  // Tres palabras por voz en cada segmento: las dos partes superan la guarda, así que
  // los dos segmentos se parten y el resultado son cuatro bloques.
  const mk = (i: number, base: number) =>
    segment(i, base, base + 6, 'a b c d e f', [
      word(base, base + 1, 'a'), word(base + 1, base + 2, ' b'), word(base + 2, base + 3, ' c'),
      word(base + 3, base + 4, ' d'), word(base + 4, base + 5, ' e'), word(base + 5, base + 6, ' f'),
    ]);
  const segments = [mk(0, 0), mk(1, 10)];
  const turns = [
    turn(0, 3, 'A'), turn(3, 6, 'B'),
    turn(10, 13, 'A'), turn(13, 16, 'B'),
  ];

  const { segments: out } = alignSegments(segments, turns);

  assert.equal(out.length, 4, 'los dos segmentos se partieron');
  assert.deepEqual(out.map((s) => s.speakerLabel), ['A', 'B', 'A', 'B']);
  assert.deepEqual(out.map((s) => s.index), [0, 1, 2, 3], 'densos y desde 0');
});

test('el reparto se calcula sobre los TURNOS, así que partir no lo mueve', () => {
  const words = [
    word(0, 1, 'a'), word(1, 2, ' b'), word(2, 3, ' c'),
    word(6, 7, ' d'), word(7, 8, ' e'), word(8, 9, ' f'),
  ];
  const turns = [turn(0, 3, 'A'), turn(6, 9, 'B')];

  const conPalabras = alignSegments([segment(0, 0, 9, 'a b c d e f', words)], turns);
  const sinPalabras = alignSegments([segment(0, 0, 9, 'a b c d e f')], turns);

  assert.equal(conPalabras.segments.length, 2);
  assert.equal(sinPalabras.segments.length, 1);
  assert.deepEqual(conPalabras.talkSharePct, sinPalabras.talkSharePct, 'el reparto no depende del troceo');
  assert.deepEqual(conPalabras.talkSharePct, { A: 50, B: 50 });
});

// ── el contrato del artefacto ─────────────────────────────────────────────────

function ndjson(lines: object[]): Buffer {
  return Buffer.from(lines.map((line) => JSON.stringify(line)).join('\n'), 'utf8');
}
const head = (version: number, count: number) => ({
  schema: 'meetings.transcript',
  schema_version: version,
  language: 'es',
  duration_seconds: 10,
  model: 'medium',
  segment_count: count,
});

test('un artefacto v2 con palabras se lee, y uno v1 sin ellas también', () => {
  const v2 = parseTranscriptArtifact(ndjson([
    head(2, 1),
    { i: 0, start: 0, end: 2, text: 'hola mundo', words: [{ start: 0, end: 1, word: 'hola' }, { start: 1, end: 2, word: ' mundo' }] },
  ]));
  assert.equal(v2.header.schemaVersion, 2);
  assert.equal(v2.segments[0].words?.length, 2);

  const v1 = parseTranscriptArtifact(ndjson([head(1, 1), { i: 0, start: 0, end: 2, text: 'hola mundo' }]));
  assert.equal(v1.segments[0].words, undefined, 'ausente, no una lista vacía');
});

test('gzip sigue funcionando con v2', () => {
  const parsed = parseTranscriptArtifact(gzipSync(ndjson([
    head(2, 1),
    { i: 0, start: 0, end: 1, text: 'hola', words: [{ start: 0, end: 1, word: 'hola' }] },
  ])));
  assert.equal(parsed.segments[0].words?.[0].text, 'hola');
});

test('una palabra fuera de su segmento invalida el artefacto', () => {
  assert.throws(
    () => parseTranscriptArtifact(ndjson([
      head(2, 1),
      { i: 0, start: 0, end: 2, text: 'hola', words: [{ start: 0, end: 5, word: 'hola' }] },
    ])),
    /se sale del segmento/,
    'no se recorta en silencio: la alineación la usaría para decidir en un instante ajeno',
  );
});

test('palabras desordenadas o mal formadas invalidan el artefacto', () => {
  assert.throws(() => parseTranscriptArtifact(ndjson([
    head(2, 1),
    { i: 0, start: 0, end: 3, text: 'a b', words: [{ start: 2, end: 3, word: 'b' }, { start: 0, end: 1, word: 'a' }] },
  ])), /no va en orden/);

  assert.throws(() => parseTranscriptArtifact(ndjson([
    head(2, 1),
    { i: 0, start: 0, end: 3, text: 'a', words: [{ start: 0, end: 1 }] },
  ])), /debe ser texto/);
});

test('una schema_version que no conocemos se sigue rechazando', () => {
  assert.throws(
    () => parseTranscriptArtifact(ndjson([head(3, 1), { i: 0, start: 0, end: 1, text: 'x' }])),
    /no está soportada/,
  );
});

// ══════════════════════════════════════════════════════════════════════════════
//  LA GUARDA NO SE COME LAS INTERJECCIONES REALES
//
//  Es la objeción importante: la guarda existe para quitar picadillo, y «sí», «no» o
//  «claro» son exactamente lo que estamos intentando recuperar. Lo que sigue delimita
//  hasta dónde llega la guarda y qué pasa cuando llega.
// ══════════════════════════════════════════════════════════════════════════════

test('una interjección en SU PROPIO segmento no la toca la guarda: sobrevive entera', () => {
  // El caso habitual. Whisper trocea por pausas, y un «Claro.» viene rodeado de
  // silencio, así que se lleva su propio segmento. Ese segmento no tiene cambio de
  // hablante DENTRO, luego la guarda no interviene en absoluto.
  const segments = [
    segment(0, 0.0, 4.0, 'Entonces pedimos el sushi y ya está.', [
      word(0.0, 1.0, 'Entonces'), word(1.0, 2.0, ' pedimos'), word(2.0, 3.0, ' el'), word(3.0, 4.0, ' sushi'),
    ]),
    segment(1, 4.3, 4.8, 'Claro.', [word(4.3, 4.8, 'Claro.')]),
    segment(2, 5.2, 8.0, 'Vale, lo pido ahora mismo.', [
      word(5.2, 6.0, 'Vale,'), word(6.0, 7.0, ' lo'), word(7.0, 8.0, ' pido'),
    ]),
  ];
  const turns = [turn(0, 4.0, 'A'), turn(4.3, 4.8, 'B'), turn(5.2, 8.0, 'A')];

  const { segments: out } = alignSegments(segments, turns);

  assert.equal(out.length, 3, 'tres segmentos, tres bloques');
  assert.deepEqual(out.map((s) => s.speakerLabel), ['A', 'B', 'A']);
  assert.equal(out[1].text, 'Claro.', 'la interjección de UNA palabra conserva su bloque');
  assert.deepEqual([out[1].startSec, out[1].endSec], [4.3, 4.8], 'y sus tiempos originales');
  assert.equal(out[1].overlap, false, 'no hay nada mezclado en ella');
});

test('«sí», «no» y «claro» sueltos, cada uno en su segmento, sobreviven todos', () => {
  const respuestas = ['Sí.', 'No.', 'Claro.'];
  const segments: TranscriptSegment[] = [];
  const turns: DiarizationTurn[] = [];
  respuestas.forEach((texto, i) => {
    const base = i * 4;
    segments.push(segment(i * 2, base, base + 2, 'Y entonces qué hacemos aquí.', [
      word(base, base + 0.7, 'Y'), word(base + 0.7, base + 1.4, ' entonces'), word(base + 1.4, base + 2, ' qué'),
    ]));
    segments.push(segment(i * 2 + 1, base + 2.3, base + 2.6, texto, [word(base + 2.3, base + 2.6, texto)]));
    turns.push(turn(base, base + 2, 'A'), turn(base + 2.3, base + 2.6, 'B'));
  });

  const { segments: out } = alignSegments(segments, turns);

  const cortas = out.filter((s) => respuestas.includes(s.text));
  assert.equal(cortas.length, 3, 'las tres siguen ahí');
  assert.deepEqual(cortas.map((s) => s.speakerLabel), ['B', 'B', 'B'], 'y con su hablante');
});

test('una interjección de una palabra DENTRO de un segmento mixto se absorbe, pero el bloque lo declara', () => {
  // Aquí sí actúa la guarda, y es el caso que hay que mirar de frente: «claro» de otra
  // voz en mitad de la frase de alguien. Se absorbe —una palabra no abre bloque— pero
  // el bloque queda marcado `overlap`, que significa exactamente «aquí hay dos voces y
  // la etiqueta única es una simplificación». El texto NO se pierde.
  const words = [
    word(0, 1, 'Entonces'), word(1, 2, ' pedimos'), word(2, 3, ' el'), word(3, 4, ' sushi'),
    word(4.1, 4.5, ' claro'),
    word(4.6, 5.5, ' y'), word(5.5, 6.5, ' lo'), word(6.5, 7.5, ' pido'),
  ];
  const segments = [segment(0, 0, 7.5, 'Entonces pedimos el sushi claro y lo pido', words)];
  const turns = [turn(0, 4, 'A'), turn(4.1, 4.5, 'B'), turn(4.6, 7.5, 'A')];

  const { segments: out } = alignSegments(segments, turns);

  assert.equal(out.length, 1, 'no se parte por una palabra');
  assert.equal(out[0].speakerLabel, 'A');
  assert.ok(out[0].text.includes('claro'), 'la palabra sigue en el texto, no se descarta');
  assert.equal(
    out[0].overlap,
    true,
    'y el bloque declara que contiene otra voz — la guarda no borra en silencio',
  );
});

test('la marca de solape de una absorción NO depende del umbral del 25 %', () => {
  // 0,4 s de otra voz en un bloque de 20 s son el 2 %: muy por debajo de
  // OVERLAP_THRESHOLD. Aun así son dos personas, y el bloque tiene que decirlo.
  const words = [
    ...Array.from({ length: 10 }, (_, i) => word(i, i + 1, i === 0 ? 'palabra' : ' palabra')),
    word(10.1, 10.5, ' claro'),
    ...Array.from({ length: 9 }, (_, i) => word(11 + i, 12 + i, ' palabra')),
  ];
  const segments = [segment(0, 0, 20, 'texto largo', words)];
  const turns = [turn(0, 10, 'A'), turn(10.1, 10.5, 'B'), turn(11, 20, 'A')];

  const { segments: out } = alignSegments(segments, turns);

  assert.equal(out.length, 1);
  const proporcion = 0.4 / 20;
  assert.ok(proporcion < 0.25, 'la interjección está muy por debajo del umbral');
  assert.equal(out[0].overlap, true, 'y aun así el bloque queda marcado');
});

test('sólo se marca solape cuando lo absorbido era de OTRA voz', () => {
  // Un tramo corto del MISMO hablante (pasa tras una fusión) no introduce una segunda
  // voz, así que marcarlo sería decir que hay dos personas donde hay una.
  const words = [
    word(0, 1, 'a'), word(1, 2, ' b'), word(2, 3, ' c'), word(3, 4, ' d'),
    word(5, 6, ' e'), word(6, 7, ' f'), word(7, 8, ' g'),
  ];
  const segments = [segment(0, 0, 8, 'a b c d e f g', words)];
  const turns = [turn(0, 8, 'A')];

  const { segments: out } = alignSegments(segments, turns);

  assert.equal(out.length, 1);
  assert.equal(out[0].overlap, false, 'una sola voz, sin marca');
});

test('si un segmento se parte en varios, la marca va SÓLO en el bloque que absorbió', () => {
  const words = [
    // Bloque de A, limpio.
    word(0, 1, 'uno'), word(1, 2, ' dos'), word(2, 3, ' tres'),
    // Bloque de B que absorbe una palabra de C.
    word(4, 5, ' cuatro'), word(5, 6, ' cinco'), word(6, 7, ' seis'),
    word(7.1, 7.4, ' ya'),
    word(7.5, 8.5, ' siete'),
  ];
  const segments = [segment(0, 0, 8.5, 'x', words)];
  const turns = [turn(0, 3, 'A'), turn(4, 7, 'B'), turn(7.1, 7.4, 'C'), turn(7.5, 8.5, 'B')];

  const { segments: out } = alignSegments(segments, turns);

  assert.equal(out.length, 2);
  assert.deepEqual(out.map((s) => s.speakerLabel), ['A', 'B']);
  assert.equal(out[0].overlap, false, 'el bloque limpio no se marca');
  assert.equal(out[1].overlap, true, 'el que absorbió, sí');
});

// ══════════════════════════════════════════════════════════════════════════════
//  ARTEFACTOS ANTIGUOS: SIGUEN FUNCIONANDO, Y NO SE INVENTAN TIEMPOS
// ══════════════════════════════════════════════════════════════════════════════

test('un transcript v1 completo se alinea igual que antes de que esto existiera', () => {
  const segments = [
    segment(0, 0, 5, 'primero'),
    segment(1, 5, 10, 'segundo'),
    segment(2, 10, 15, 'tercero'),
  ];
  const turns = [turn(0, 5, 'A'), turn(5, 10, 'B'), turn(10, 15, 'A')];

  const { segments: out, talkSharePct } = alignSegments(segments, turns);

  assert.equal(out.length, 3, 'ni un bloque más ni uno menos');
  assert.deepEqual(out.map((s) => s.speakerLabel), ['A', 'B', 'A']);
  assert.deepEqual(out.map((s) => [s.startSec, s.endSec]), [[0, 5], [5, 10], [10, 15]]);
  assert.deepEqual(out.map((s) => s.text), ['primero', 'segundo', 'tercero']);
  assert.deepEqual(out.map((s) => s.overlap), [false, false, false]);
  assert.deepEqual(talkSharePct, { A: 66.67, B: 33.33 });
});

test('sin palabras no se interpola NADA, ni cuando el segmento contiene dos voces', () => {
  // Este segmento tiene dos hablantes dentro y no trae palabras. La tentación sería
  // repartir el texto por proporción de tiempo o de caracteres. No se hace: se emite
  // un bloque con la etiqueta mayoritaria y marcado como mezclado.
  const segments = [segment(0, 0, 10, 'una frase de dos personas sin tiempos por palabra')];
  const turns = [turn(0, 4, 'A'), turn(4, 10, 'B')];

  const { segments: out } = alignSegments(segments, turns);

  assert.equal(out.length, 1, 'no se fabrica un segundo bloque sin datos para situarlo');
  assert.equal(out[0].text, 'una frase de dos personas sin tiempos por palabra', 'el texto, íntegro');
  assert.deepEqual([out[0].startSec, out[0].endSec], [0, 10], 'los tiempos, los del segmento');
  assert.equal(out[0].overlap, true, 'y se declara mezclado por el umbral, como siempre');
});

test('un artefacto MIXTO —unos segmentos con palabras y otros sin ellas— se maneja segmento a segmento', () => {
  // Puede pasar de verdad: whisper omite `words` en un segmento sin palabras
  // reconocibles. Cada segmento se trata con lo que tiene, no se degrada el lote entero.
  const segments = [
    segment(0, 0, 6, 'con palabras aquí dentro', [
      word(0, 1, 'con'), word(1, 2, ' palabras'), word(2, 3, ' aquí'),
      word(3.5, 4.2, ' aquí'), word(4.2, 5, ' dentro'), word(5, 6, ' vale'),
    ]),
    segment(1, 6.5, 12, 'sin palabras ninguna'),
  ];
  const turns = [turn(0, 3, 'A'), turn(3.5, 6, 'B'), turn(6.5, 12, 'A')];

  const { segments: out } = alignSegments(segments, turns);

  assert.equal(out.length, 3, 'el primero se parte en dos; el segundo no se toca');
  assert.deepEqual(out.map((s) => s.speakerLabel), ['A', 'B', 'A']);
  assert.deepEqual([out[2].startSec, out[2].endSec], [6.5, 12], 'el de v1 conserva sus tiempos');
  assert.equal(out[2].text, 'sin palabras ninguna');
  assert.deepEqual(out.map((s) => s.index), [0, 1, 2], 'y los índices siguen densos');
});

test('un `words` vacío se trata como ausente, no como «no hay palabras»', () => {
  const parsed = parseTranscriptArtifact(Buffer.from([
    JSON.stringify(head(2, 1)),
    JSON.stringify({ i: 0, start: 0, end: 2, text: 'hola', words: [] }),
  ].join('\n'), 'utf8'));
  assert.equal(parsed.segments[0].words, undefined);

  const { segments: out } = alignSegments(parsed.segments, [turn(0, 1, 'A'), turn(1, 2, 'B')]);
  assert.equal(out.length, 1, 'cae al camino de v1 en vez de partir con datos que no hay');
  assert.deepEqual([out[0].startSec, out[0].endSec], [0, 2]);
});

test('un segmento sin partir conserva sus tiempos aunque sus palabras empiecen más tarde', () => {
  // Whisper puede dar un segmento 0–5 cuya primera palabra empieza en 0,4. Si no se
  // parte, el bloque es el segmento: 0–5. Tomar el tiempo de la palabra movería la
  // frontera de una cita sin que nadie lo hubiera pedido.
  const segments = [segment(0, 0, 5, 'texto', [word(0.4, 1, 'texto'), word(1, 2, ' más'), word(2, 3, ' aún')])];
  const { segments: out } = alignSegments(segments, [turn(0, 5, 'A')]);
  assert.deepEqual([out[0].startSec, out[0].endSec], [0, 5], 'los del segmento, no los de la palabra');
  assert.equal(out[0].text, 'texto', 'y el texto original');
});

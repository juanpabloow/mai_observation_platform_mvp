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

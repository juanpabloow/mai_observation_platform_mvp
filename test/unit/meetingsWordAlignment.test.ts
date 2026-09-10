import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import {
  FIRM_COVERAGE,
  MIN_WORDS_FOR_FIRM_SPEAKER,
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
  const texto = 'palabra larguísima interminable verdaderamente extensa innecesariamente sí no ya';
  const segments = [segment(0, 0, 10, texto, words)];
  const turns = [turn(0, 6, 'A'), turn(9, 10, 'B')];

  const { segments: out } = alignSegments(segments, turns);

  assert.equal(out.length, 2);
  assert.equal(out[0].text.split(' ').length, 6, 'las seis primeras van juntas');
  assert.equal(out[1].text, 'sí no ya');
  assert.ok(
    out[0].text.length > out[1].text.length * 5,
    'por caracteres la frontera habría caído por el medio; por tiempo cae al final',
  );
});

// ── la guarda ─────────────────────────────────────────────────────────────────

test('un tramo corto de otro hablante SÍ abre bloque: la atribución no se sacrifica', () => {
  assert.equal(MIN_WORDS_FOR_FIRM_SPEAKER, 3);
  // «y no» son dos palabras que el diarizador da a otra voz en mitad de una frase.
  // Puede ser una interjección real o fluctuación: desde los tiempos no se distingue.
  // Lo que NO se hace es decidirlo cambiando quién dijo qué — se conserva la
  // atribución y se marca como tentativa.
  const words = [
    word(0, 1, 'No,'), word(1, 2, ' pero'), word(2, 3, ' es'), word(3, 4, ' que'),
    word(4, 5, ' pollo'), word(5, 6, ' comí'), word(6, 7, ' el'), word(7, 8, ' lunes'),
    word(8, 8.2, ' y'), word(8.2, 8.4, ' no'),
    word(8.4, 9, ' quiero'), word(9, 9.5, ' comer'), word(9.5, 10, ' más.'),
  ];
  const texto = 'No, pero es que pollo comí el lunes y no quiero comer más.';
  const segments = [segment(0, 0, 10, texto, words)];
  const turns = [turn(0, 8, 'A'), turn(8, 8.4, 'B'), turn(8.4, 10, 'A')];

  const { segments: out } = alignSegments(segments, turns);

  assert.equal(out.length, 3, 'tres bloques: la intervención corta conserva el suyo');
  assert.deepEqual(out.map((s) => s.speakerLabel), ['A', 'B', 'A']);
  assert.equal(out[1].text, 'y no', 'con su texto');
  assert.deepEqual([out[1].startSec, out[1].endSec], [8, 8.4], 'y sus tiempos');
  assert.equal(out[1].speakerUncertain, true, 'marcado como tentativo: dos palabras es poca evidencia');
  assert.equal(out[1].overlap, false, 'pero NO como solapamiento: no hay dos voces a la vez');
  assert.deepEqual(
    out.map((s) => s.speakerUncertain),
    [false, true, false],
    'sólo el corto: los de ocho y tres palabras son firmes',
  );
  assert.equal(plano(out.map((s) => s.text).join(' ')), plano(texto), 'y el texto entero sigue ahí');
});

test('«Claro» de otra voz DENTRO de un segmento mixto conserva su hablante', () => {
  // El caso que había que arreglar. Antes se absorbía en el vecino y «Claro» quedaba
  // atribuido a quien no lo dijo. Ahora conserva su hablante y sus tiempos, y sólo se
  // señala que la atribución es tentativa.
  const words = [
    word(0, 1, 'Entonces'), word(1, 2, ' pedimos'), word(2, 3, ' el'), word(3, 4, ' sushi'),
    word(4.1, 4.5, ' Claro'),
    word(4.6, 5.5, ' y'), word(5.5, 6.5, ' lo'), word(6.5, 7.5, ' pido'),
  ];
  const texto = 'Entonces pedimos el sushi Claro y lo pido';
  const segments = [segment(0, 0, 7.5, texto, words)];
  const turns = [turn(0, 4, 'A'), turn(4.1, 4.5, 'B'), turn(4.6, 7.5, 'A')];

  const { segments: out } = alignSegments(segments, turns);

  assert.equal(out.length, 3);
  const claro = out.find((s) => s.text === 'Claro');
  assert.ok(claro, '«Claro» tiene su propio bloque');
  assert.equal(claro.speakerLabel, 'B', 'Y SU HABLANTE: es quien lo dijo');
  assert.deepEqual([claro.startSec, claro.endSec], [4.1, 4.5], 'con sus tiempos, no los del vecino');
  assert.equal(claro.speakerUncertain, true, 'tentativo por ser una palabra');
  assert.equal(claro.overlap, false, 'la duda no se disfraza de solapamiento');
  assert.deepEqual(out.map((s) => s.speakerLabel), ['A', 'B', 'A']);
});

test('una intervención de tres palabras es FIRME, aunque dure medio segundo', () => {
  const words = [
    word(0, 1, 'uno'), word(1, 2, ' dos'), word(2, 3, ' tres'), word(3, 4, ' cuatro'),
    word(4, 4.2, ' sí'), word(4.2, 4.4, ' claro'), word(4.4, 4.5, ' vale'),
    word(5, 6, ' seguimos'), word(6, 7, ' entonces'), word(7, 8, ' ahora'),
  ];
  const texto = 'uno dos tres cuatro sí claro vale seguimos entonces ahora';
  const segments = [segment(0, 0, 8, texto, words)];
  const turns = [turn(0, 4, 'A'), turn(4, 4.5, 'B'), turn(5, 8, 'A')];

  const { segments: out } = alignSegments(segments, turns);

  assert.equal(out.length, 3);
  assert.equal(out[1].text, 'sí claro vale');
  assert.equal(out[1].speakerUncertain, false, 'tres palabras y cobertura plena: firme');
  assert.equal(Math.round((out[1].endSec - out[1].startSec) * 10) / 10, 0.5);
});

test('una atribución que descansa en una esquirla de solape se marca tentativa', () => {
  // Aquí la duda no es de muestra, es temporal de verdad: el turno ganador cubre menos
  // de FIRM_COVERAGE del bloque, así que la etiqueta se sostiene por poco.
  assert.equal(FIRM_COVERAGE, 0.6);
  const words = [
    word(0, 1, 'aaa'), word(1, 2, ' bbb'), word(2, 3, ' ccc'), word(3, 4, ' ddd'),
    word(4, 5, ' eee'), word(5, 6, ' fff'), word(6, 7, ' ggg'),
  ];
  const texto = 'aaa bbb ccc ddd eee fff ggg';
  const segments = [segment(0, 0, 7, texto, words)];
  // «A» sólo tiene turno en 0–1,2 y 3,9–4,1: las palabras del medio caen en silencio y
  // se quedan sin etiqueta, y el bloque de A cubre 0–4 con apenas 1,4 s de turno.
  const turns = [turn(0, 1.2, 'A'), turn(3.9, 4.1, 'A'), turn(4.2, 7, 'B')];

  const { segments: out } = alignSegments(segments, turns);

  const bloqueA = out.find((s) => s.speakerLabel === 'A');
  assert.ok(bloqueA);
  assert.ok(
    bloqueA.speakerUncertain,
    'cobertura fina: el turno de A no cubre la mayoría del bloque que lleva su nombre',
  );
});

test('un bloque puede tener DOS VOCES y una atribución firme a la vez', () => {
  // La prueba de que los dos campos son independientes y no uno disfrazado del otro.
  const segments = [segment(0, 0, 10, 'texto de un segmento sin palabras')];
  const turns = [turn(0, 10, 'A'), turn(2, 8, 'B')];

  const { segments: out } = alignSegments(segments, turns);

  assert.equal(out[0].speakerLabel, 'A', 'A cubre más');
  assert.equal(out[0].overlap, true, 'y B cubre bastante para que sean dos voces');
  assert.equal(out[0].speakerUncertain, false, 'pero la atribución no es dudosa: A cubre el bloque entero');
});

// ══════════════════════════════════════════════════════════════════════════════
//  NI SE PIERDE NI SE DUPLICA TEXTO
//
//  El texto de cada bloque se REBANA del original entre los desplazamientos de sus
//  tokens, así que los bloques son rangos disjuntos que lo cubren entero. Cuando las
//  palabras no se corresponden con el texto, no se parte — porque situar la frontera
//  exigiría saber dónde va lo que las palabras no cubren.
// ══════════════════════════════════════════════════════════════════════════════

/** Colapsa espacios, para comparar texto sin pelearse con los separadores. */
const plano = (value: string): string => value.replace(/\s+/g, ' ').trim();

test('la unión de los bloques es exactamente el texto original', () => {
  const words = [
    word(0, 1, '¿Qué'), word(1, 2, ' te'), word(2, 3, ' gustaría'), word(3, 4, ' almorzar?'),
    word(5, 6, ' No'), word(6, 7, ' sé,'), word(7, 8, ' podríamos'), word(8, 9, ' pollo.'),
  ];
  const texto = '¿Qué te gustaría almorzar? No sé, podríamos pollo.';
  const segments = [segment(0, 0, 9, texto, words)];
  const turns = [turn(0, 4.5, 'A'), turn(4.8, 9, 'B')];

  const { segments: out } = alignSegments(segments, turns);

  assert.equal(out.length, 2);
  assert.equal(plano(out.map((s) => s.text).join(' ')), plano(texto), 'ni una palabra de más ni de menos');
  // Y la puntuación es la del original, no una reconstrucción.
  assert.equal(out[0].text, '¿Qué te gustaría almorzar?');
  assert.equal(out[1].text, 'No sé, podríamos pollo.');
});

test('si `words` está INCOMPLETA no se parte, y el texto sale íntegro', () => {
  // Whisper puede omitir palabras. Aquí faltan las dos últimas del texto. Partir
  // exigiría saber a qué lado del cambio de hablante van, y no se sabe: se emite un
  // bloque con el texto ENTERO y se marca la atribución como tentativa.
  const words = [
    word(0, 1, 'Entonces'), word(1, 2, ' pedimos'), word(2, 3, ' sushi'),
    word(4, 5, ' y'), word(5, 6, ' lo'),
  ];
  const texto = 'Entonces pedimos sushi y lo confirmo ahora';
  const segments = [segment(0, 0, 8, texto, words)];
  const turns = [turn(0, 3.5, 'A'), turn(3.8, 8, 'B')];

  const { segments: out } = alignSegments(segments, turns);

  assert.equal(out.length, 1, 'no se parte con una correspondencia que no cuadra');
  assert.equal(out[0].text, texto, 'el texto ORIGINAL, íntegro: no se pierde «confirmo ahora»');
  assert.deepEqual([out[0].startSec, out[0].endSec], [0, 8], 'y los tiempos del segmento');
  assert.equal(
    out[0].speakerUncertain,
    true,
    'había un cambio de hablante que no se pudo situar, y eso se declara',
  );
});

test('si `words` no se corresponde con el texto aunque cuadre el número, tampoco se parte', () => {
  // El número coincide y los textos no. Un mapeo posicional rebanaría por donde no
  // toca, y saldría texto mezclado sin que nada lo delatara.
  const words = [
    word(0, 1, 'uno'), word(1, 2, ' dos'), word(2, 3, ' tres'), word(3, 4, ' cuatro'),
  ];
  const texto = 'alfa beta gamma delta';
  const segments = [segment(0, 0, 4, texto, words)];
  const turns = [turn(0, 2, 'A'), turn(2, 4, 'B')];

  const { segments: out } = alignSegments(segments, turns);

  assert.equal(out.length, 1);
  assert.equal(out[0].text, texto, 'íntegro');
  assert.equal(out[0].speakerUncertain, true);
});

test('el texto se conserva en un lote mixto, partiendo unos segmentos y no otros', () => {
  const completo = 'uno dos tres cuatro cinco seis';
  const incompleto = 'siete ocho nueve diez';
  const segments = [
    segment(0, 0, 6, completo, [
      word(0, 1, 'uno'), word(1, 2, ' dos'), word(2, 3, ' tres'),
      word(3, 4, ' cuatro'), word(4, 5, ' cinco'), word(5, 6, ' seis'),
    ]),
    // Sólo dos palabras para cuatro tokens: no se parte.
    segment(1, 7, 11, incompleto, [word(7, 8, 'siete'), word(8, 9, ' ocho')]),
    // Sin palabras: camino v1.
    segment(2, 12, 15, 'once doce trece'),
  ];
  const turns = [turn(0, 3, 'A'), turn(3, 6, 'B'), turn(7, 9, 'A'), turn(9, 11, 'B'), turn(12, 15, 'A')];

  const { segments: out } = alignSegments(segments, turns);

  assert.equal(
    plano(out.map((s) => s.text).join(' ')),
    plano([completo, incompleto, 'once doce trece'].join(' ')),
    'el texto de los tres segmentos, entero y en orden',
  );
  assert.deepEqual(out.map((s) => s.index), out.map((_, i) => i), 'índices densos');
  assert.equal(out.filter((s) => s.speakerUncertain).length, 1, 'sólo el incompleto queda tentativo');
});

test('ningún bloque comparte texto con otro: los rangos son disjuntos', () => {
  const texto = 'a b c d e f g h i j';
  const words = texto.split(' ').map((t, i) => word(i, i + 1, i === 0 ? t : ` ${t}`));
  const segments = [segment(0, 0, 10, texto, words)];
  // Turnos alternos palabra a palabra: el peor caso para duplicar o perder.
  const turns = Array.from({ length: 10 }, (_, i) => turn(i, i + 1, i % 2 === 0 ? 'A' : 'B'));

  const { segments: out } = alignSegments(segments, turns);

  assert.equal(out.length, 10, 'diez cambios, diez bloques: ninguno se absorbe');
  assert.deepEqual(out.map((s) => s.text), texto.split(' '));
  assert.equal(plano(out.map((s) => s.text).join(' ')), texto);
  assert.equal(
    out.every((s) => s.speakerUncertain),
    true,
    'todos de una palabra, así que todos tentativos — y todos con su hablante',
  );
  assert.deepEqual(
    out.map((s) => s.speakerLabel),
    ['A', 'B', 'A', 'B', 'A', 'B', 'A', 'B', 'A', 'B'],
  );
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


import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  MAX_BLOCK_SEC,
  PAUSE_BREAK_SEC,
  groupTranscript,
} from '../../web/lib/transcriptBlocks.js';
import type { TranscriptSegment } from '../../web/lib/meetingsData.js';

/**
 * La agrupación de intervenciones, probada como lo que es: una función pura.
 *
 * Lo que se afirma NO es que la pantalla quede más corta —eso se ve mirando— sino que
 * la agrupación no pierde nada y no junta lo que no debe. Una vista compacta que
 * mezcle dos hablantes es peor que la vista larga.
 */

let seq = 0;
function seg(
  at: number,
  endsAt: number,
  speakerLabel: string | null,
  text = 'texto',
  extra: Partial<TranscriptSegment> = {},
): TranscriptSegment {
  seq += 1;
  const name = speakerLabel === null ? 'Sin asignar' : `Hablante ${speakerLabel.slice(-1)}`;
  return {
    index: seq,
    at,
    endsAt,
    stamp: `00:${String(Math.floor(at)).padStart(2, '0')}`,
    speakerLabel,
    speaker: name,
    initials: speakerLabel === null ? '—' : name.slice(-1),
    text,
    ...extra,
  };
}

test('segmentos consecutivos del mismo hablante caen en UN bloque con una cabecera', () => {
  const segments = [
    seg(0, 3, 'SPEAKER_00'),
    seg(3, 6, 'SPEAKER_00'),
    seg(6, 9.5, 'SPEAKER_00'),
  ];
  const blocks = groupTranscript(segments);
  assert.equal(blocks.length, 1, 'una intervención, no tres filas');
  assert.equal(blocks[0].segments.length, 3);
  assert.equal(blocks[0].at, 0, 'el bloque empieza donde el primer segmento');
  assert.equal(blocks[0].endsAt, 9.5, 'y acaba donde el último');
  assert.equal(blocks[0].startedBy, 'first');
});

test('cambiar de hablante corta el bloque', () => {
  const blocks = groupTranscript([
    seg(0, 3, 'SPEAKER_00'),
    seg(3, 5, 'SPEAKER_01'),
    seg(5, 8, 'SPEAKER_00'),
  ]);
  assert.equal(blocks.length, 3);
  assert.deepEqual(blocks.map((b) => b.speakerLabel), ['SPEAKER_00', 'SPEAKER_01', 'SPEAKER_00']);
  assert.deepEqual(blocks.slice(1).map((b) => b.startedBy), ['speaker-change', 'speaker-change']);
});

test('una pausa significativa corta, aunque siga hablando el mismo', () => {
  const blocks = groupTranscript([
    seg(0, 4, 'SPEAKER_00'),
    // Justo por debajo del umbral: sigue siendo la misma intervención.
    seg(4 + PAUSE_BREAK_SEC - 0.1, 20, 'SPEAKER_00'),
  ]);
  assert.equal(blocks.length, 1, 'una respiración no es una intervención nueva');

  const cortado = groupTranscript([
    seg(0, 4, 'SPEAKER_00'),
    seg(4 + PAUSE_BREAK_SEC, 20, 'SPEAKER_00'),
  ]);
  assert.equal(cortado.length, 2);
  assert.equal(cortado[1].startedBy, 'pause');
  assert.equal(cortado[1].speakerLabel, 'SPEAKER_00', 'el hablante no cambia por partir');
});

test('un bloque demasiado largo se parte para poder leerlo, sin cambiar de hablante', () => {
  const segments: TranscriptSegment[] = [];
  for (let i = 0; i < 40; i += 1) segments.push(seg(i * 5, i * 5 + 5, 'SPEAKER_00'));
  const blocks = groupTranscript(segments);
  assert.ok(blocks.length > 1, 'un monólogo de 200 s no cabe en un solo bloque');
  for (const block of blocks) {
    assert.equal(block.speakerLabel, 'SPEAKER_00', 'todos los trozos son del mismo');
    assert.ok(
      block.endsAt - block.at <= MAX_BLOCK_SEC + 5,
      `bloque de ${block.endsAt - block.at}s excede el tope`,
    );
  }
  assert.deepEqual(blocks.slice(1).map((b) => b.startedBy), Array(blocks.length - 1).fill('length'));
});

test('LO QUE NO PUEDE PASAR: dos hablantes sin resolver no se juntan por compartir nombre', () => {
  // Los dos se pintan «Sin asignar» y su etiqueta es DISTINTA. Agrupar por el nombre
  // mostrado los metería en una intervención que nunca ocurrió.
  const blocks = groupTranscript([
    seg(0, 3, 'SPEAKER_02'),
    seg(3, 6, 'SPEAKER_03'),
  ]);
  assert.equal(blocks.length, 2, 'dos personas, dos bloques');
  assert.notEqual(blocks[0].speakerLabel, blocks[1].speakerLabel);
});

test('un segmento SIN etiqueta no se agrupa con nadie, ni con otro sin etiqueta', () => {
  // `null` significa «ningún turno de diarización solapó», no «el de antes». Suponer
  // que dos silencios seguidos son la misma voz sería inventar una atribución.
  const blocks = groupTranscript([
    seg(0, 3, 'SPEAKER_00'),
    seg(3, 5, null),
    seg(5, 7, null),
    seg(7, 9, 'SPEAKER_00'),
  ]);
  assert.equal(blocks.length, 4);
  assert.deepEqual(blocks.map((b) => b.segments.length), [1, 1, 1, 1]);
});

test('la agrupación NO pierde ni reordena ningún segmento, y conserva índices y tiempos', () => {
  const segments = [
    seg(0, 3, 'SPEAKER_00', 'uno'),
    seg(3, 6, 'SPEAKER_00', 'dos'),
    seg(6, 9, 'SPEAKER_01', 'tres'),
    seg(30, 33, 'SPEAKER_01', 'cuatro'),
    seg(33, 36, null, 'cinco'),
  ];
  const blocks = groupTranscript(segments);
  const aplanados = blocks.flatMap((b) => b.segments);

  assert.equal(aplanados.length, segments.length, 'ni uno de más ni uno de menos');
  assert.deepEqual(
    aplanados.map((s) => s.index),
    segments.map((s) => s.index),
    'mismos índices, en el mismo orden',
  );
  assert.deepEqual(
    aplanados.map((s) => [s.at, s.endsAt]),
    segments.map((s) => [s.at, s.endsAt]),
    'tiempos intactos: la reproducción y las citas apuntan al segmento',
  );
  assert.deepEqual(aplanados.map((s) => s.text), ['uno', 'dos', 'tres', 'cuatro', 'cinco']);
  // Y ningún bloque contiene dos etiquetas distintas.
  for (const block of blocks) {
    const etiquetas = new Set(block.segments.map((s) => s.speakerLabel));
    assert.equal(etiquetas.size, 1, `un bloque con ${etiquetas.size} etiquetas`);
  }
});

test('sin segmentos no hay bloques, y uno solo da un bloque', () => {
  assert.deepEqual(groupTranscript([]), []);
  assert.equal(groupTranscript([seg(0, 2, 'SPEAKER_00')]).length, 1);
});

test('los umbrales son parámetros, no números escondidos en el render', () => {
  const segments = [seg(0, 4, 'SPEAKER_00'), seg(10, 14, 'SPEAKER_00')];
  assert.equal(groupTranscript(segments, { pauseBreakSec: 30 }).length, 1, 'umbral alto: un bloque');
  assert.equal(groupTranscript(segments, { pauseBreakSec: 2 }).length, 2, 'umbral bajo: dos');
});

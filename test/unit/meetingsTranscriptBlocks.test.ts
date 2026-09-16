import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  INTERVENTION_PAUSE_SEC,
  PARAGRAPH_MAX_CHARS,
  PARAGRAPH_PAUSE_SEC,
  PARAGRAPH_TARGET_CHARS,
  groupTranscript,
  segmentIndexAtTime,
  shouldSuspendFollow,
  targetScrollTop,
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
  assert.equal(blocks[0].paragraphs.length, 1, 'y UN párrafo: el texto fluye, no un renglón por segmento');
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
    seg(4 + INTERVENTION_PAUSE_SEC - 0.1, 20, 'SPEAKER_00'),
  ]);
  assert.equal(blocks.length, 1, 'una respiración no es una intervención nueva');

  const cortado = groupTranscript([
    seg(0, 4, 'SPEAKER_00'),
    seg(4 + INTERVENTION_PAUSE_SEC, 20, 'SPEAKER_00'),
  ]);
  assert.equal(cortado.length, 2);
  assert.equal(cortado[1].startedBy, 'pause');
  assert.equal(cortado[1].speakerLabel, 'SPEAKER_00', 'el hablante no cambia por partir');
});

test('una intervención larga NO repite cabecera: se parte en párrafos', async () => {
  // El tope de 90 s abría una cabecera nueva, o sea repetía «Hablante 2 · Identificar»
  // porque alguien llevaba 91 segundos hablando. Eso no informa de nada: es la misma
  // intervención. Ahora abre PÁRRAFO.
  const segments: TranscriptSegment[] = [];
  for (let i = 0; i < 40; i += 1) {
    // Frases que terminan en punto, para que el corte caiga en la puntuación que ya
    // está en el texto y no a media frase.
    segments.push(seg(i * 5, i * 5 + 5, 'SPEAKER_00', `Frase número ${i} con su cierre.`));
  }
  const blocks = groupTranscript(segments);
  assert.equal(blocks.length, 1, 'UNA intervención de 200 s, una sola cabecera');
  assert.ok(blocks[0].paragraphs.length > 1, 'partida en varios párrafos');
  assert.deepEqual(
    blocks[0].paragraphs.flatMap((p) => p.segments.map((s) => s.index)),
    segments.map((s) => s.index),
    'los párrafos cubren la intervención entera, en orden',
  );
  // Y cada corte cayó tras un cierre de frase, no a media frase.
  for (const paragraph of blocks[0].paragraphs.slice(1)) {
    assert.equal(paragraph.startedBy, 'sentence', `corte por ${paragraph.startedBy}`);
  }
});

test('el párrafo corta en la PUNTUACIÓN existente, no en un número exacto de caracteres', () => {
  // Un dictado sin puntuación hasta pasado el objetivo: no debe cortarse en el
  // objetivo, porque ahí no hay final de frase.
  const sinPunto: TranscriptSegment[] = [];
  for (let i = 0; i < 8; i += 1) sinPunto.push(seg(i * 3, i * 3 + 3, 'SPEAKER_00', 'y entonces seguimos hablando sin parar ni cerrar la frase'));
  const total = sinPunto.reduce((n, s) => n + s.text.length + 1, 0);
  assert.ok(total > PARAGRAPH_TARGET_CHARS, 'el caso tiene sentido: pasa del objetivo');
  assert.ok(total < PARAGRAPH_MAX_CHARS, 'pero no llega al tope duro');
  const blocks = groupTranscript(sinPunto);
  assert.equal(blocks[0].paragraphs.length, 1, 'sin punto donde cortar, no se corta');
});

test('el tope duro corta aunque no haya puntuación: un muro es peor que un corte', () => {
  const sinPunto: TranscriptSegment[] = [];
  for (let i = 0; i < 40; i += 1) sinPunto.push(seg(i * 3, i * 3 + 3, 'SPEAKER_00', 'y entonces seguimos hablando sin parar ni cerrar la frase'));
  const blocks = groupTranscript(sinPunto);
  assert.ok(blocks[0].paragraphs.length > 1, 'se corta igual');
  assert.ok(
    blocks[0].paragraphs.some((p) => p.startedBy === 'length'),
    'y consta que fue por el tope, no por puntuación',
  );
});

test('una pausa media abre párrafo; una pausa larga abre intervención', () => {
  const mediaPausa = groupTranscript([
    seg(0, 4, 'SPEAKER_00', 'Primera parte.'),
    seg(4 + PARAGRAPH_PAUSE_SEC, 20, 'SPEAKER_00', 'Segunda parte.'),
  ]);
  assert.equal(mediaPausa.length, 1, 'sigue siendo la misma intervención');
  assert.equal(mediaPausa[0].paragraphs.length, 2, 'pero en dos párrafos');
  assert.equal(mediaPausa[0].paragraphs[1].startedBy, 'pause');

  const pausaLarga = groupTranscript([
    seg(0, 4, 'SPEAKER_00', 'Primera parte.'),
    seg(4 + INTERVENTION_PAUSE_SEC, 20, 'SPEAKER_00', 'Segunda parte.'),
  ]);
  assert.equal(pausaLarga.length, 2, 'esta sí es otra intervención');
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
  // Y aplanando por PÁRRAFOS sale exactamente lo mismo: los dos niveles cubren el
  // transcript entero, sin duplicar ni perder un segmento.
  assert.deepEqual(
    blocks.flatMap((b) => b.paragraphs.flatMap((p) => p.segments.map((s) => s.index))),
    aplanados.map((s) => s.index),
    'párrafos y bloques cubren lo mismo',
  );

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
  assert.equal(groupTranscript(segments, { interventionPauseSec: 30 }).length, 1, 'umbral alto: un bloque');
  assert.equal(groupTranscript(segments, { interventionPauseSec: 2 }).length, 2, 'umbral bajo: dos');
  // Y el de párrafo, por separado.
  const uno = groupTranscript(segments, { interventionPauseSec: 30, paragraphPauseSec: 30 });
  assert.equal(uno[0].paragraphs.length, 1, 'sin corte de párrafo');
  const dos = groupTranscript(segments, { interventionPauseSec: 30, paragraphPauseSec: 1 });
  assert.equal(dos[0].paragraphs.length, 2, 'con corte de párrafo');
});

// ── El destino del desplazamiento, como aritmética pura ───────────────────────

test('el scroll prefiere la CABECERA cuando el segmento cabe desde ahí', () => {
  // Bloque a 1000, su segmento a 1100-1140, visor de 560: con la cabecera arriba
  // (1000 - 24 de margen = 976) el segmento queda a 124-164 del borde. Cabe.
  const top = targetScrollTop({
    viewHeight: 560, maxScroll: 5000, blockTop: 1000,
    segmentTop: 1100, segmentBottom: 1140, marginTop: 24,
  });
  assert.equal(top, 976, 'la cabecera, con su margen de scroll');
});

test('cuando el segmento NO cabe desde la cabecera, gana el SEGMENTO', () => {
  // El caso real: un segmento al final de una intervención larga. Con la cabecera
  // arriba (976) el segmento estaría a 1000 px del borde, cuatro pantallas más abajo.
  const top = targetScrollTop({
    viewHeight: 560, maxScroll: 5000, blockTop: 1000,
    segmentTop: 1976, segmentBottom: 2016, marginTop: 24,
  });
  assert.notEqual(top, 976, 'no se queda en la cabecera');
  // Centrado: 1976 - (560-40)/2 = 1716.
  assert.equal(top, 1716);
  // Y desde ahí el segmento SÍ está dentro del visor.
  assert.ok(1976 >= top && 2016 <= top + 560, 'el objetivo queda visible');
});

test('el destino nunca sale del rango de scroll posible', () => {
  assert.equal(
    targetScrollTop({ viewHeight: 560, maxScroll: 100, blockTop: 5000, segmentTop: 5000, segmentBottom: 5040, marginTop: 24 }),
    100,
    'no se pide más scroll del que hay',
  );
  assert.equal(
    targetScrollTop({ viewHeight: 560, maxScroll: 5000, blockTop: 10, segmentTop: 10, segmentBottom: 50, marginTop: 24 }),
    0,
    'ni negativo: un bloque casi arriba no empuja por encima del inicio',
  );
  assert.equal(
    targetScrollTop({ viewHeight: 560, maxScroll: 0, blockTop: 0, segmentTop: 0, segmentBottom: 40, marginTop: 24 }),
    0,
    'sin nada que desplazar, cero',
  );
});

test('un segmento MÁS ALTO que el visor se ancla a su inicio, no a un centro imposible', () => {
  const top = targetScrollTop({
    viewHeight: 200, maxScroll: 5000, blockTop: 1000,
    segmentTop: 1100, segmentBottom: 1600, marginTop: 24,
  });
  assert.equal(top, 1100, 'su inicio visible es lo mejor disponible');
});

// ── Qué segmento suena, para el seguimiento del audio ─────────────────────────

test('segmentIndexAtTime encuentra el segmento que cubre el segundo', () => {
  const segs = [
    seg(0, 4, 'SPEAKER_00', 'uno'),
    seg(4, 8, 'SPEAKER_00', 'dos'),
    seg(10, 14, 'SPEAKER_01', 'tres'),
  ];
  assert.equal(segmentIndexAtTime(segs, 0), 0, 'el borde inicial pertenece al segmento');
  assert.equal(segmentIndexAtTime(segs, 3.9), 0);
  assert.equal(segmentIndexAtTime(segs, 4), 1, 'el borde final NO: pertenece al siguiente');
  assert.equal(segmentIndexAtTime(segs, 12), 2);
  assert.equal(segmentIndexAtTime(segs, 9), null, 'un silencio no hereda el segmento anterior');
  assert.equal(segmentIndexAtTime(segs, 99), null, 'después del final, ninguno');
  assert.equal(segmentIndexAtTime([], 1), null, 'sin segmentos, ninguno');
});

test('segmentIndexAtTime es bisección: acierta en un transcript largo', () => {
  // 900 segmentos de 2 s = media hora. Se comprueba CADA uno en su punto medio, que
  // es lo que descubre un off-by-one en la bisección.
  const segs: TranscriptSegment[] = [];
  for (let i = 0; i < 900; i += 1) segs.push(seg(i * 2, i * 2 + 2, 'SPEAKER_00', `s${i}`));
  for (let i = 0; i < 900; i += 1) {
    assert.equal(segmentIndexAtTime(segs, i * 2 + 1), i, `medio del segmento ${i}`);
    assert.equal(segmentIndexAtTime(segs, i * 2), i, `inicio del segmento ${i}`);
  }
});

test('la supresión del scroll propio es por VENTANA, no por un evento', () => {
  const ahora = 1_000_000;
  // Dentro de la ventana: es el desplazamiento del propio seguimiento.
  assert.equal(shouldSuspendFollow(ahora, ahora + 400), false, 'no se suspende a sí mismo');
  // Una ventana cubre VARIOS eventos, que es lo que emite un scroll suave.
  assert.equal(shouldSuspendFollow(ahora + 100, ahora + 400), false, 'el segundo evento tampoco');
  assert.equal(shouldSuspendFollow(ahora + 399, ahora + 400), false, 'ni el último de la animación');
  // Fuera de la ventana: fue una persona.
  assert.equal(shouldSuspendFollow(ahora + 400, ahora + 400), true, 'justo al expirar, sí');
  assert.equal(shouldSuspendFollow(ahora + 5_000, ahora + 400), true, 'y mucho después, sí');
  // Sin ventana abierta (valor inicial), cualquier scroll es humano.
  assert.equal(shouldSuspendFollow(ahora, 0), true, 'sin desplazamiento propio en curso');
});

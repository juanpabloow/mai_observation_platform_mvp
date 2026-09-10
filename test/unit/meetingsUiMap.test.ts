import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { UiMeetingRow, UiSegment, UiSpeaker } from '../../src/meetings/uiRead.js';
import { headlineOf, transcribedLabelOf } from '../../web/lib/meetingsData.js';
import {
  EMPTY_SUMMARY,
  bytesLabel,
  confidenceLabel,
  initialsOf,
  participantsOf,
  reasonFor,
  relativeLabel,
  sourceOf,
  speakerNames,
  speakerTurnsOf,
  stamp,
  statusOf,
  toDetail,
  toListItem,
  transcriptOf,
  whenLabel,
} from '../../web/lib/meetingsMap.js';

/**
 * El mapeo del esquema a la pantalla de Reuniones.
 *
 * Es la capa que se equivoca en silencio: un estado mal derivado no lanza, sólo
 * pone la reunión en la faceta equivocada, y una fecha de subida presentada como
 * fecha de celebración no falla nunca — simplemente miente.
 *
 * La regla que estas pruebas defienden es una: **nada se inventa**. Lo que la
 * base dice NULL, la UI dice que no se sabe.
 */

const ROW: UiMeetingRow = {
  id: 'cc00c4cf-a69f-46a3-acf7-f22e90fed109',
  title: 'W-3 recorrido',
  sourceKind: 'file',
  startedAt: null,
  createdAt: '2026-09-10T00:34:08.448Z',
  updatedAt: '2026-09-10T02:26:22.379Z',
  mediaState: 'ready',
  transcriptState: 'ready',
  diarizationState: 'ready',
  analysisState: 'pending',
  cancelledAt: null,
  warnings: [],
  originalBytes: 1026007,
  durationSeconds: 119.59,
  segmentCount: 15,
  language: 'es',
  activeTranscriptId: 'a0b50364-8d89-41b1-9696-d4f046f4b61d',
  speakerCount: 2,
  speakers: [
    { label: 'SPEAKER_00', speakerId: 'f45c3730', displayName: null, talkSharePct: 98.1 },
    { label: 'SPEAKER_01', speakerId: '753e7833', displayName: null, talkSharePct: 1.9 },
  ],
  runningStage: null,
  runningProgressPct: null,
  failureCode: null,
};

const row = (over: Partial<UiMeetingRow> = {}): UiMeetingRow => ({ ...ROW, ...over });

const SPEAKERS: UiSpeaker[] = [
  { label: 'SPEAKER_00', speakerId: 'f45c3730', displayName: null, talkSharePct: 98.1 },
  { label: 'SPEAKER_01', speakerId: '753e7833', displayName: null, talkSharePct: 1.9 },
];

const segment = (over: Partial<UiSegment> = {}): UiSegment => ({
  index: 0,
  startSec: 0,
  endSec: 10.36,
  speakerLabel: 'SPEAKER_00',
  text: 'Entonces el objetivo de hoy…',
  overlap: false,
  confidence: null,
  ...over,
});

// ── Estado: las cuatro máquinas en uno ──────────────────────────────────────

test('una reunión con transcripción lista y hablantes está hecha', () => {
  assert.deepEqual(statusOf(row()), { kind: 'done' });
});

test('lista pero sin hablantes tiene su propio estado, no un fallo', () => {
  assert.deepEqual(statusOf(row({ speakerCount: 0 })), { kind: 'done-no-speakers' });
});

test('la etapa en curso se nombra, no se agrupa en «procesando»', () => {
  // `normalize` NO es «Subiendo»: los bytes ya están en R2. Mostrarlo así hacía
  // que una reunión recién subida dijera «Subiendo · 0 %» sin moverse.
  assert.deepEqual(statusOf(row({ transcriptState: 'running', runningStage: 'normalize' })), {
    kind: 'transcribing',
    percent: 0,
  });
  assert.deepEqual(
    statusOf(row({ transcriptState: 'running', runningStage: 'transcribe', runningProgressPct: 42 })),
    { kind: 'transcribing', percent: 42 },
  );
  assert.deepEqual(statusOf(row({ transcriptState: 'running', runningStage: 'diarize' })), {
    kind: 'diarizing',
    percent: 0,
  });
});

test('sin progreso reportado se muestra 0, no un porcentaje fingido', () => {
  // El worker de W-3 no emitió ni un evento `progress`. Una barra a la mitad que
  // no se mueve miente más que una a cero.
  const status = statusOf(row({ transcriptState: 'running', runningStage: 'transcribe' }));
  assert.equal(status.kind === 'transcribing' && status.percent, 0);
});

test('la cancelación gana sobre cualquier etapa que estuviera corriendo', () => {
  const status = statusOf(
    row({ cancelledAt: '2026-09-10T03:00:00Z', runningStage: 'transcribe', transcriptState: 'running' }),
  );
  assert.deepEqual(status, { kind: 'cancelled' });
});

test('un medio inválido es un fallo con motivo, aunque el pipeline no arrancara', () => {
  const status = statusOf(row({ mediaState: 'invalid', transcriptState: 'pending' }));
  assert.equal(status.kind, 'failed');
  assert.match(status.kind === 'failed' ? status.reason : '', /no se pudo procesar/i);
});

test('un fallo terminal lleva el motivo del código del worker', () => {
  const status = statusOf(
    row({ transcriptState: 'failed', failureCode: 'worker_error', runningStage: null }),
  );
  assert.deepEqual(status, { kind: 'failed', reason: 'Fallo interno del worker' });
});

test('un job reencolado NO se muestra como fallo: sigue en marcha', () => {
  // Este es el caso real de W-3: transcribe falló dos veces por libcublas y
  // volvió a la cola con failure_code puesto. Mostrarlo como «falló» habría
  // dicho que la reunión estaba perdida cuando le quedaba un intento.
  const status = statusOf(
    row({ transcriptState: 'running', runningStage: 'transcribe', failureCode: 'transcribe_failed' }),
  );
  assert.equal(status.kind, 'transcribing');
});

test('un código de fallo desconocido se muestra, no se traduce a «error»', () => {
  assert.equal(reasonFor('algo_nuevo_del_worker'), 'Fallo: algo_nuevo_del_worker');
  assert.equal(reasonFor(null), 'El procesamiento falló');
});

// ── Hablantes: «Hablante N», sin inventar nombres ni roles ──────────────────

test('sin nombre, se numeran por etiqueta y de forma estable', () => {
  const names = speakerNames(SPEAKERS);
  assert.equal(names.get('SPEAKER_00')?.name, 'Hablante 1');
  assert.equal(names.get('SPEAKER_01')?.name, 'Hablante 2');
  assert.equal(names.get('SPEAKER_00')?.identified, false);
});

test('el número NO depende de la cuota de tiempo', () => {
  // Si se ordenara por talk_share, volver a diarizar podría intercambiar
  // «Hablante 1» y «Hablante 2», y una cita guardada apuntaría a otra persona.
  const invertido = speakerNames([
    { label: 'SPEAKER_00', speakerId: 'a', displayName: null, talkSharePct: 1.9 },
    { label: 'SPEAKER_01', speakerId: 'b', displayName: null, talkSharePct: 98.1 },
  ]);
  assert.equal(invertido.get('SPEAKER_00')?.name, 'Hablante 1');
  assert.equal(invertido.get('SPEAKER_01')?.name, 'Hablante 2');
});

test('el orden de llegada tampoco cambia la numeración', () => {
  const alReves = speakerNames([...SPEAKERS].reverse());
  assert.equal(alReves.get('SPEAKER_00')?.name, 'Hablante 1');
  assert.equal(alReves.get('SPEAKER_01')?.name, 'Hablante 2');
});

test('un nombre real gana sobre el genérico', () => {
  const names = speakerNames([
    { label: 'SPEAKER_00', speakerId: 'a', displayName: 'María Vanegas', talkSharePct: 60 },
    { label: 'SPEAKER_01', speakerId: 'b', displayName: '   ', talkSharePct: 40 },
  ]);
  assert.equal(names.get('SPEAKER_00')?.name, 'María Vanegas');
  assert.equal(names.get('SPEAKER_00')?.identified, true);
  // Cadena en blanco no es un nombre.
  assert.equal(names.get('SPEAKER_01')?.name, 'Hablante 2');
  assert.equal(names.get('SPEAKER_01')?.identified, false);
});

test('las iniciales distinguen a los hablantes sin nombre entre sí', () => {
  assert.equal(initialsOf('Hablante 1'), 'H1');
  assert.equal(initialsOf('Hablante 2'), 'H2');
  assert.equal(initialsOf('María Vanegas'), 'MV');
  assert.equal(initialsOf('Ana'), 'AN');
});

test('el rol es null y NUNCA se inventa', () => {
  const participants = participantsOf(SPEAKERS);
  assert.equal(participants.length, 2);
  assert.deepEqual(participants.map((p) => p.role), [null, null]);
  assert.deepEqual(participants.map((p) => p.name), ['Hablante 1', 'Hablante 2']);
  assert.deepEqual(participants.map((p) => p.share), [98.1, 1.9]);
});

test('una cuota nula se conserva nula: la diarización no ha terminado', () => {
  const participants = participantsOf([
    { label: 'SPEAKER_00', speakerId: 'a', displayName: null, talkSharePct: null },
  ]);
  assert.equal(participants[0].share, null);
});

// ── Transcripción: las asignaciones reales ─────────────────────────────────

test('los 15 segmentos del recorrido real van todos al primer hablante', () => {
  // El segundo tiene el 1,90 % del tiempo y no es mayoría en ningún segmento.
  // Repartirlos «para que se vean los dos» sería inventar quién dijo qué.
  const segments = Array.from({ length: 15 }, (_, i) =>
    segment({ index: i, startSec: i * 8, endSec: i * 8 + 7.5 }),
  );
  const transcript = transcriptOf(segments, SPEAKERS);
  assert.equal(transcript.length, 15);
  assert.equal(new Set(transcript.map((t) => t.speaker)).size, 1);
  assert.equal(transcript[0].speaker, 'Hablante 1');
  assert.equal(transcript[0].initials, 'H1');
  assert.equal(transcript[0].unidentified, true);
});

test('un segmento sin etiqueta se marca sin asignar, no se le atribuye a nadie', () => {
  const transcript = transcriptOf([segment({ speakerLabel: null })], SPEAKERS);
  assert.equal(transcript[0].speaker, 'Sin asignar');
  assert.equal(transcript[0].initials, '—');
  assert.equal(transcript[0].unidentified, true);
});

test('un hablante identificado no se marca como sin identificar', () => {
  const transcript = transcriptOf([segment()], [
    { label: 'SPEAKER_00', speakerId: 'a', displayName: 'María Vanegas', talkSharePct: 98.1 },
  ]);
  assert.equal(transcript[0].speaker, 'María Vanegas');
  assert.equal(transcript[0].unidentified, undefined);
});

test('la marca de tiempo es el inicio del segmento, en mm:ss', () => {
  const transcript = transcriptOf([segment({ startSec: 105.76 })], SPEAKERS);
  assert.equal(transcript[0].at, 105.76);
  assert.equal(transcript[0].stamp, '1:46');
});

test('los turnos del reproductor son fracciones dentro de [0,1]', () => {
  const turns = speakerTurnsOf(
    [segment({ startSec: 0, endSec: 10 }), segment({ startSec: 110, endSec: 130 })],
    SPEAKERS,
    119.59,
  );
  assert.equal(turns.length, 2);
  assert.ok(turns.every((t) => t.from >= 0 && t.to <= 1 && t.from <= t.to));
  assert.equal(turns[0].name, 'Hablante 1');
});

test('sin duración no hay turnos, en vez de dividir por cero', () => {
  assert.deepEqual(speakerTurnsOf([segment()], SPEAKERS, 0), []);
});

// ── Nada inventado: confianza, fecha, rol, cifras ──────────────────────────

test('la confianza no se inventa cuando todos los segmentos la traen nula', () => {
  const segments = Array.from({ length: 15 }, (_, i) => segment({ index: i }));
  assert.equal(confidenceLabel(segments), 'No reportada');
});

test('y se promedia en cuanto exista', () => {
  assert.equal(confidenceLabel([segment({ confidence: 0.9 }), segment({ confidence: 0.8 })]), '85 %');
});

test('sin started_at se muestra la fecha de SUBIDA, dicha como tal', () => {
  const label = whenLabel(null, '2026-09-10T00:34:08.448Z');
  assert.match(label, /^Subida /, 'el prefijo es lo que evita afirmar una celebración');
  assert.match(label, /10 sep 2026/);
  assert.match(label, /00:34 UTC/);
});

test('la fecha NO depende de la zona horaria del servidor', () => {
  // Lo formatea un Server Component. Con getHours(), el mismo instante salía
  // «19:34» del día 9 en esta Mac y «00:34» del 10 en Railway. Se formatea en
  // UTC y se etiqueta, que es lo único correcto sin saber la zona del lector.
  const previo = process.env.TZ;
  try {
    process.env.TZ = 'America/Bogota';
    const bogota = whenLabel(null, '2026-09-10T00:34:08.448Z');
    process.env.TZ = 'Asia/Tokyo';
    const tokio = whenLabel(null, '2026-09-10T00:34:08.448Z');
    assert.equal(bogota, tokio);
    assert.match(bogota, /10 sep 2026 · 00:34 UTC/);
  } finally {
    if (previo === undefined) delete process.env.TZ;
    else process.env.TZ = previo;
  }
});

test('con started_at se muestra la celebración, sin prefijo', () => {
  const label = whenLabel('2026-03-04T15:00:00.000Z', '2026-09-10T00:34:08.448Z');
  assert.ok(!label.startsWith('Subida'));
  assert.match(label, /4 mar 2026/);
});

test('tareas e informes son null, no 0: no se cuenta lo que no existe', () => {
  const item = toListItem(row());
  assert.equal(item.tasks, null);
  assert.equal(item.reports, null);
});

test('el listado muestra avatares de verdad, no un guion', () => {
  const item = toListItem(row());
  assert.deepEqual(item.participants.map((p) => p.name), ['Hablante 1', 'Hablante 2']);
  assert.deepEqual(item.participants.map((p) => p.share), [98.1, 1.9]);
  assert.equal(item.extraParticipants, 0);
});

test('con más de tres hablantes, los demás van como «+N»', () => {
  const cinco = Array.from({ length: 5 }, (_, i) => ({
    label: `SPEAKER_0${i}`,
    speakerId: `id-${i}`,
    displayName: null,
    talkSharePct: 20,
  }));
  const item = toListItem(row({ speakers: cinco, speakerCount: 5 }));
  assert.equal(item.participants.length, 3);
  assert.equal(item.extraParticipants, 2);
});

test('sin hablantes, ni avatares ni «+0»', () => {
  const item = toListItem(row({ speakers: [], speakerCount: 0 }));
  assert.deepEqual(item.participants, []);
  assert.equal(item.extraParticipants, 0);
});

test('el resumen vacío es un objeto válido con todo vacío', () => {
  assert.equal(EMPTY_SUMMARY.executive, '');
  assert.deepEqual(EMPTY_SUMMARY.highlights, []);
  assert.deepEqual(EMPTY_SUMMARY.themes, []);
  assert.deepEqual(EMPTY_SUMMARY.findings, []);
  assert.deepEqual(EMPTY_SUMMARY.nextSteps, []);
});

// ── Formatos ──────────────────────────────────────────────────────────────

test('la duración se imprime mm:ss y h:mm:ss', () => {
  assert.equal(stamp(0), '0:00');
  assert.equal(stamp(119.59), '2:00');
  assert.equal(stamp(3725), '1:02:05');
});

test('los bytes, legibles, y «—» cuando no hay medio', () => {
  assert.equal(bytesLabel(1026007), '1002 KB');
  assert.equal(bytesLabel(null), '—');
  assert.equal(bytesLabel(512), '512 B');
});

test('el relativo no dice «hace -3 min» con relojes desfasados', () => {
  const label = relativeLabel('2026-09-10T02:26:22.379Z', new Date('2026-09-10T02:26:00.000Z'));
  assert.equal(label, 'hace instantes');
});

test('el origen «file» nombra lo que consta, no un nombre de fichero inventado', () => {
  const source = sourceOf(row());
  assert.equal(source.kind, 'file');
  assert.equal(source.kind === 'file' && source.filename, 'Audio original');
  assert.equal(source.kind === 'file' && source.size, '1002 KB');
});

// ── La conversión completa ────────────────────────────────────────────────

test('el detalle real: transcripción, hablantes y las tres pestañas vacías', () => {
  const segments = Array.from({ length: 15 }, (_, i) =>
    segment({ index: i, startSec: i * 8, endSec: i * 8 + 7.5 }),
  );
  const detail = toDetail({
    ...row(),
    whisperModel: 'medium',
    diarizationBackend: 'wespeaker',
    speakers: SPEAKERS,
    segments,
    hasPlayableAudio: true,
  });

  assert.equal(detail.transcript.length, 15);
  assert.equal(detail.participants.length, 2);
  assert.equal(detail.language, 'es');
  assert.equal(detail.segments, 15);
  assert.equal(detail.durationSeconds, 119.59);
  assert.equal(detail.confidence, 'No reportada');
  assert.deepEqual(detail.tags, []);
  assert.deepEqual(detail.reportList, []);
  assert.deepEqual(detail.evidence, []);
  assert.equal(detail.summary.executive, '');
  assert.equal(detail.isTestFixture, undefined, 'nada de esto es un fixture');
});

test('sin transcripción activa, el detalle no miente sobre la duración', () => {
  const detail = toDetail({
    ...row({ activeTranscriptId: null, durationSeconds: null, segmentCount: null, language: null }),
    whisperModel: null,
    diarizationBackend: null,
    speakers: [],
    segments: [],
    hasPlayableAudio: false,
  });
  assert.equal(detail.duration, null);
  assert.equal(detail.durationSeconds, 0);
  assert.equal(detail.language, '—');
  assert.deepEqual(detail.transcript, []);
});

// ── Las cifras de la cabecera ─────────────────────────────────────────────

test('la unidad la elige la magnitud, no una «h» fija', () => {
  // Con «h» fija, los dos minutos del recorrido de W-3 salían «0,0 h
  // transcritas», que se lee como un contador roto.
  assert.equal(transcribedLabelOf(0), '0 min');
  assert.equal(transcribedLabelOf(45), '45 s');
  assert.equal(transcribedLabelOf(119.59), '2 min');
  assert.equal(transcribedLabelOf(5040), '1,4 h');
});

test('la cabecera cuenta las filas reales y no cuenta lo que no existe', () => {
  const headline = headlineOf([
    toListItem(row()),
    toListItem(row({ id: 'b', transcriptState: 'running', runningStage: 'transcribe' })),
    toListItem(row({ id: 'c', transcriptState: 'failed', failureCode: 'worker_error' })),
  ]);
  assert.equal(headline.total, 3);
  assert.equal(headline.done, 1);
  assert.equal(headline.processing, 1);
  assert.equal(headline.attention, 1);
  assert.equal(headline.transcribedLabel, '2 min', 'sólo el audio con transcripción lista');
  assert.equal(headline.openTasks, null, 'no hay almacenamiento de tareas: null, no 0');
});

test('subiendo sólo cuando los bytes están en vuelo de verdad', () => {
  // media_state 'uploading' = el PUT está en marcha. Es el ÚNICO caso en que la
  // fila debe decir «Subiendo».
  assert.equal(
    statusOf(row({ mediaState: 'uploading', transcriptState: 'pending', runningStage: null })).kind,
    'uploading',
  );
  assert.equal(
    statusOf(row({ mediaState: 'pending', transcriptState: 'pending', runningStage: null })).kind,
    'uploading',
  );
  // Con el audio ya confirmado y normalize en cola, es transcripción en curso.
  assert.equal(
    statusOf(row({ mediaState: 'ready', transcriptState: 'pending', runningStage: 'normalize' })).kind,
    'transcribing',
  );
});

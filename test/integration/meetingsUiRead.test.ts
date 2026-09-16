import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { query } from '../../src/db/client.js';
import { FakePrivateStore } from '../../src/storage/fakePrivateStore.js';
import {
  getMeetingForUi,
  hasPlayableAudio,
  keyBelongsToMeeting,
  listMeetingsForUi,
  signMeetingAudio,
} from '../../src/meetings/uiRead.js';
import { cleanupTenant, closeDb } from './fixtures.js';

/**
 * Las lecturas de la pantalla de Reuniones, contra la base desechable.
 *
 * Lo que se persigue aquí no es que el SELECT devuelva filas —eso lo diría
 * cualquier prueba— sino la propiedad de la que depende todo el módulo: que
 * **un cliente no pueda leer nada de otro**, ni la lista, ni el texto, ni una
 * URL firmada del audio. Se prueba con dos tenants reales y consultas cruzadas
 * deliberadas, no con un mock del resolutor de ámbito: el ámbito ya se prueba en
 * `meetingsRoutes`, y lo que puede fallar aquí es un WHERE incompleto.
 */

const tenants: string[] = [];
after(async () => {
  for (const tenant of tenants) await cleanupTenant(tenant);
  await closeDb();
});

interface Scenario {
  readonly tenantId: string;
  readonly clientId: string;
  readonly meetingId: string;
  readonly runId: string;
  readonly transcriptId: string;
  readonly normalizedKey: string;
  readonly scope: { tenantId: string; clientId: string; userId: string | null; userLabel: string };
}

/**
 * Una reunión COMPLETA, con la forma exacta que dejó el recorrido de W-3:
 * original + normalizado, run cerrado, versión de transcript activa, quince
 * segmentos todos del primer hablante, y dos hablantes sin identificar con el
 * reparto 98,10 / 1,90.
 */
async function seedCompleteMeeting(title: string): Promise<Scenario> {
  const tenantId = randomUUID();
  const clientId = randomUUID();
  const meetingId = randomUUID();
  const runId = randomUUID();
  const transcriptId = randomUUID();
  const sha = (n: number) => String(n).repeat(64).slice(0, 64);
  const prefix = `t/${tenantId}/c/${clientId}/m/${meetingId}`;
  const normalizedKey = `${prefix}/r/${runId}/normalized/a1/audio.wav`;

  tenants.push(tenantId);
  await query(`INSERT INTO tenants (id, name) VALUES ($1, $2)`, [tenantId, `T ${title}`]);
  await query(`INSERT INTO clients (id, tenant_id, name, is_default) VALUES ($1, $2, $3, false)`, [
    clientId, tenantId, `C ${title}`,
  ]);
  await query(
    `INSERT INTO client_modules (tenant_id, client_id, module_key, enabled) VALUES ($1,$2,'meetings',true)`,
    [tenantId, clientId],
  );
  await query(
    // `active_transcript_id` se pone DESPUÉS: tiene FK contra
    // meeting_transcript_versions, que todavía no existe.
    `INSERT INTO meetings (id, tenant_id, client_id, title, source_kind, idempotency_key,
                           media_state, transcript_state, diarization_state)
     VALUES ($1,$2,$3,$4,'file',$5,'ready','ready','ready')`,
    [meetingId, tenantId, clientId, title, `idem-${meetingId.slice(0, 8)}`],
  );
  await query(
    `INSERT INTO meeting_media (tenant_id, client_id, meeting_id, role, storage_key, bytes,
                                checksum_sha256, content_type)
     VALUES ($1,$2,$3,'original',$4,1026007,$5,'audio/wav')`,
    [tenantId, clientId, meetingId, `${prefix}/original/source`, sha(1)],
  );
  await query(
    `INSERT INTO meeting_processing_runs (id, tenant_id, client_id, meeting_id, run_number, trigger,
                                          started_at, finished_at, outcome)
     VALUES ($1,$2,$3,$4,1,'initial',now(),now(),'succeeded')`,
    [runId, tenantId, clientId, meetingId],
  );
  await query(
    `INSERT INTO meeting_media (tenant_id, client_id, meeting_id, run_id, role, storage_key, bytes,
                                checksum_sha256, content_type, duration_seconds, sample_rate,
                                channels, codec, probe_ok)
     VALUES ($1,$2,$3,$4,'normalized',$5,3827132,$6,'audio/wav',119.595,16000,1,'pcm_s16le',true)`,
    [tenantId, clientId, meetingId, runId, normalizedKey, sha(2)],
  );
  await query(
    `INSERT INTO meeting_transcript_versions (id, tenant_id, client_id, meeting_id, run_id,
                                              whisper_model, diarization_backend, language,
                                              duration_seconds, segment_count, schema_version, metrics)
     VALUES ($1,$2,$3,$4,$5,'medium','wespeaker','es',119.590,15,1,$6::jsonb)`,
    [transcriptId, tenantId, clientId, meetingId, runId,
     JSON.stringify({ device: 'cuda', compute_type: 'int8_float16', speaker_count: 2 })],
  );
  await query(`UPDATE meetings SET active_transcript_id = $2 WHERE id = $1`, [meetingId, transcriptId]);
  for (let i = 0; i < 15; i += 1) {
    await query(
      `INSERT INTO meeting_segments (tenant_id, client_id, transcript_id, segment_index,
                                     start_sec, end_sec, speaker_label, text)
       VALUES ($1,$2,$3,$4,$5,$6,'SPEAKER_00',$7)`,
      [tenantId, clientId, transcriptId, i, i * 8, i * 8 + 7.5, `Frase ${i} de ${title}`],
    );
  }
  const speakerIds = [randomUUID(), randomUUID()];
  for (const id of speakerIds) {
    await query(
      `INSERT INTO meeting_speakers (id, tenant_id, client_id, meeting_id) VALUES ($1,$2,$3,$4)`,
      [id, tenantId, clientId, meetingId],
    );
  }
  await query(
    `INSERT INTO meeting_transcript_speakers (transcript_id, speaker_label, tenant_id, client_id,
                                              meeting_id, speaker_id, talk_share_pct)
     VALUES ($1,'SPEAKER_00',$2,$3,$4,$5,98.10), ($1,'SPEAKER_01',$2,$3,$4,$6,1.90)`,
    [transcriptId, tenantId, clientId, meetingId, speakerIds[0], speakerIds[1]],
  );

  return {
    tenantId, clientId, meetingId, runId, transcriptId, normalizedKey,
    scope: { tenantId, clientId, userId: null, userLabel: 'prueba' },
  };
}

// ── Aislamiento: la propiedad de la que depende el módulo ───────────────────

test('el listado de un cliente NO incluye reuniones de otro tenant', async () => {
  const a = await seedCompleteMeeting('Alfa');
  const b = await seedCompleteMeeting('Beta');

  const listaA = await listMeetingsForUi(a.scope);
  const listaB = await listMeetingsForUi(b.scope);

  assert.deepEqual(listaA.map((row) => row.title), ['Alfa']);
  assert.deepEqual(listaB.map((row) => row.title), ['Beta']);
  assert.ok(!listaA.some((row) => row.id === b.meetingId));
});

test('el detalle de una reunión ajena es null, con el uuid correcto', async () => {
  const a = await seedCompleteMeeting('Alfa2');
  const b = await seedCompleteMeeting('Beta2');
  // El uuid EXISTE. Lo que no existe es dentro de este ámbito.
  assert.equal(await getMeetingForUi(a.scope, b.meetingId), null);
  assert.equal(await getMeetingForUi(b.scope, a.meetingId), null);
  assert.notEqual(await getMeetingForUi(a.scope, a.meetingId), null);
});

test('el mismo tenant con OTRO cliente tampoco la ve', async () => {
  const a = await seedCompleteMeeting('Alfa3');
  const otroCliente = randomUUID();
  await query(`INSERT INTO clients (id, tenant_id, name, is_default) VALUES ($1,$2,'Otro',false)`, [
    otroCliente, a.tenantId,
  ]);
  const cruzado = { ...a.scope, clientId: otroCliente };
  assert.equal(await getMeetingForUi(cruzado, a.meetingId), null);
  assert.deepEqual(await listMeetingsForUi(cruzado), []);
});

// ── La transcripción, que es lo que no se podía leer ───────────────────────

test('el detalle trae los quince segmentos, en orden, con su texto', async () => {
  const a = await seedCompleteMeeting('Texto');
  const detail = (await getMeetingForUi(a.scope, a.meetingId))!;

  assert.equal(detail.segments.length, 15);
  assert.deepEqual(detail.segments.map((s) => s.index), [...Array(15).keys()]);
  assert.equal(detail.segments[0].text, 'Frase 0 de Texto');
  assert.equal(detail.segments[14].text, 'Frase 14 de Texto');
  // numeric llega como string del driver y se convierte aquí, no en la UI.
  assert.equal(typeof detail.segments[0].startSec, 'number');
  assert.equal(detail.segments[0].startSec, 0);
  assert.equal(detail.segmentCount, 15);
  assert.equal(detail.language, 'es');
  assert.equal(detail.whisperModel, 'medium');
  assert.equal(detail.diarizationBackend, 'wespeaker');
});

test('los hablantes llegan con su cuota y sin nombre inventado', async () => {
  const a = await seedCompleteMeeting('Hablantes');
  const detail = (await getMeetingForUi(a.scope, a.meetingId))!;

  assert.equal(detail.speakers.length, 2);
  assert.deepEqual(detail.speakers.map((s) => s.label), ['SPEAKER_00', 'SPEAKER_01']);
  assert.deepEqual(detail.speakers.map((s) => s.displayName), [null, null]);
  assert.deepEqual(detail.speakers.map((s) => s.talkSharePct), [98.1, 1.9]);
  assert.ok(detail.speakers.every((s) => s.speakerId !== null));
});

test('el listado cuenta los hablantes sin cargar el texto de cada fila', async () => {
  const a = await seedCompleteMeeting('Conteo');
  const [row] = await listMeetingsForUi(a.scope);
  assert.equal(row.speakerCount, 2);
  assert.equal(row.segmentCount, 15);
  assert.equal(row.durationSeconds, 119.59);
  assert.equal(row.originalBytes, 1026007);
});

test('una reunión sin transcripción no inventa duración ni idioma', async () => {
  const a = await seedCompleteMeeting('Vacía');
  await query(`UPDATE meetings SET active_transcript_id = NULL, transcript_state='pending' WHERE id=$1`, [
    a.meetingId,
  ]);
  const detail = (await getMeetingForUi(a.scope, a.meetingId))!;
  assert.equal(detail.durationSeconds, null);
  assert.equal(detail.segmentCount, null);
  assert.equal(detail.language, null);
  assert.deepEqual(detail.segments, []);
  assert.deepEqual(detail.speakers, []);
});

// ── El audio: tenant, cliente, reunión y la clave ─────────────────────────

const store = () => new FakePrivateStore({ getTtlSeconds: 600 });

test('firma una URL temporal del NORMALIZADO, no del original', async () => {
  const a = await seedCompleteMeeting('Audio');
  const media = await signMeetingAudio(a.scope, a.meetingId, { store: store() });

  assert.ok(media.url.length > 0);
  assert.equal(media.bytes, 3827132, 'el tamaño es el del normalizado');
  assert.equal(media.durationSeconds, 119.595);
  assert.ok(new Date(media.expiresAt).getTime() > Date.now(), 'caduca en el futuro');
  // El objeto firmado es el del run de la versión activa.
  assert.ok(media.url.includes(encodeURIComponent(a.normalizedKey)) || media.url.includes(a.runId));
});

test('el audio de otra reunión, de otro tenant o de otro cliente: 404', async () => {
  const a = await seedCompleteMeeting('AudioA');
  const b = await seedCompleteMeeting('AudioB');
  const noExiste = randomUUID();

  for (const [scope, meetingId, caso] of [
    [a.scope, b.meetingId, 'reunión de otro tenant'],
    [b.scope, a.meetingId, 'la inversa'],
    [a.scope, noExiste, 'uuid inventado'],
    [{ ...a.scope, clientId: b.clientId }, a.meetingId, 'cliente cruzado'],
  ] as const) {
    await assert.rejects(
      () => signMeetingAudio(scope, meetingId, { store: store() }),
      (error: Error & { code?: string }) => error.code === 'not_found',
      caso,
    );
  }
});

test('sin normalizado vivo no se firma nada, aunque la reunión exista', async () => {
  const a = await seedCompleteMeeting('SinAudio');
  await query(`UPDATE meeting_media SET deleted_at = now() WHERE meeting_id=$1 AND role='normalized'`, [
    a.meetingId,
  ]);
  assert.equal(await hasPlayableAudio(a.scope, a.meetingId), false);
  await assert.rejects(
    () => signMeetingAudio(a.scope, a.meetingId, { store: store() }),
    (error: Error & { code?: string }) => error.code === 'not_found',
  );
});

test('una clave que no pertenece a la reunión NO se firma', async () => {
  // El cinturón sobre el tirante. La clave la deriva el servidor y no debería
  // poder apuntar fuera; si algún día una mal escrita entra en la tabla, esto
  // se niega en vez de emitir una URL a un objeto ajeno.
  //
  // El prefijo ajeno se FABRICA en vez de copiarse de otra reunión real:
  // `meeting_media_key_unique` es único en toda la tabla, así que copiar la
  // clave de otra fila es imposible por esquema — que es una capa de defensa
  // más, y por eso hay que forzar el caso de otro modo para probar la guarda.
  const a = await seedCompleteMeeting('ClaveMala');
  const ajeno = { t: randomUUID(), c: randomUUID(), m: randomUUID(), r: randomUUID() };
  await query(`UPDATE meeting_media SET storage_key=$2 WHERE meeting_id=$1 AND role='normalized'`, [
    a.meetingId,
    `t/${ajeno.t}/c/${ajeno.c}/m/${ajeno.m}/r/${ajeno.r}/normalized/a1/audio.wav`,
  ]);
  await assert.rejects(
    () => signMeetingAudio(a.scope, a.meetingId, { store: store() }),
    (error: Error & { code?: string }) => error.code === 'not_found',
  );
});

test('la clave del audio es única en toda la tabla, no sólo por reunión', async () => {
  // Descubierto al escribir la prueba anterior. Es una defensa real: dos filas
  // no pueden apuntar al mismo objeto de R2, así que una reunión no puede
  // «adoptar» el audio de otra ni por error de programación.
  const a = await seedCompleteMeeting('Unica');
  const b = await seedCompleteMeeting('UnicaB');
  await assert.rejects(
    () =>
      query(`UPDATE meeting_media SET storage_key=$2 WHERE meeting_id=$1 AND role='normalized'`, [
        a.meetingId,
        b.normalizedKey,
      ]),
    /meeting_media_key_unique/,
  );
});

test('keyBelongsToMeeting exige los tres identificadores', () => {
  const t = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const c = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const m = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  const otro = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
  assert.equal(keyBelongsToMeeting(`t/${t}/c/${c}/m/${m}/original/source`, t, c, m), true);
  assert.equal(keyBelongsToMeeting(`t/${otro}/c/${c}/m/${m}/original/source`, t, c, m), false);
  assert.equal(keyBelongsToMeeting(`t/${t}/c/${otro}/m/${m}/original/source`, t, c, m), false);
  assert.equal(keyBelongsToMeeting(`t/${t}/c/${c}/m/${otro}/original/source`, t, c, m), false);
  // Un prefijo que sólo COINCIDE parcialmente no vale: sin la barra final,
  // `m/{uuid}` haría match con `m/{uuid}xyz`.
  assert.equal(keyBelongsToMeeting(`t/${t}/c/${c}/m/${m}extra/original/source`, t, c, m), false);
});

test('hasPlayableAudio no depende del estado del pipeline sino del fichero', async () => {
  const a = await seedCompleteMeeting('Disponible');
  assert.equal(await hasPlayableAudio(a.scope, a.meetingId), true);
  // Transcripción fallida pero audio convertido: sí se puede escuchar.
  await query(`UPDATE meetings SET transcript_state='failed' WHERE id=$1`, [a.meetingId]);
  assert.equal(await hasPlayableAudio(a.scope, a.meetingId), true);
  // Y de otro ámbito, no.
  const b = await seedCompleteMeeting('Ajena');
  assert.equal(await hasPlayableAudio(b.scope, a.meetingId), false);
});

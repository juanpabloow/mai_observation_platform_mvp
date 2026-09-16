import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { query } from '../../src/db/client.js';
import { cleanupTenant, closeDb } from './fixtures.js';
import { FakePrivateStore } from '../../src/storage/fakePrivateStore.js';
import { DEFAULT_MEDIA_LIMITS } from '../../src/meetings/mediaLimits.js';
import { RateLimiter } from '../../src/meetings/rateLimit.js';
import { MeetingsApiError } from '../../src/meetings/errors.js';
import {
  authenticateWorkerToken,
  mintWorkerToken,
  type WorkerIdentity,
} from '../../src/db/repositories/meetings/credentials.js';
import * as deletionRepo from '../../src/db/repositories/meetings/deletion.js';
import { meetingPrefix } from '../../src/meetings/storageKeys.js';
import {
  purgeDeletedMeetings,
  purgeMeeting,
  requestMeetingDeletion,
  type DeletionScope,
} from '../../src/meetings/deletion.js';
import { runPurgeCycle } from '../../src/meetings/maintenance.js';
import { getMeetingForUi, listMeetingsForUi } from '../../src/meetings/uiRead.js';
import {
  claim,
  createMeeting,
  resultInit,
  uploadComplete,
  uploadInit,
  type MeetingsServiceDeps,
} from '../../src/meetings/service.js';

/**
 * «Eliminar reunión» contra PostgreSQL de verdad y el almacenamiento fake.
 *
 * Lo que hay que demostrar no es que el borrado borra —eso es fácil— sino que
 * NO se completa mientras pueda existir una URL PUT firmada capaz de recrear
 * un objeto después. Esa carrera es la razón de que exista
 * `deletion_not_before`, y varias de estas pruebas no hacen otra cosa que
 * intentar ganarla.
 *
 * Todo es sintético y desechable: tenants, clientes y reuniones se crean y se
 * destruyen aquí. Ninguna grabación real entra en este fichero.
 */

const tenants: string[] = [];
after(async () => {
  for (const t of tenants) await cleanupTenant(t);
  await closeDb();
});

const AUDIO = Buffer.from('RIFF....WAVE bytes sintéticos de prueba');
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

interface World {
  tenantId: string;
  clientId: string;
  otherTenantId: string;
  otherClientId: string;
  userId: string;
  store: FakePrivateStore;
  deps: MeetingsServiceDeps;
  identity: WorkerIdentity;
  scope: { tenantId: string; clientId: string; userId: string };
  admin: DeletionScope;
  member: DeletionScope;
}

async function makeWorld(options?: { putTtlSeconds?: number }): Promise<World> {
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  tenants.push(tenantId, otherTenantId);
  await query(`INSERT INTO tenants (id, name) VALUES ($1,$2),($3,$4)`, [
    tenantId, `T ${tenantId.slice(0, 8)}`, otherTenantId, `T ${otherTenantId.slice(0, 8)}`,
  ]);
  const mkClient = async (t: string, name: string): Promise<string> =>
    (await query<{ id: string }>(
      `INSERT INTO clients (tenant_id, name, is_default) VALUES ($1,$2,false) RETURNING id`,
      [t, name],
    )).rows[0].id;
  const clientId = await mkClient(tenantId, 'Cliente A');
  const otherClientId = await mkClient(otherTenantId, 'Cliente de otro tenant');

  const userId = `u-${tenantId.slice(0, 8)}`;
  await query(
    `INSERT INTO "user" (id, name, email, "emailVerified") VALUES ($1,'Test',$2,true)`,
    [userId, `${userId}@example.test`],
  );

  const poolId = (await query<{ id: string }>(
    `INSERT INTO worker_pools (slug, environment, scope, tenant_id, capabilities, concurrency)
     VALUES ($1,'development','single_tenant',$2,'{meetings.transcribe}',
             '{"schema_version":1,"limits":{"meetings.transcribe":1}}'::jsonb)
     RETURNING id`,
    [`pool-${tenantId.slice(0, 8)}`, tenantId],
  )).rows[0].id;
  const minted = mintWorkerToken();
  await query(
    `INSERT INTO worker_credentials (pool_id, label, token_hash, token_prefix)
     VALUES ($1,'lan-gpu',$2,$3)`,
    [poolId, minted.tokenHash, minted.tokenPrefix],
  );
  const identity = await authenticateWorkerToken(minted.token);
  assert.ok(identity, 'la credencial sembrada debe autenticar');

  const store = new FakePrivateStore(
    options?.putTtlSeconds ? { putTtlSeconds: options.putTtlSeconds } : undefined,
  );
  const base = { tenantId, clientId, userId, userLabel: userId };
  return {
    tenantId, otherTenantId, clientId, otherClientId, userId, store, identity,
    scope: { tenantId, clientId, userId },
    admin: { ...base, role: 'admin' },
    member: { ...base, role: 'member' },
    deps: {
      store,
      limits: DEFAULT_MEDIA_LIMITS,
      leaseSeconds: 300,
      rateLimiter: new RateLimiter({
        rules: {
          claim: { burst: 1000, refillPerSecond: 1000 },
          heartbeat: { burst: 1000, refillPerSecond: 1000 },
          result: { burst: 1000, refillPerSecond: 1000 },
        },
      }),
    },
  };
}

/** Reunión con su audio original ya subido y su primer job en cola. */
async function conAudio(w: World): Promise<{ meetingId: string; jobId: string }> {
  const created = await createMeeting(w.scope, {
    title: 'Reunión sintética desechable',
    idempotencyKey: `k-${randomUUID()}`,
  });
  const init = await uploadInit(
    w.scope, created.meetingId,
    { filename: 'a.wav', contentType: 'audio/wav', bytes: AUDIO.length, checksumSha256: sha(AUDIO) },
    w.deps,
  );
  const put = w.store.put(init.url, AUDIO, init.requiredHeaders);
  assert.ok(put.ok, JSON.stringify(put));
  const done = await uploadComplete(
    w.scope, created.meetingId, { bytes: AUDIO.length, checksumSha256: sha(AUDIO) }, w.deps,
  );
  return { meetingId: created.meetingId, jobId: done.firstJob.id };
}

const prefijoDe = (w: World, meetingId: string): string =>
  `${meetingPrefix({ tenantId: w.tenantId, clientId: w.clientId, meetingId })}/`;

async function contarObjetos(w: World, meetingId: string): Promise<number> {
  let n = 0;
  let cursor: string | undefined;
  do {
    const p = await w.store.listPrefix(prefijoDe(w, meetingId), cursor);
    n += p.keys.length;
    cursor = p.cursor ?? undefined;
  } while (cursor);
  return n;
}

const filaDe = async (meetingId: string): Promise<{ deletion_state: string; deletion_not_before: Date | null; deletion_attempts: number; deletion_failure_code: string | null } | undefined> =>
  (await query(
    `SELECT deletion_state, deletion_not_before, deletion_attempts, deletion_failure_code
       FROM meetings WHERE id = $1`, [meetingId],
  )).rows[0] as never;

/**
 * UNA pasada del proceso periódico, la misma función que engancha
 * `startMeetingsMaintenance` en el servicio worker. Lo único sustituido es el
 * bucket; los lotes, el resumen y el camino de fallo son los de producción.
 */
const pasada = (w: World, env: NodeJS.ProcessEnv = {} as NodeJS.ProcessEnv) =>
  runPurgeCycle(env, w.store);

/** Adelanta el reloj de la base retrasando el plazo, sin dormir de verdad. */
async function vencerPlazo(meetingId: string): Promise<void> {
  await query(`UPDATE meetings SET deletion_not_before = now() - interval '1 second' WHERE id = $1`, [meetingId]);
}

// ══════════════════════════════════════════════════════════════════════════
//  1 · La URL firmada ANTES de pedir el borrado fija el plazo
// ══════════════════════════════════════════════════════════════════════════

test('un PUT firmado antes de pedir el borrado empuja deletion_not_before hasta su vencimiento', async () => {
  const w = await makeWorld({ putTtlSeconds: 900 });
  const created = await createMeeting(w.scope, { title: 'Sin subir', idempotencyKey: `k-${randomUUID()}` });

  const init = await uploadInit(
    w.scope, created.meetingId,
    { filename: 'a.wav', contentType: 'audio/wav', bytes: AUDIO.length, checksumSha256: sha(AUDIO) },
    w.deps,
  );
  const vencimientoUrl = new Date(init.expiresAt);

  const r = await requestMeetingDeletion(w.admin, created.meetingId, w.deps);
  assert.equal(r.state, 'deleting');
  assert.equal(r.reserved, true);

  const plazo = new Date(r.notBefore);
  // El plazo es el vencimiento REAL de la URL, no una duración inventada:
  // ±2 s de holgura por el viaje a la base, nada más.
  assert.ok(
    Math.abs(plazo.getTime() - vencimientoUrl.getTime()) < 2000,
    `el plazo (${r.notBefore}) debe coincidir con el vencimiento de la URL (${init.expiresAt})`,
  );
  assert.ok(plazo.getTime() > Date.now(), 'y todavía no ha llegado');
});

// ══════════════════════════════════════════════════════════════════════════
//  2 · No se completa antes de que venza esa URL
// ══════════════════════════════════════════════════════════════════════════

test('el barrido NO completa la eliminación mientras la URL PUT pueda seguir viva', async () => {
  const w = await makeWorld({ putTtlSeconds: 900 });
  const { meetingId } = await conAudio(w);
  await requestMeetingDeletion(w.admin, meetingId, w.deps);

  const antes = await purgeDeletedMeetings(w.deps);
  // La reunión ni siquiera se toma: el WHERE del claim exige el plazo vencido.
  assert.equal(antes.reports.length, 0, 'no hay nada que barrer todavía');

  const fila = await filaDe(meetingId);
  assert.equal(fila?.deletion_state, 'deleting', 'sigue en curso, no fallida');
  assert.equal(await contarObjetos(w, meetingId), 1, 'el audio sigue ahí');

  // Y forzando el barrido de esa fila concreta, se niega explícitamente.
  const fuerza = await purgeMeeting(
    { id: meetingId, tenant_id: w.tenantId, client_id: w.clientId, title: 'x',
      deletion_state: 'deleting', deletion_requested_at: new Date(),
      deletion_not_before: new Date(Date.now() + 600_000),
      deletion_attempts: 1, deletion_failure_code: null, deletion_last_attempt_at: new Date() },
    w.deps,
  );
  assert.equal(fuerza.outcome, 'too_early');
  assert.equal(await contarObjetos(w, meetingId), 1, 'y no tocó nada');
});

// ══════════════════════════════════════════════════════════════════════════
//  3 · Un PUT que llega DURANTE la espera, y la limpieza posterior
// ══════════════════════════════════════════════════════════════════════════

test('un PUT durante la ventana de espera se recoge igual al vencer el plazo', async () => {
  const w = await makeWorld({ putTtlSeconds: 900 });
  const created = await createMeeting(w.scope, { title: 'Carrera', idempotencyKey: `k-${randomUUID()}` });

  // Se firma la URL, se pide el borrado, y SÓLO DESPUÉS se sube. Es justo la
  // carrera que motiva todo esto: el servidor ya decidió eliminar y el objeto
  // aparece igualmente, porque la firma no se puede revocar.
  const init = await uploadInit(
    w.scope, created.meetingId,
    { filename: 'a.wav', contentType: 'audio/wav', bytes: AUDIO.length, checksumSha256: sha(AUDIO) },
    w.deps,
  );
  await requestMeetingDeletion(w.admin, created.meetingId, w.deps);

  const put = w.store.put(init.url, AUDIO, init.requiredHeaders);
  assert.ok(put.ok, 'la URL firmada sigue funcionando: no se puede revocar');
  assert.equal(await contarObjetos(w, created.meetingId), 1, 'el objeto apareció DESPUÉS de pedir el borrado');

  // Al vencer el plazo, el barrido lo encuentra y se lo lleva — precisamente
  // porque lista el prefijo en vez de fiarse de lo que dice `meeting_media`,
  // donde este objeto nunca llegó a registrarse (no hubo upload-complete).
  const media = await query(`SELECT count(*)::int n FROM meeting_media WHERE meeting_id=$1`, [created.meetingId]);
  assert.equal(media.rows[0].n, 0, 'ninguna fila menciona este objeto');

  await vencerPlazo(created.meetingId);
  const barrido = await purgeDeletedMeetings(w.deps);
  const r = barrido.reports.find((x) => x.meetingId === created.meetingId);
  assert.equal(r?.outcome, 'purged');
  assert.equal(r?.objectsDeleted, 1, 'se llevó el objeto huérfano');
  assert.equal(await contarObjetos(w, created.meetingId), 0, 'el prefijo quedó vacío');
});

// ══════════════════════════════════════════════════════════════════════════
//  4 · Limpieza completa tras el vencimiento: objetos, filas y cascada
// ══════════════════════════════════════════════════════════════════════════

test('pasado el plazo se vacía el prefijo, se borra la fila y las hijas caen en cascada', async () => {
  const w = await makeWorld();
  const { meetingId, jobId } = await conAudio(w);

  const hijasAntes = await query<{ n: number }>(
    `SELECT (SELECT count(*) FROM meeting_media WHERE meeting_id=$1)
          + (SELECT count(*) FROM meeting_processing_runs WHERE meeting_id=$1)
          + (SELECT count(*) FROM meeting_processing_jobs WHERE meeting_id=$1) AS n`,
    [meetingId],
  );
  assert.ok(Number(hijasAntes.rows[0].n) >= 3, 'hay filas hijas que deben caer');
  void jobId;

  await requestMeetingDeletion(w.admin, meetingId, w.deps);
  await vencerPlazo(meetingId);

  const { reports } = await purgeDeletedMeetings(w.deps);
  const r = reports.find((x) => x.meetingId === meetingId);
  assert.equal(r?.outcome, 'purged');
  assert.equal(await contarObjetos(w, meetingId), 0, 'prefijo vacío, verificado por listado');

  const quedan = await query<{ n: string }>(
    `SELECT (SELECT count(*) FROM meetings WHERE id=$1)
          + (SELECT count(*) FROM meeting_media WHERE meeting_id=$1)
          + (SELECT count(*) FROM meeting_processing_runs WHERE meeting_id=$1)
          + (SELECT count(*) FROM meeting_processing_jobs WHERE meeting_id=$1)
          + (SELECT count(*) FROM meeting_job_events WHERE meeting_id=$1) AS n`,
    [meetingId],
  );
  assert.equal(Number(quedan.rows[0].n), 0, 'ni la reunión ni ninguna hija sobreviven');
});

test('la paginación se agota: un prefijo con más objetos que una página se vacía entero', async () => {
  const w = await makeWorld();
  const { meetingId } = await conAudio(w);
  const prefijo = prefijoDe(w, meetingId);
  for (let i = 0; i < 25; i += 1) {
    w.store.seed(`${prefijo}r/${randomUUID()}/transcript/a0/x${i}.ndjson`, Buffer.from(`f${i}`));
  }
  w.store.setPageSize(7); // 26 objetos en páginas de 7: cuatro vueltas largas.
  assert.equal(await contarObjetos(w, meetingId), 26);

  await requestMeetingDeletion(w.admin, meetingId, w.deps);
  await vencerPlazo(meetingId);
  const { reports } = await purgeDeletedMeetings(w.deps);
  const r = reports.find((x) => x.meetingId === meetingId);
  assert.equal(r?.outcome, 'purged');
  assert.equal(r?.objectsDeleted, 26, 'los veintiséis');
  assert.ok((r?.batches ?? 0) > 1, 'y en varios lotes, no en uno mágico');
  assert.equal(await contarObjetos(w, meetingId), 0);
});

// ══════════════════════════════════════════════════════════════════════════
//  5 · Después del DELETE definitivo nada puede reaparecer
// ══════════════════════════════════════════════════════════════════════════

test('tras el DELETE definitivo, la URL PUT anterior ya está vencida y no recrea el objeto', async () => {
  // TTL corto para que el vencimiento real de la URL llegue dentro de la
  // prueba. Es la duración que usa el store, no una constante distinta.
  const w = await makeWorld({ putTtlSeconds: 1 });
  const created = await createMeeting(w.scope, { title: 'Zombi', idempotencyKey: `k-${randomUUID()}` });
  const init = await uploadInit(
    w.scope, created.meetingId,
    { filename: 'a.wav', contentType: 'audio/wav', bytes: AUDIO.length, checksumSha256: sha(AUDIO) },
    w.deps,
  );

  const r = await requestMeetingDeletion(w.admin, created.meetingId, w.deps);
  const plazo = new Date(r.notBefore).getTime();

  // Se espera al plazo DE VERDAD: es un segundo, y lo que se está probando es
  // precisamente que pasado ese instante la URL ya no sirve.
  await new Promise((res) => setTimeout(res, Math.max(0, plazo - Date.now()) + 1100));

  const { reports } = await purgeDeletedMeetings(w.deps);
  assert.equal(reports.find((x) => x.meetingId === created.meetingId)?.outcome, 'purged');
  assert.equal(
    (await query(`SELECT count(*)::int n FROM meetings WHERE id=$1`, [created.meetingId])).rows[0].n,
    0, 'la fila ya no está',
  );

  // Y ahora el intento de resurrección con la URL de antes.
  const zombi = w.store.put(init.url, AUDIO, init.requiredHeaders);
  assert.equal(zombi.ok, false, 'la URL firmada ya no sirve');
  assert.equal((zombi as { code: string }).code, 'url_expired');
  assert.equal(await contarObjetos(w, created.meetingId), 0, 'y el prefijo sigue vacío');
});

// ══════════════════════════════════════════════════════════════════════════
//  6 · Ninguna escritura nueva mientras está `deleting`
// ══════════════════════════════════════════════════════════════════════════

test('upload-init, upload-complete y result-init se rechazan cuando la reunión está deleting', async () => {
  const w = await makeWorld();
  const created = await createMeeting(w.scope, { title: 'Cerrada', idempotencyKey: `k-${randomUUID()}` });
  await requestMeetingDeletion(w.admin, created.meetingId, w.deps);

  await assert.rejects(
    () => uploadInit(
      w.scope, created.meetingId,
      { filename: 'a.wav', contentType: 'audio/wav', bytes: AUDIO.length, checksumSha256: sha(AUDIO) },
      w.deps,
    ),
    (e: unknown) => e instanceof MeetingsApiError && e.code === 'invalid_transition',
    'upload-init no firma nada',
  );
  await assert.rejects(
    () => uploadComplete(w.scope, created.meetingId, { bytes: AUDIO.length, checksumSha256: sha(AUDIO) }, w.deps),
    (e: unknown) => e instanceof MeetingsApiError && e.code === 'invalid_transition',
    'upload-complete tampoco',
  );

  // result-init necesita un job arrendado. Se monta una reunión aparte, se
  // reclama su job y SÓLO ENTONCES se marca para eliminación: así el worker
  // tiene un lease legítimo en la mano, que es el caso peligroso.
  const otra = await conAudio(w);
  const arrendado = await claim(w.identity, { capabilities: ['meetings.transcribe'] }, w.deps);
  assert.ok(arrendado, 'debería haber job que reclamar');
  await requestMeetingDeletion(w.admin, otra.meetingId, w.deps);

  await assert.rejects(
    () => resultInit(
      w.identity,
      { jobId: arrendado!.jobId, attempt: arrendado!.attempt, leaseToken: arrendado!.leaseToken,
        bytes: 10, checksumSha256: sha(Buffer.from('x')) },
      w.deps,
    ),
    (e: unknown) => e instanceof MeetingsApiError && e.code === 'invalid_transition',
    'result-init no firma una URL de escritura para una reunión en eliminación',
  );
});

test('el worker no reclama jobs de una reunión marcada para eliminación', async () => {
  const w = await makeWorld();
  const { meetingId } = await conAudio(w);
  await requestMeetingDeletion(w.admin, meetingId, w.deps);

  const nada = await claim(w.identity, { capabilities: ['meetings.transcribe'] }, w.deps);
  assert.equal(nada, null, 'la cola se comporta como si el job no estuviera');

  // Y el job sigue en cola, no se marcó ni se perdió: lo que cambió es que no
  // se entrega. Borrar la reunión se lo llevará en cascada.
  const j = await query<{ status: string }>(
    `SELECT status FROM meeting_processing_jobs WHERE meeting_id=$1`, [meetingId],
  );
  assert.equal(j.rows[0].status, 'queued');
});

// ══════════════════════════════════════════════════════════════════════════
//  7 · `delete_failed` es reintentable
// ══════════════════════════════════════════════════════════════════════════

test('si el almacenamiento falla, queda delete_failed y el reintento lo termina', async () => {
  const w = await makeWorld();
  const { meetingId } = await conAudio(w);
  const prefijo = prefijoDe(w, meetingId);
  const terca = `${prefijo}original/source`;
  w.store.failDeletesFor([terca]);

  await requestMeetingDeletion(w.admin, meetingId, w.deps);
  await vencerPlazo(meetingId);

  const primera = await purgeDeletedMeetings(w.deps);
  assert.equal(primera.reports.find((x) => x.meetingId === meetingId)?.outcome, 'storage_failed');

  const fallida = await filaDe(meetingId);
  assert.equal(fallida?.deletion_state, 'delete_failed');
  assert.equal(fallida?.deletion_failure_code, 'objects_not_deleted');
  assert.ok(fallida!.deletion_attempts >= 1);
  assert.equal(
    (await query(`SELECT count(*)::int n FROM meetings WHERE id=$1`, [meetingId])).rows[0].n,
    1, 'la fila NO se borró: sin prefijo vacío no hay DELETE',
  );

  // Se arregla lo que fallaba y se reintenta. El lease se soltó al fallar, así
  // que el barrido la vuelve a tomar sin esperar a que caduque.
  w.store.failDeletesFor([]);
  await vencerPlazo(meetingId);
  const segunda = await purgeDeletedMeetings(w.deps);
  assert.equal(segunda.reports.find((x) => x.meetingId === meetingId)?.outcome, 'purged');
  assert.equal(await contarObjetos(w, meetingId), 0);
  assert.equal(
    (await query(`SELECT count(*)::int n FROM meetings WHERE id=$1`, [meetingId])).rows[0].n, 0,
  );
});

// ══════════════════════════════════════════════════════════════════════════
//  8 · Reinicio entre reservar y limpiar
// ══════════════════════════════════════════════════════════════════════════

test('un reinicio entre reservar y limpiar no pierde la eliminación', async () => {
  const w = await makeWorld();
  const { meetingId } = await conAudio(w);
  await requestMeetingDeletion(w.admin, meetingId, w.deps);

  // EL REINICIO. No hay `setTimeout` que matar ni promesa que abandonar: el
  // proceso que reservó desaparece y lo único que queda es lo que hay escrito.
  // Se simula descartando por completo el contexto en memoria —un objeto de
  // servicio nuevo, sin nada de lo anterior— y comprobando que puede terminar.
  const otroProceso: MeetingsServiceDeps['store'] = w.store; // el bucket sí sobrevive
  const depsTrasReinicio = { store: otroProceso };

  await vencerPlazo(meetingId);
  const { reports } = await purgeDeletedMeetings(depsTrasReinicio);
  assert.equal(
    reports.find((x) => x.meetingId === meetingId)?.outcome, 'purged',
    'un proceso que no vio la petición original la termina igual',
  );
  assert.equal(await contarObjetos(w, meetingId), 0);
});

test('dos barridos simultáneos no trabajan sobre la misma reunión', async () => {
  const w = await makeWorld();
  const { meetingId } = await conAudio(w);
  await requestMeetingDeletion(w.admin, meetingId, w.deps);
  await vencerPlazo(meetingId);

  const [a, b] = await Promise.all([
    purgeDeletedMeetings(w.deps),
    purgeDeletedMeetings(w.deps),
  ]);
  const vistas = [...a.reports, ...b.reports].filter((r) => r.meetingId === meetingId);
  assert.equal(vistas.length, 1, 'sólo uno de los dos la toma');
  assert.equal(vistas[0].outcome, 'purged');
});

// ══════════════════════════════════════════════════════════════════════════
//  9 · Permisos y ámbito
// ══════════════════════════════════════════════════════════════════════════

test('un member recibe 403; owner y admin sí pueden eliminar', async () => {
  const w = await makeWorld();

  const paraMember = await conAudio(w);
  const error = await requestMeetingDeletion(w.member, paraMember.meetingId, w.deps).then(
    () => null, (e: unknown) => e,
  );
  assert.ok(error instanceof MeetingsApiError, 'debe rechazar');
  assert.equal(error.code, 'forbidden');
  assert.equal(error.status, 403);
  assert.equal((await filaDe(paraMember.meetingId))?.deletion_state, 'live', 'y no dejó rastro');

  for (const role of ['owner', 'admin'] as const) {
    const m = await conAudio(w);
    const r = await requestMeetingDeletion({ ...w.admin, role }, m.meetingId, w.deps);
    assert.equal(r.state, 'deleting', `${role} sí puede`);
    assert.equal((await filaDe(m.meetingId))?.deletion_state, 'deleting');
  }
});

test('no se puede eliminar una reunión de otro ámbito cambiando el id', async () => {
  const w = await makeWorld();
  const { meetingId } = await conAudio(w);

  // Mismo uuid de reunión, ámbito ajeno: el UPDATE lleva tenant y cliente en
  // el WHERE, así que no encuentra fila y responde «no existe».
  const ajeno: DeletionScope = {
    tenantId: w.otherTenantId, clientId: w.otherClientId,
    userId: 'intruso', userLabel: 'intruso', role: 'owner',
  };
  await assert.rejects(
    () => requestMeetingDeletion(ajeno, meetingId, w.deps),
    (e: unknown) => e instanceof MeetingsApiError && e.code === 'not_found',
  );
  assert.equal((await filaDe(meetingId))?.deletion_state, 'live', 'la reunión no se tocó');
});

test('la eliminación es idempotente: N llamadas, una sola reserva', async () => {
  const w = await makeWorld();
  const { meetingId } = await conAudio(w);

  const rs = await Promise.all(
    Array.from({ length: 5 }, () => requestMeetingDeletion(w.admin, meetingId, w.deps)),
  );
  assert.equal(rs.filter((r) => r.reserved).length, 1, 'sólo una reserva de verdad');
  assert.ok(rs.every((r) => r.state === 'deleting'), 'y las cinco responden lo mismo');
  // El instante de la petición no se reescribe con cada llamada.
  const plazos = new Set(rs.map((r) => r.notBefore));
  assert.equal(plazos.size, 1, 'el plazo se fija una vez y no se alarga a cada clic');

  await vencerPlazo(meetingId);
  await purgeDeletedMeetings(w.deps);

  // Y pedirlo otra vez cuando ya no existe es 404, que es la respuesta correcta
  // a «borra esto» cuando esto ya no está.
  await assert.rejects(
    () => requestMeetingDeletion(w.admin, meetingId, w.deps),
    (e: unknown) => e instanceof MeetingsApiError && e.code === 'not_found',
  );
});

test('el servidor deriva el prefijo: no hay forma de proponerle una clave', async () => {
  const w = await makeWorld();
  const a = await conAudio(w);
  const b = await conAudio(w);

  // Se elimina A. B comparte tenant y cliente, así que sus claves están a un
  // segmento de distancia; si el prefijo se construyera mal, caerían las dos.
  await requestMeetingDeletion(w.admin, a.meetingId, w.deps);
  await vencerPlazo(a.meetingId);
  await purgeDeletedMeetings(w.deps);

  assert.equal(await contarObjetos(w, a.meetingId), 0, 'A se fue');
  assert.equal(await contarObjetos(w, b.meetingId), 1, 'B sigue intacta');
  assert.equal(
    (await query(`SELECT count(*)::int n FROM meetings WHERE id=$1`, [b.meetingId])).rows[0].n, 1,
  );
  // El tipo de la petición no tiene dónde meter una clave: `requestMeetingDeletion`
  // recibe ámbito y meetingId, y el prefijo sale de `meetingPrefix`.
  assert.equal(
    prefijoDe(w, a.meetingId).startsWith(`t/${w.tenantId}/c/${w.clientId}/m/${a.meetingId}`), true,
  );
});

test('el vencimiento de las subidas del worker también cuenta para el plazo', async () => {
  const w = await makeWorld({ putTtlSeconds: 60 });
  const { meetingId } = await conAudio(w);

  // Una subida de artefacto registrada con un vencimiento MUY posterior.
  const lejano = new Date(Date.now() + 3_600_000);
  const job = await query<{ id: string; run_id: string }>(
    `SELECT id, run_id FROM meeting_processing_jobs WHERE meeting_id=$1 LIMIT 1`, [meetingId],
  );
  await query(
    `INSERT INTO meeting_result_uploads
       (tenant_id, client_id, meeting_id, job_id, attempt, kind, schema_version,
        storage_key, content_type, put_expires_at)
     VALUES ($1,$2,$3,$4,0,'transcript',1,$5,'application/x-ndjson',$6)`,
    [w.tenantId, w.clientId, meetingId, job.rows[0].id,
     `${prefijoDe(w, meetingId)}r/${job.rows[0].run_id}/transcript/a0/transcript.ndjson.gz`, lejano],
  );

  const r = await requestMeetingDeletion(w.admin, meetingId, w.deps);
  assert.ok(
    Math.abs(new Date(r.notBefore).getTime() - lejano.getTime()) < 2000,
    'el plazo lo marca la URL más tardía, venga de donde venga',
  );
});

test('nada de lo que se registra lleva contenido, claves ni URLs', async () => {
  const w = await makeWorld();
  const { meetingId } = await conAudio(w);
  await requestMeetingDeletion(w.admin, meetingId, w.deps);
  await vencerPlazo(meetingId);
  const { reports } = await purgeDeletedMeetings(w.deps);
  const r = reports.find((x) => x.meetingId === meetingId)!;

  // La forma se fija a propósito: si alguien añade un campo con contenido, esta
  // lista falla antes de que llegue a un registro.
  const claves = Object.keys(r).sort();
  assert.deepEqual(claves, [
    'batches', 'durationMs', 'meetingId', 'objectsDeleted', 'objectsFound',
    'objectsRemaining', 'outcome',
  ]);
  // Y los tres conteos que el registro necesita para poder auditar la limpieza.
  assert.equal(typeof r.objectsFound, 'number');
  assert.equal(typeof r.objectsDeleted, 'number');
  assert.equal(r.objectsRemaining, 0, 'el re-listado quedó vacío antes del DELETE');
  assert.ok(
    !JSON.stringify(r).includes('t/') && !JSON.stringify(r).includes('http'),
    'ni prefijos ni URLs en lo que se va a registrar',
  );

  // Y el código de fallo es un código, no un mensaje del SDK.
  await deletionRepo.markDeleteFailed(randomUUID(), 'storage_unavailable');
});

// ══════════════════════════════════════════════════════════════════════════
//  El recorrido completo, tal y como ocurre en producción
// ══════════════════════════════════════════════════════════════════════════
//
// Sin atajos: el usuario pide, se va, y el PROCESO PERIÓDICO —el mismo
// `runPurgeCycle` que engancha `startMeetingsMaintenance` en el servicio
// worker— encuentra la reunión y la termina. No se llama a `purgeMeeting`
// a mano en ningún punto.
//
// El reloj avanza DE VERDAD: el TTL de subida es de 2 s, así que el plazo
// vence dentro de la prueba y no hay que falsearlo con un UPDATE. Es lo
// único que demuestra que el vencimiento real de la URL es lo que manda.

test('recorrido completo: pedir, cerrar el navegador, y que el proceso periódico lo termine', async () => {
  const w = await makeWorld({ putTtlSeconds: 2 });

  // ── 1 · El usuario solicita eliminar ────────────────────────────────────
  const { meetingId } = await conAudio(w);
  assert.equal(await contarObjetos(w, meetingId), 1, 'hay audio que destruir');

  const antesDelListado = await listMeetingsForUi({ tenantId: w.tenantId, clientId: w.clientId });
  assert.ok(antesDelListado.some((m) => m.id === meetingId), 'y la reunión se ve en el listado');

  const respuesta = await requestMeetingDeletion(w.admin, meetingId, w.deps);

  // ── 2 · La URL PUT todavía está vigente ─────────────────────────────────
  const plazo = new Date(respuesta.notBefore);
  assert.ok(plazo.getTime() > Date.now(), 'el plazo está en el futuro: la URL puede seguir viva');

  // ── 3 · Respondió 202 y el usuario puede cerrar el navegador ────────────
  assert.equal(respuesta.state, 'deleting');
  assert.equal(respuesta.reserved, true);
  // «Cerrar el navegador» aquí significa que NADIE vuelve a tocar nada: no se
  // llama otra vez al servicio, no se refresca la pantalla y no hay ninguna
  // promesa en vuelo que esté esperando. Lo único vivo es lo escrito en la
  // base.
  const enCurso = await listMeetingsForUi({ tenantId: w.tenantId, clientId: w.clientId });
  assert.equal(
    enCurso.some((m) => m.id === meetingId), false,
    'el listado ya no la devuelve: una recarga no la trae de vuelta',
  );
  // Y la ficha tampoco. Es lo que hace que retirar la fila al instante no sea
  // optimismo: el servidor dice lo mismo si se le vuelve a preguntar.
  assert.equal(await getMeetingForUi({ tenantId: w.tenantId, clientId: w.clientId }, meetingId), null);

  // Una pasada ANTES del vencimiento no toca nada. Esto es la mitad del
  // valor de la prueba: el proceso periódico corre cada pocos minutos y va a
  // encontrarse esta reunión antes de tiempo más de una vez.
  await pasada(w);
  assert.equal(await contarObjetos(w, meetingId), 1, 'el audio sigue ahí');
  assert.equal(
    (await query(`SELECT count(*)::int n FROM meetings WHERE id=$1`, [meetingId])).rows[0].n, 1,
  );

  // ── 4 · Avanza el reloj ─────────────────────────────────────────────────
  await new Promise((r) => setTimeout(r, Math.max(0, plazo.getTime() - Date.now()) + 1200));

  // ── 5 · El proceso periódico la encuentra ───────────────────────────────
  const barrido = await pasada(w);
  assert.equal(barrido.ran, true);
  assert.ok(barrido.purged >= 1, 'la pasada eliminó al menos ésta');
  // El recuento exacto de la pasada NO se afirma: el barrido es una operación
  // de instalación y recorre TODOS los clientes, así que puede llevarse
  // también lo que otra prueba dejó pendiente. Lo que importa —y lo que se
  // comprueba justo debajo— es qué pasó con ESTA reunión.

  // ── 6 y 7 · Prefijo vaciado y verificado ────────────────────────────────
  assert.equal(await contarObjetos(w, meetingId), 0, 'el prefijo quedó vacío');

  // ── 8 · Las filas ya no están, ni la reunión ni sus hijas ───────────────
  const filas = await query<{ n: string }>(
    `SELECT (SELECT count(*) FROM meetings WHERE id=$1)
          + (SELECT count(*) FROM meeting_media WHERE meeting_id=$1)
          + (SELECT count(*) FROM meeting_processing_runs WHERE meeting_id=$1)
          + (SELECT count(*) FROM meeting_processing_jobs WHERE meeting_id=$1)
          + (SELECT count(*) FROM meeting_job_events WHERE meeting_id=$1)
          + (SELECT count(*) FROM meeting_result_uploads WHERE meeting_id=$1) AS n`,
    [meetingId],
  );
  assert.equal(Number(filas.rows[0].n), 0, 'ni la reunión ni ninguna hija sobreviven');

  // ── 9 · Y deja de aparecer en el listado ────────────────────────────────
  const despues = await listMeetingsForUi({ tenantId: w.tenantId, clientId: w.clientId });
  assert.equal(
    despues.some((m) => m.id === meetingId), false,
    'la reunión desapareció de la pantalla',
  );

  // Y una pasada más es inocua: el barrido corre cada cinco minutos para
  // siempre y no puede inventarse trabajo sobre algo que ya no existe.
  const vacia = await pasada(w);
  assert.equal(vacia.ran, true);
  assert.equal(vacia.failed, 0);
  assert.equal(await contarObjetos(w, meetingId), 0);
});

test('el barrido automático se rinde tras el tope y la deja recuperable, no visible', async () => {
  const w = await makeWorld();
  const { meetingId } = await conAudio(w);
  w.store.failDeletesFor([`${prefijoDe(w, meetingId)}original/source`]);

  await requestMeetingDeletion(w.admin, meetingId, w.deps);

  // Falla una y otra vez. Cada pasada gasta un intento.
  for (let i = 0; i < deletionRepo.MAX_PURGE_ATTEMPTS; i += 1) {
    await vencerPlazo(meetingId);
    const r = await pasada(w);
    assert.equal(r.failed, 1, `la pasada ${i + 1} falla`);
  }

  const agotada = await filaDe(meetingId);
  assert.equal(agotada?.deletion_state, 'delete_failed');
  assert.equal(agotada?.deletion_attempts, deletionRepo.MAX_PURGE_ATTEMPTS);

  // A partir de aquí el bucle automático la ignora: cinco fallos iguales no
  // se arreglan al sexto, y seguir cada cinco minutos es ruido permanente.
  await vencerPlazo(meetingId);
  const antes = (await filaDe(meetingId))!.deletion_attempts;
  await pasada(w);
  assert.equal(
    (await filaDe(meetingId))?.deletion_attempts, antes,
    'el automático se rindió: ni siquiera gastó otro intento',
  );

  // La fila SIGUE EN LA BASE con su estado —es lo que hace que el fallo sea
  // recuperable en vez de un objeto huérfano sin dueño—, pero NO se ve en la
  // pantalla: la interfaz sólo lee reuniones vivas, así que para el usuario
  // esta reunión ya desapareció cuando pidió eliminarla.
  const listado = await listMeetingsForUi({ tenantId: w.tenantId, clientId: w.clientId });
  assert.equal(listado.some((m) => m.id === meetingId), false, 'la pantalla no la devuelve');
  assert.equal((await filaDe(meetingId))?.deletion_state, 'delete_failed', 'pero la fila está ahí');

  // Y la operación de reintento sigue existiendo y devuelve el presupuesto de
  // intentos automáticos. Ya NO hay botón que la invoque —la reunión no se ve—,
  // así que esto es lo que ejecutaría una intervención de operación.
  w.store.failDeletesFor([]);
  const reintento = await requestMeetingDeletion(w.admin, meetingId, w.deps);
  assert.equal(reintento.state, 'deleting');
  assert.equal((await filaDe(meetingId))?.deletion_attempts, 0, 'el contador vuelve a cero');

  await vencerPlazo(meetingId);
  const final = await pasada(w);
  assert.equal(final.purged, 1, 'y el automático la termina');
  assert.equal(await contarObjetos(w, meetingId), 0);
});

test('una reunión que revienta no impide que las otras se eliminen', async () => {
  const w = await makeWorld();
  const mala = await conAudio(w);
  const buena1 = await conAudio(w);
  const buena2 = await conAudio(w);

  w.store.failDeletesFor([`${prefijoDe(w, mala.meetingId)}original/source`]);
  for (const m of [mala, buena1, buena2]) {
    await requestMeetingDeletion(w.admin, m.meetingId, w.deps);
    await vencerPlazo(m.meetingId);
  }

  await pasada(w);
  // La prueba está en el resultado de las tres, no en el recuento de la
  // pasada: si el bucle se hubiera detenido en la primera, las otras dos
  // seguirían con su audio.
  assert.equal(await contarObjetos(w, buena1.meetingId), 0);
  assert.equal(await contarObjetos(w, buena2.meetingId), 0);
  assert.equal(await contarObjetos(w, mala.meetingId), 1, 'la mala se queda, marcada');
  assert.equal((await filaDe(mala.meetingId))?.deletion_state, 'delete_failed');
});

test('el barrido limita cuántas reuniones toca por pasada', async () => {
  const w = await makeWorld();
  const ids: string[] = [];
  for (let i = 0; i < 4; i += 1) {
    const m = await conAudio(w);
    ids.push(m.meetingId);
    await requestMeetingDeletion(w.admin, m.meetingId, w.deps);
    await vencerPlazo(m.meetingId);
  }

  // Con el tope en 2, hacen falta dos pasadas. Es lo que impide que una cola
  // acumulada agote el tiempo de una sola ejecución.
  const env = { MEETINGS_PURGE_BATCH: '2' } as NodeJS.ProcessEnv;
  const vivas = async (): Promise<number> =>
    Number((await query<{ n: string }>(
      `SELECT count(*) AS n FROM meetings WHERE id = ANY($1::uuid[])`, [ids],
    )).rows[0].n);

  const a = await pasada(w, env);
  assert.ok(a.processed <= 2, `una pasada no toca más de 2 (tocó ${a.processed})`);
  assert.ok(await vivas() >= 2, 'no se las llevó todas de golpe: para eso está el tope');

  // Las que falten se terminan en pasadas siguientes. Es lo que impide que una
  // cola acumulada agote el tiempo de una sola ejecución.
  for (let i = 0; i < 5 && (await vivas()) > 0; i += 1) {
    const p = await pasada(w, env);
    assert.ok(p.processed <= 2, 'y ninguna pasada se salta el tope');
  }
  assert.equal(await vivas(), 0, 'al final no queda ninguna');
});

test('sin almacenamiento configurado el barrido NO borra filas: avisa y se abstiene', async () => {
  const w = await makeWorld();
  const { meetingId } = await conAudio(w);
  await requestMeetingDeletion(w.admin, meetingId, w.deps);
  await vencerPlazo(meetingId);

  // Un entorno sin las variables del bucket. Borrar la fila aquí dejaría el
  // audio huérfano para siempre, que es el único fallo irreversible.
  const r = await runPurgeCycle({ MEETINGS_STORAGE_DRIVER: 's3' } as NodeJS.ProcessEnv);
  assert.equal(r.ran, false);
  assert.equal(r.skipped, 'storage_not_configured');
  assert.equal(
    (await query(`SELECT count(*)::int n FROM meetings WHERE id=$1`, [meetingId])).rows[0].n, 1,
    'la fila sigue ahí, esperando a que alguien configure el bucket',
  );
});

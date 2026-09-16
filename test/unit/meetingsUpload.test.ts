import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DEFAULT_MEDIA_LIMITS } from '../../src/meetings/mediaLimits.js';
import {
  UploadError,
  acceptAttribute,
  describeLimits,
  humanMessage,
  idempotencyKeyFor,
  newAttemptId,
  reusedMessage,
  titleFromFilename,
  uploadMeeting,
  type PutFn,
  type UploadState,
} from '../../web/lib/meetingsUpload.js';

/**
 * El flujo de subida, contra una API de mentira.
 *
 * Se ejercita la MÁQUINA: el orden de las llamadas, qué se manda en cada una,
 * qué pasa cuando una falla a mitad, y —lo que importa de verdad— que
 * reintentar no cree una segunda reunión. Nada de esto necesita un navegador:
 * `fetch` y el PUT se inyectan.
 */

const LIMITS = DEFAULT_MEDIA_LIMITS;
const CLIENT = 'cff41472-cc78-4db8-8135-5b298456a616';
const MEETING = 'e4cec552-07f3-4a81-8f3b-f33459416563';

/** Un File de verdad, con bytes de verdad, para que el hash sea el de verdad. */
function fakeFile(name: string, bytes: number, type: string): File {
  const data = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i += 1) data[i] = (i * 37 + 11) & 0xff;
  return new File([data], name, { type });
}

interface Call {
  readonly url: string;
  readonly body: Record<string, unknown> | null;
}

interface HarnessOptions {
  readonly created?: boolean;
  readonly mediaStateOnCreate?: string;
  /** Cuántas veces falla el PUT antes de funcionar. */
  readonly putFailures?: number;
  readonly putError?: UploadError;
  /** La secuencia de respuestas del sondeo. */
  readonly poll?: readonly Record<string, unknown>[];
  readonly failOn?: { readonly url: string; readonly status: number; readonly code: string };
}

function harness(options: HarnessOptions = {}) {
  const calls: Call[] = [];
  const states: UploadState[] = [];
  const attempt = newAttemptId();
  let pollIndex = 0;
  let putAttempts = 0;
  const meetings = new Map<string, string>();

  const json = (payload: unknown, status = 200): Response =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  const fetchImpl = (async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const href = String(url);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ url: href, body });

    if (options.failOn && href.includes(options.failOn.url)) {
      return json({ error: { code: options.failOn.code, message: 'nope' } }, options.failOn.status);
    }
    if (href.endsWith('/api/meetings/v1/meetings')) {
      // Idempotencia de verdad: la MISMA clave devuelve la misma reunión con
      // created:false, como hace `ON CONFLICT DO NOTHING` + relectura.
      const key = String(body?.idempotencyKey);
      const existed = meetings.has(key);
      // Un id DISTINTO por clave, como el servidor real: con un id fijo, una prueba de
      // «dos claves → dos reuniones» pasaba o fallaba por el doble, no por el código.
      if (!existed) meetings.set(key, meetings.size === 0 ? MEETING : `${MEETING.slice(0, -2)}${(meetings.size + 10).toString(16)}`);
      return json({
        meetingId: meetings.get(key),
        created: options.created ?? !existed,
        mediaState: options.mediaStateOnCreate ?? 'pending',
      });
    }
    if (href.includes('/upload-init')) {
      return json({
        url: 'https://r2.example/objeto?X-Amz-Signature=abc',
        method: 'PUT',
        requiredHeaders: { 'content-type': String(body?.contentType), 'content-length': String(body?.bytes) },
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
        storageKey: 'k',
      });
    }
    if (href.includes('/upload-complete')) {
      return json({ mediaState: 'ready', runId: 'r', firstJob: { id: 'j', stage: 'normalize' } });
    }
    // El sondeo.
    const secuencia = options.poll ?? [
      { transcriptState: 'running', mediaState: 'ready', activeTranscript: null, jobs: [{ stage: 'transcribe', status: 'leased', progressPct: 40, failureCode: null }] },
      { transcriptState: 'ready', mediaState: 'ready', activeTranscript: { id: 'tv' }, jobs: [] },
    ];
    const payload = secuencia[Math.min(pollIndex, secuencia.length - 1)];
    pollIndex += 1;
    return json(payload);
  }) as unknown as typeof fetch;

  const put: PutFn = async ({ onProgress, body }) => {
    putAttempts += 1;
    if (options.putFailures !== undefined && putAttempts <= options.putFailures) {
      throw options.putError ?? new UploadError('network', 'se cayó la red');
    }
    onProgress(Math.floor(body.size / 2), body.size);
    onProgress(body.size, body.size);
  };

  return {
    calls,
    states,
    get putAttempts() { return putAttempts; },
    get meetingsCreated() { return meetings.size; },
    /**
     * Un harness = una apertura del diálogo, así que comparte `attemptId` entre
     * llamadas: dos `run` seguidos son un REINTENTO. Para modelar «el usuario abre
     * Nueva reunión otra vez» se pasa un intento distinto explícitamente.
     */
    attempt,
    run: (file: File, title = 'Reunión', attemptId: string = attempt) =>
      uploadMeeting({
        file, clientId: CLIENT, title, limits: LIMITS, attemptId,
        onState: (s) => states.push(s), fetchImpl, put, pollMs: 0,
      }),
  };
}

// ── El camino feliz, y el ORDEN ────────────────────────────────────────────

test('el flujo llama a la API en el orden del contrato', async () => {
  const h = harness();
  const final = await h.run(fakeFile('reunion.m4a', 4096, 'audio/mp4'));

  const rutas = h.calls.map((c) => c.url.replace(/^.*\/api/, '/api').split('?')[0]);
  assert.deepEqual(rutas.slice(0, 4), [
    '/api/meetings/v1/meetings',
    `/api/meetings/v1/meetings/${MEETING}/upload-init`,
    `/api/meetings/v1/meetings/${MEETING}/upload-complete`,
    `/api/meetings/v1/meetings/${MEETING}`,
  ]);
  assert.equal(final.stage, 'ready');
  assert.equal(final.transcriptReady, true);
  assert.equal(final.meetingId, MEETING);
});

test('las etapas se emiten en orden y sin saltos', async () => {
  const h = harness();
  await h.run(fakeFile('a.wav', 2048, 'audio/wav'));
  const secuencia = [...new Set(h.states.map((s) => s.stage))];
  assert.deepEqual(secuencia, [
    'hashing', 'creating', 'signing', 'uploading', 'confirming', 'processing', 'ready',
  ]);
});

test('el checksum que se declara es el del fichero, y el mismo en init y complete', async () => {
  const h = harness();
  const file = fakeFile('a.wav', 3000, 'audio/wav');
  await h.run(file);

  const init = h.calls.find((c) => c.url.includes('/upload-init'))!;
  const complete = h.calls.find((c) => c.url.includes('/upload-complete'))!;
  const { createHash } = await import('node:crypto');
  const esperado = createHash('sha256')
    .update(Buffer.from(await file.arrayBuffer()))
    .digest('hex');

  assert.equal(init.body?.checksumSha256, esperado);
  assert.equal(complete.body?.checksumSha256, esperado);
  assert.equal(complete.body?.bytes, 3000);
  assert.equal(init.body?.contentType, 'audio/wav');
});

test('nuestro M4A pasa el portero local', async () => {
  const h = harness();
  const final = await h.run(fakeFile('reunion.m4a', 1026007, 'audio/mp4'));
  assert.equal(final.stage, 'ready');
  // También con el otro MIME que los navegadores usan para M4A.
  const h2 = harness();
  assert.equal((await h2.run(fakeFile('r.m4a', 1024, 'audio/x-m4a'))).stage, 'ready');
  // Y cuando el navegador no reconoce nada.
  const h3 = harness();
  assert.equal((await h3.run(fakeFile('r.m4a', 1024, ''))).stage, 'ready');
});

// ── Reintentar NO duplica reuniones ───────────────────────────────────────

test('reintentar tras un fallo de red reutiliza la MISMA reunión', async () => {
  const h = harness({ putFailures: 1 });
  const file = fakeFile('grabacion.m4a', 4096, 'audio/mp4');

  await assert.rejects(() => h.run(file), (e: UploadError) => e.code === 'network');
  const primerFallo = h.states[h.states.length - 1];
  assert.equal(primerFallo.stage, 'error');
  assert.equal(primerFallo.retryable, true, 'un fallo de red se reintenta');

  const segundo = await h.run(file);
  assert.equal(segundo.stage, 'ready');
  assert.equal(h.meetingsCreated, 1, 'UNA sola reunión, no una por intento');
  assert.equal(h.putAttempts, 2);
  const creaciones = h.calls.filter((c) => c.url.endsWith('/v1/meetings'));
  assert.equal(creaciones.length, 2, 'se llamó dos veces…');
  assert.equal(creaciones[0].body?.idempotencyKey, creaciones[1].body?.idempotencyKey, '…con la misma clave');
});

test('la clave de idempotencia sale del contenido y del INTENTO, no del nombre ni del reloj', async () => {
  const a = fakeFile('uno.m4a', 4096, 'audio/mp4');
  const b = fakeFile('otro-nombre.m4a', 4096, 'audio/mp4');
  const attempt = newAttemptId();
  const h1 = harness();
  const h2 = harness();
  await h1.run(a, 'Reunión', attempt);
  await h2.run(b, 'Reunión', attempt);
  const k1 = h1.calls[0].body?.idempotencyKey;
  const k2 = h2.calls[0].body?.idempotencyKey;
  // Mismo contenido, mismo tamaño y MISMO INTENTO con otro nombre → misma clave: ni el
  // nombre ni el reloj identifican una grabación.
  assert.equal(k1, k2);
  assert.match(String(k1), /^upload:[0-9a-f]{64}:4096:[A-Za-z0-9-]+$/);
});

// ── Los tres comportamientos que se pidieron, uno por prueba ──────────────
//
// Antes eran incompatibles por construcción: la clave salía SÓLO del contenido y la
// restricción del servidor es UNIQUE(tenant, client, idempotency_key) sin ventana, así
// que un audio vivía en UNA reunión por cliente para siempre. En staging eso enganchó
// una subida a una reunión VACÍA de una prueba anterior, con su título viejo.

test('cada «Nueva reunión» crea una reunión independiente, aunque el audio sea idéntico', async () => {
  const file = fakeFile('misma-grabacion.m4a', 4096, 'audio/mp4');
  // UN servidor (un harness = una base) y DOS aperturas del diálogo. Mismo fichero,
  // byte a byte, con el título que el usuario escribe en cada una.
  const h = harness();
  const a = await h.run(file, 'Reunión A', newAttemptId());
  const b = await h.run(file, 'Reunión B', newAttemptId());

  assert.equal(a.stage, 'ready');
  assert.equal(b.stage, 'ready');
  const claves = h.calls.filter((c) => c.url.endsWith('/v1/meetings')).map((c) => c.body?.idempotencyKey);
  assert.notEqual(claves[0], claves[1], 'intentos distintos → claves distintas');
  assert.equal(a.reused, false, 'la primera no reutiliza nada');
  assert.equal(b.reused, false, 'y la segunda TAMPOCO: es una reunión nueva, no un duplicado');
  assert.notEqual(a.meetingId, b.meetingId, 'dos reuniones, no una');
  assert.equal(h.meetingsCreated, 2, 'dos filas en la base');
  // Y el título de cada una es el que se escribió: al reutilizar se descartaba.
  const titulos = h.calls.filter((c) => c.url.endsWith('/v1/meetings')).map((c) => c.body?.title);
  assert.deepEqual(titulos, ['Reunión A', 'Reunión B']);
});

test('reintentar una subida interrumpida conserva la reunión y no duplica', async () => {
  // Un solo harness = una sola apertura = un solo intento.
  const h = harness({ putFailures: 1 });
  const file = fakeFile('se-corto-la-red.m4a', 4096, 'audio/mp4');

  await assert.rejects(() => h.run(file), (e: UploadError) => e.code === 'network');
  const final = await h.run(file);

  assert.equal(final.stage, 'ready');
  assert.equal(h.meetingsCreated, 1, 'UNA reunión para el intento entero');
  const claves = h.calls.filter((c) => c.url.endsWith('/v1/meetings')).map((c) => c.body?.idempotencyKey);
  assert.equal(claves.length, 2);
  assert.equal(claves[0], claves[1], 'la misma clave, porque es el mismo intento');
});

test('recuperar una subida anterior se comunica, y el mensaje NO afirma lo que no sabe', async () => {
  // Reunión reutilizada que aún NO tiene audio: es un intento a medias. El texto viejo
  // decía «esta grabación ya estaba subida» —falso, y mandaba a buscar un audio que no
  // existía—, así que ahora el mensaje depende del estado que reporta el servidor.
  const aMedias = harness({ created: false, mediaStateOnCreate: 'pending' });
  const reanudada = await aMedias.run(fakeFile('a.m4a', 2048, 'audio/mp4'));
  assert.equal(reanudada.reused, true);
  assert.equal(reanudada.reusedMediaState, 'pending');
  assert.match(reusedMessage(reanudada.reusedMediaState), /recuperó tu intento anterior/);
  assert.doesNotMatch(reusedMessage(reanudada.reusedMediaState), /ya estaba subida|ya se había completado/);

  // Reunión reutilizada que YA tiene su audio: eso sí está completo.
  const completa = harness({ created: false, mediaStateOnCreate: 'ready' });
  const yaEstaba = await completa.run(fakeFile('b.m4a', 2048, 'audio/mp4'));
  assert.equal(yaEstaba.reusedMediaState, 'ready');
  assert.match(reusedMessage(yaEstaba.reusedMediaState), /ya se había completado/);

  // Y sin reutilización no se afirma nada.
  const nueva = harness();
  const recien = await nueva.run(fakeFile('c.m4a', 2048, 'audio/mp4'));
  assert.equal(recien.reused, false);
  assert.equal(recien.reusedMediaState, null, 'nada que comunicar');
});

test('el intento es obligatorio en la entrada: nadie vuelve al comportamiento viejo por olvido', () => {
  // La comprobación es de TIPOS, y se afirma sobre el fuente para que quitar el campo
  // requerido rompa esta prueba y no sólo el editor de alguien.
  const src = readFileSync(new URL('../../web/lib/meetingsUpload.ts', import.meta.url), 'utf8');
  assert.match(src, /readonly attemptId: string;/, 'attemptId no es opcional');
  assert.doesNotMatch(src, /attemptId\?: string/, 'y no tiene variante opcional');
  assert.match(src, /upload:\$\{checksumSha256\}:\$\{bytes\}:\$\{attemptId\}/, 'la clave lo incluye');
});

test('ficheros distintos dan claves distintas', async () => {
  const h1 = harness();
  const h2 = harness();
  await h1.run(fakeFile('a.wav', 1024, 'audio/wav'));
  await h2.run(fakeFile('a.wav', 2048, 'audio/wav'));
  assert.notEqual(h1.calls[0].body?.idempotencyKey, h2.calls[0].body?.idempotencyKey);
});

test('si la reunión ya tiene su audio, se salta al sondeo en vez de fallar', async () => {
  // Es lo que pasa al reintentar DESPUÉS de que la subida ya se confirmara:
  // `upload-init` daría `invalid_transition`, así que no se llama.
  const h = harness({ created: false, mediaStateOnCreate: 'ready' });
  const final = await h.run(fakeFile('a.m4a', 1024, 'audio/mp4'));
  assert.equal(final.stage, 'ready');
  assert.equal(final.reused, true);
  assert.equal(h.calls.filter((c) => c.url.includes('/upload-init')).length, 0);
  assert.equal(h.putAttempts, 0, 'no se resube el audio');
});

// ── El portero local rechaza antes de firmar nada ─────────────────────────

test('una extensión no admitida no llega ni a crear la reunión', async () => {
  const h = harness();
  await assert.rejects(
    () => h.run(fakeFile('documento.pdf', 1024, 'application/pdf')),
    (e: UploadError) => e.code === 'extension_not_allowed',
  );
  assert.equal(h.calls.length, 0, 'ni una llamada al servidor');
  assert.equal(h.states[h.states.length - 1].retryable, false, 'con otro fichero, no el mismo');
});

test('un fichero vacío se rechaza en local', async () => {
  const h = harness();
  await assert.rejects(
    () => h.run(fakeFile('vacio.wav', 0, 'audio/wav')),
    (e: UploadError) => e.code === 'size_not_positive',
  );
  assert.equal(h.calls.length, 0);
});

test('un fichero por encima del tope se rechaza sin leerlo entero', async () => {
  const h = harness();
  const enorme = { name: 'gigante.wav', size: LIMITS.maxBytes + 1, type: 'audio/wav' } as unknown as File;
  await assert.rejects(
    () => h.run(enorme),
    (e: UploadError) => e.code === 'size_too_large',
  );
  assert.equal(h.calls.length, 0);
});

// ── Los errores del servidor, comprensibles y con su código ───────────────

test('un 404 del ámbito se explica sin filtrar por qué', async () => {
  const h = harness({ failOn: { url: '/v1/meetings', status: 404, code: 'not_found' } });
  await assert.rejects(() => h.run(fakeFile('a.wav', 1024, 'audio/wav')));
  const final = h.states[h.states.length - 1];
  assert.equal(final.code, 'not_found');
  assert.match(final.message!, /ya no está disponible para este cliente/);
  assert.equal(final.retryable, false);
});

test('la sesión caducada se distingue de un error de red', async () => {
  const h = harness({ failOn: { url: '/v1/meetings', status: 401, code: 'unauthorized' } });
  await assert.rejects(() => h.run(fakeFile('a.wav', 1024, 'audio/wav')));
  assert.match(h.states[h.states.length - 1].message!, /sesión ha caducado/);
});

test('un checksum que no cuadra dice que el fichero llegó corrupto y se puede reintentar', async () => {
  const h = harness({ failOn: { url: '/upload-complete', status: 422, code: 'checksum_mismatch' } });
  await assert.rejects(() => h.run(fakeFile('a.wav', 1024, 'audio/wav')));
  const final = h.states[h.states.length - 1];
  assert.equal(final.code, 'checksum_mismatch');
  assert.equal(final.retryable, true);
});

test('un fallo del PUT sin respuesta legible nombra CORS Y la red, sin adivinar', async () => {
  const h = harness({ putFailures: 99, putError: new UploadError('cors', 'no se pudo completar') });
  await assert.rejects(() => h.run(fakeFile('a.wav', 1024, 'audio/wav')));
  assert.match(humanMessage('cors'), /falta la configuración CORS/);
});

test('un fallo del pipeline se reporta con la etapa y el código del worker', async () => {
  const h = harness({
    poll: [
      { transcriptState: 'failed', mediaState: 'ready', activeTranscript: null,
        jobs: [{ stage: 'transcribe', status: 'failed', progressPct: null, failureCode: 'transcribe_failed' }] },
    ],
  });
  await assert.rejects(
    () => h.run(fakeFile('a.wav', 1024, 'audio/wav')),
    (e: UploadError) => e.code === 'transcribe_failed',
  );
  assert.match(h.states[h.states.length - 1].message!, /etapa transcribe/);
});

test('un sondeo que falla NO cancela la subida: el audio ya está en R2', async () => {
  let intentos = 0;
  const json = (p: unknown) => new Response(JSON.stringify(p), { headers: { 'content-type': 'application/json' } });
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    if (href.endsWith('/v1/meetings')) return json({ meetingId: MEETING, created: true, mediaState: 'pending' });
    if (href.includes('/upload-init')) return json({ url: 'https://r2.example/o', requiredHeaders: {}, expiresAt: 'x' });
    if (href.includes('/upload-complete')) return json({ mediaState: 'ready' });
    intentos += 1;
    if (intentos <= 2) return new Response('boom', { status: 503 });
    return json({ transcriptState: 'ready', mediaState: 'ready', activeTranscript: { id: 't' }, jobs: [] });
  }) as unknown as typeof fetch;

  const final = await uploadMeeting({
    file: fakeFile('a.wav', 1024, 'audio/wav'),
    clientId: CLIENT, title: 'x', limits: LIMITS, onState: () => {},
    fetchImpl, put: async ({ onProgress, body }) => onProgress(body.size, body.size), pollMs: 0,
  });
  assert.equal(final.stage, 'ready');
  assert.equal(intentos, 3, 'reintentó el sondeo dos veces y siguió');
});

test('cancelar durante el sondeo aborta con su propio código', async () => {
  const controller = new AbortController();
  const json = (p: unknown) => new Response(JSON.stringify(p), { headers: { 'content-type': 'application/json' } });
  const fetchImpl = (async (url: string | URL) => {
    const href = String(url);
    if (href.endsWith('/v1/meetings')) return json({ meetingId: MEETING, created: true, mediaState: 'pending' });
    if (href.includes('/upload-init')) return json({ url: 'https://r2.example/o', requiredHeaders: {}, expiresAt: 'x' });
    if (href.includes('/upload-complete')) return json({ mediaState: 'ready' });
    controller.abort();
    return json({ transcriptState: 'running', mediaState: 'ready', activeTranscript: null, jobs: [] });
  }) as unknown as typeof fetch;

  await assert.rejects(
    () => uploadMeeting({
      file: fakeFile('a.wav', 1024, 'audio/wav'),
      clientId: CLIENT, title: 'x', limits: LIMITS, onState: () => {},
      fetchImpl, put: async ({ onProgress, body }) => onProgress(body.size, body.size),
      pollMs: 0, signal: controller.signal,
    }),
    (e: UploadError) => e.code === 'aborted' && e.retryable === false,
  );
});

// ── Los textos derivados de los límites ──────────────────────────────────

test('la zona de arrastre nombra los formatos REALES del backend', () => {
  const texto = describeLimits(LIMITS);
  for (const formato of ['MP3', 'MP4', 'M4A', 'WAV', 'FLAC', 'OGG', 'WEBM']) {
    assert.ok(texto.includes(formato), `falta ${formato} en "${texto}"`);
  }
  // Decía «hasta 4 GB» y el máximo real son 2 GiB.
  assert.match(texto, /hasta 2 GB/);
});

test('el accept del input no pide application/octet-stream', () => {
  const accept = acceptAttribute(LIMITS);
  assert.ok(accept.includes('.m4a'));
  assert.ok(accept.includes('audio/mp4'));
  assert.ok(!accept.includes('application/octet-stream'), 'eso abriría el selector a todo');
});

test('el título por defecto es el nombre sin extensión', () => {
  assert.equal(titleFromFilename('Reunión con Delta.m4a'), 'Reunión con Delta');
  assert.equal(titleFromFilename('/ruta/al/audio.wav'), 'audio');
  assert.equal(titleFromFilename('sin-extension'), 'sin-extension');
  assert.equal(titleFromFilename('.oculto'), '.oculto');
});

test('idempotencyKeyFor es estable y cabe en los 200 caracteres del contrato', () => {
  const attempt = newAttemptId();
  const key = idempotencyKeyFor('a'.repeat(64), 2 * 1024 * 1024 * 1024, attempt);
  assert.equal(key, `upload:${'a'.repeat(64)}:2147483648:${attempt}`);
  // 7 + 64 + 1 + 10 + 1 + 36 = 119 con un UUID. El contrato son 200.
  assert.ok(key.length <= 200, `la clave mide ${key.length}`);
});

test('un código desconocido se muestra con su detalle, no como «error»', () => {
  assert.equal(humanMessage('algo_nuevo', 'pasó esto'), 'algo_nuevo: pasó esto');
  assert.equal(humanMessage('algo_nuevo'), 'algo_nuevo');
});

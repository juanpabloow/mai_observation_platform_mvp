import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { DEFAULT_MEDIA_LIMITS } from '../../src/meetings/mediaLimits.js';
import {
  UploadError,
  acceptAttribute,
  describeLimits,
  humanMessage,
  idempotencyKeyFor,
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
      if (!existed) meetings.set(key, MEETING);
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
    run: (file: File, title = 'Reunión') =>
      uploadMeeting({
        file, clientId: CLIENT, title, limits: LIMITS,
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

test('la clave de idempotencia sale del contenido, no del nombre ni del reloj', async () => {
  const a = fakeFile('uno.m4a', 4096, 'audio/mp4');
  const b = fakeFile('otro-nombre.m4a', 4096, 'audio/mp4');
  const h1 = harness();
  const h2 = harness();
  await h1.run(a);
  await h2.run(b);
  const k1 = h1.calls[0].body?.idempotencyKey;
  const k2 = h2.calls[0].body?.idempotencyKey;
  // Mismo contenido y mismo tamaño con otro nombre → misma clave: el nombre no
  // identifica una grabación.
  assert.equal(k1, k2);
  assert.match(String(k1), /^upload:[0-9a-f]{64}:4096$/);
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
  const key = idempotencyKeyFor('a'.repeat(64), 2 * 1024 * 1024 * 1024);
  assert.equal(key, `upload:${'a'.repeat(64)}:2147483648`);
  assert.ok(key.length <= 200);
});

test('un código desconocido se muestra con su detalle, no como «error»', () => {
  assert.equal(humanMessage('algo_nuevo', 'pasó esto'), 'algo_nuevo: pasó esto');
  assert.equal(humanMessage('algo_nuevo'), 'algo_nuevo');
});

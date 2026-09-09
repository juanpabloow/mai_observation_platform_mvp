import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { presign, amzDate, MAX_PRESIGN_SECONDS } from '../../src/storage/sigv4.js';
import {
  artifactKey,
  clientPrefix,
  keyBelongsToMeeting,
  meetingPrefix,
  originalMediaKey,
  runPrefix,
  StorageKeyError,
} from '../../src/meetings/storageKeys.js';
import {
  checkMedia,
  DEFAULT_MEDIA_LIMITS,
  extensionOf,
  parseMediaLimits,
} from '../../src/meetings/mediaLimits.js';
import { FakePrivateStore } from '../../src/storage/fakePrivateStore.js';
import { S3PrivateStore, evaluateConfirm, sha256Hex } from '../../src/storage/s3PrivateStore.js';
import { base64ToHex, hexToBase64 } from '../../src/storage/privateObjectStore.js';
import {
  assertSeparateFromPublicBucket,
  describeStorage,
  redactSignedUrl,
  resolveMeetingsStorage,
} from '../../src/storage/meetingsStorage.js';

/**
 * T-2 · almacenamiento privado.
 *
 * El firmado se prueba contra el VECTOR CANÓNICO de AWS, no contra sí mismo: si
 * se comparase la salida con una constante que yo mismo generé, la prueba
 * pasaría igual con el algoritmo mal implementado.
 */

const TENANT = '11111111-1111-1111-1111-111111111111';
const CLIENT = 'aaaa0001-0000-0000-0000-000000000000';
const MEETING = 'dead0001-0000-0000-0000-000000000000';
const RUN = 'beef0001-0000-0000-0000-000000000000';
const SCOPE = { tenantId: TENANT, clientId: CLIENT, meetingId: MEETING };

// ── SigV4 ───────────────────────────────────────────────────────────────────

test('presign reproduce la firma del vector canónico de AWS', () => {
  // Ejemplo publicado por AWS para una URL GET prefirmada.
  const signed = presign({
    credentials: {
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    },
    region: 'us-east-1',
    service: 's3',
    method: 'GET',
    host: 'examplebucket.s3.amazonaws.com',
    path: '/test.txt',
    expiresInSeconds: 86400,
    signedAt: new Date('2013-05-24T00:00:00Z'),
  });
  const signature = new URL(signed.url).searchParams.get('X-Amz-Signature');
  assert.equal(signature, 'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
});

test('la URL prefirmada lleva los parámetros que S3 exige y NO el secreto', () => {
  const signed = presign({
    credentials: { accessKeyId: 'AKID', secretAccessKey: 'SECRETO-QUE-NO-DEBE-APARECER' },
    region: 'auto',
    service: 's3',
    method: 'PUT',
    host: 'cuenta.r2.cloudflarestorage.com',
    path: '/bucket/t/x/objeto',
    expiresInSeconds: 900,
    signedAt: new Date('2026-09-08T12:00:00Z'),
  });
  const params = new URL(signed.url).searchParams;
  assert.equal(params.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
  assert.equal(params.get('X-Amz-Expires'), '900');
  assert.equal(params.get('X-Amz-SignedHeaders'), 'host');
  assert.match(params.get('X-Amz-Credential') ?? '', /^AKID\/20260908\/auto\/s3\/aws4_request$/);
  assert.ok(!signed.url.includes('SECRETO-QUE-NO-DEBE-APARECER'));
});

test('las cabeceras firmadas entran en SignedHeaders y se devuelven al llamador', () => {
  const signed = presign({
    credentials: { accessKeyId: 'AKID', secretAccessKey: 'SECRET' },
    region: 'auto',
    service: 's3',
    method: 'PUT',
    host: 'h.example',
    path: '/b/k',
    expiresInSeconds: 60,
    signedAt: new Date('2026-01-01T00:00:00Z'),
    signedHeaders: { 'Content-Type': 'audio/wav', 'Content-Length': '1234' },
  });
  // Ordenadas y en minúsculas, con host incluido.
  assert.equal(
    new URL(signed.url).searchParams.get('X-Amz-SignedHeaders'),
    'content-length;content-type;host',
  );
  assert.deepEqual(signed.requiredHeaders, {
    'content-type': 'audio/wav',
    'content-length': '1234',
  });
});

test('cambiar una cabecera firmada cambia la firma', () => {
  const base = {
    credentials: { accessKeyId: 'AKID', secretAccessKey: 'SECRET' },
    region: 'auto',
    service: 's3',
    method: 'PUT',
    host: 'h.example',
    path: '/b/k',
    expiresInSeconds: 60,
    signedAt: new Date('2026-01-01T00:00:00Z'),
  } as const;
  const a = presign({ ...base, signedHeaders: { 'content-length': '10' } });
  const b = presign({ ...base, signedHeaders: { 'content-length': '11' } });
  const sig = (u: string) => new URL(u).searchParams.get('X-Amz-Signature');
  assert.notEqual(sig(a.url), sig(b.url));
});

test('presign codifica la ruta segmento a segmento y RFC-3986', () => {
  const signed = presign({
    credentials: { accessKeyId: 'AKID', secretAccessKey: 'SECRET' },
    region: 'auto',
    service: 's3',
    method: 'GET',
    host: 'h.example',
    path: "/b/con espacio/y(paréntesis)",
    expiresInSeconds: 60,
    signedAt: new Date('2026-01-01T00:00:00Z'),
  });
  const path = new URL(signed.url).pathname;
  assert.ok(path.startsWith('/b/con%20espacio/'), path);
  // encodeURIComponent deja '(' y ')' sin codificar; S3 los espera codificados.
  assert.ok(path.includes('%28') && path.includes('%29'), path);
  assert.ok(!path.includes('/con espacio/'));
});

test('presign rechaza caducidades imposibles', () => {
  const base = {
    credentials: { accessKeyId: 'A', secretAccessKey: 'S' },
    region: 'auto',
    service: 's3',
    method: 'GET',
    host: 'h',
    path: '/k',
    signedAt: new Date('2026-01-01T00:00:00Z'),
  } as const;
  assert.throws(() => presign({ ...base, expiresInSeconds: 0 }), /entero >= 1/);
  assert.throws(() => presign({ ...base, expiresInSeconds: 1.5 }), /entero >= 1/);
  assert.throws(() => presign({ ...base, expiresInSeconds: MAX_PRESIGN_SECONDS + 1 }), /máximo/);
});

test('amzDate produce el formato básico sin guiones ni milisegundos', () => {
  assert.equal(amzDate(new Date('2013-05-24T00:00:00.123Z')), '20130524T000000Z');
});

// ── Claves ──────────────────────────────────────────────────────────────────

test('las claves empiezan por tenant y cliente, para poder borrar por prefijo', () => {
  assert.equal(meetingPrefix(SCOPE), `t/${TENANT}/c/${CLIENT}/m/${MEETING}`);
  assert.equal(clientPrefix(TENANT, CLIENT), `t/${TENANT}/c/${CLIENT}`);
  assert.ok(meetingPrefix(SCOPE).startsWith(clientPrefix(TENANT, CLIENT)));
  assert.ok(runPrefix(SCOPE, RUN).startsWith(meetingPrefix(SCOPE)));
});

test('el original es UNA clave por reunión y no lleva la extensión declarada', () => {
  const key = originalMediaKey(SCOPE);
  assert.equal(key, `t/${TENANT}/c/${CLIENT}/m/${MEETING}/original/source`);
  // La misma reunión da la misma clave: reiniciar la subida no crea huérfanos.
  assert.equal(originalMediaKey(SCOPE), key);
  assert.ok(!key.includes('.mp3'));
});

test('la clave de artefacto es determinista e incluye el intento', () => {
  const first = artifactKey({ ...SCOPE, runId: RUN, attempt: 0, role: 'transcript' });
  assert.equal(first, artifactKey({ ...SCOPE, runId: RUN, attempt: 0, role: 'transcript' }));
  const second = artifactKey({ ...SCOPE, runId: RUN, attempt: 1, role: 'transcript' });
  assert.notEqual(first, second);
  assert.ok(first.endsWith('/transcript/a0/transcript.ndjson.gz'));
  assert.ok(second.endsWith('/transcript/a1/transcript.ndjson.gz'));
});

test('cada rol tiene su propia clave dentro del mismo run', () => {
  const roles = (['normalized', 'transcript', 'diarization'] as const).map((role) =>
    artifactKey({ ...SCOPE, runId: RUN, attempt: 0, role }),
  );
  assert.equal(new Set(roles).size, 3);
  assert.ok(roles[0].endsWith('audio.wav'));
  assert.ok(roles[2].endsWith('turns.ndjson.gz'));
});

test('un id que no es uuid o un intento fuera de rango revientan, no producen una clave rara', () => {
  assert.throws(() => meetingPrefix({ ...SCOPE, meetingId: '../otro' }), StorageKeyError);
  assert.throws(() => meetingPrefix({ ...SCOPE, tenantId: '' }), StorageKeyError);
  assert.throws(
    () => artifactKey({ ...SCOPE, runId: RUN, attempt: -1, role: 'transcript' }),
    StorageKeyError,
  );
  assert.throws(
    () => artifactKey({ ...SCOPE, runId: RUN, attempt: 1.5, role: 'transcript' }),
    StorageKeyError,
  );
});

test('keyBelongsToMeeting rechaza la clave de otra reunión del mismo cliente', () => {
  const other = 'dead0002-0000-0000-0000-000000000000';
  const key = artifactKey({ ...SCOPE, runId: RUN, attempt: 0, role: 'transcript' });
  assert.ok(keyBelongsToMeeting(key, SCOPE));
  assert.ok(!keyBelongsToMeeting(key, { ...SCOPE, meetingId: other }));
  // Y de otro cliente del mismo tenant.
  assert.ok(!keyBelongsToMeeting(key, { ...SCOPE, clientId: 'aaaa0002-0000-0000-0000-000000000000' }));
});

// ── Límites de medios ───────────────────────────────────────────────────────

test('extensionOf ignora la ruta y normaliza a minúsculas', () => {
  assert.equal(extensionOf('reunion.MP3'), '.mp3');
  assert.equal(extensionOf('/tmp/x/y/audio.wav'), '.wav');
  assert.equal(extensionOf('C:\\Users\\x\\audio.WAV'), '.wav');
  assert.equal(extensionOf('sinextension'), null);
  assert.equal(extensionOf('.oculto'), null);
  assert.equal(extensionOf('acaba.en.punto.'), null);
});

test('checkMedia acepta un audio normal', () => {
  const result = checkMedia(
    { filename: 'kickoff.mp3', contentType: 'audio/mpeg', bytes: 5_000_000 },
    DEFAULT_MEDIA_LIMITS,
  );
  assert.ok(result.ok);
  if (result.ok) assert.equal(result.extension, '.mp3');
});

test('checkMedia devuelve códigos estables por cada motivo de rechazo', () => {
  const cases: Array<[Parameters<typeof checkMedia>[0], string]> = [
    [{ filename: '', contentType: 'audio/mpeg', bytes: 1 }, 'filename_missing'],
    [{ filename: 'x.exe', contentType: 'audio/mpeg', bytes: 1 }, 'extension_not_allowed'],
    [{ filename: 'x.mp3', contentType: 'text/html', bytes: 1 }, 'content_type_not_allowed'],
    [{ filename: 'x.mp3', contentType: 'audio/mpeg', bytes: 0 }, 'size_not_positive'],
    [{ filename: 'x.mp3', contentType: 'audio/mpeg', bytes: Number.NaN }, 'size_missing'],
    [
      { filename: 'x.mp3', contentType: 'audio/mpeg', bytes: DEFAULT_MEDIA_LIMITS.maxBytes + 1 },
      'size_too_large',
    ],
    [
      {
        filename: 'x.mp3',
        contentType: 'audio/mpeg',
        bytes: 100,
        durationSeconds: DEFAULT_MEDIA_LIMITS.maxDurationSeconds + 1,
      },
      'duration_too_long',
    ],
  ];
  for (const [candidate, code] of cases) {
    const result = checkMedia(candidate, DEFAULT_MEDIA_LIMITS);
    assert.equal(result.ok, false, `${candidate.filename} debería fallar`);
    if (!result.ok) assert.equal(result.code, code);
  }
});

test('el content type se compara sin sus parámetros', () => {
  const result = checkMedia(
    { filename: 'x.mp3', contentType: 'audio/mpeg; charset=binary', bytes: 10 },
    DEFAULT_MEDIA_LIMITS,
  );
  assert.ok(result.ok);
});

test('la duración sólo se comprueba cuando se conoce (en upload-init no)', () => {
  const result = checkMedia(
    { filename: 'x.mp3', contentType: 'audio/mpeg', bytes: 10 },
    { ...DEFAULT_MEDIA_LIMITS, maxDurationSeconds: 1 },
  );
  assert.ok(result.ok, 'sin durationSeconds no se puede juzgar la duración');
});

test('parseMediaLimits lee del entorno y acepta listas sueltas', () => {
  const { limits, warnings } = parseMediaLimits({
    MEETINGS_MAX_MEDIA_BYTES: '1048576',
    MEETINGS_MAX_DURATION_SECONDS: '600',
    MEETINGS_ALLOWED_EXTENSIONS: 'mp3, .WAV ,flac',
    MEETINGS_ALLOWED_CONTENT_TYPES: 'audio/mpeg,AUDIO/WAV',
  });
  assert.equal(limits.maxBytes, 1048576);
  assert.equal(limits.maxDurationSeconds, 600);
  assert.deepEqual([...limits.allowedExtensions].sort(), ['.flac', '.mp3', '.wav']);
  assert.deepEqual([...limits.allowedContentTypes].sort(), ['audio/mpeg', 'audio/wav']);
  assert.deepEqual(warnings, []);
});

test('un límite ilegible cae al defecto y lo AVISA en vez de romper el arranque', () => {
  const { limits, warnings } = parseMediaLimits({ MEETINGS_MAX_MEDIA_BYTES: 'un-montón' });
  assert.equal(limits.maxBytes, DEFAULT_MEDIA_LIMITS.maxBytes);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /MEETINGS_MAX_MEDIA_BYTES/);
});

test('una allowlist que queda vacía tras normalizar conserva el defecto', () => {
  // Una allowlist vacía rechazaría TODO y parecería un fallo del producto.
  const { limits } = parseMediaLimits({ MEETINGS_ALLOWED_EXTENSIONS: ' , , ' });
  assert.deepEqual(limits.allowedExtensions, DEFAULT_MEDIA_LIMITS.allowedExtensions);
});

// ── hex / base64 ────────────────────────────────────────────────────────────

test('hexToBase64 y base64ToHex son inversos y validan la longitud', () => {
  const hex = createHash('sha256').update('x').digest('hex');
  assert.equal(base64ToHex(hexToBase64(hex)), hex);
  assert.throws(() => hexToBase64('abc'), /sha256 en hex/);
  assert.equal(base64ToHex(Buffer.from('corto').toString('base64')), null);
});

// ── El fake hace cumplir lo que hace cumplir S3 ─────────────────────────────

test('el fake acepta una subida que respeta lo firmado', () => {
  const store = new FakePrivateStore();
  const body = Buffer.from('audio-falso');
  const signed = store.signPut({
    key: 'k/1',
    contentType: 'audio/wav',
    contentLength: body.length,
    checksumSha256Hex: sha256Hex(body),
  });
  const outcome = store.put(signed.url, body, { 'content-type': 'audio/wav' });
  assert.ok(outcome.ok, JSON.stringify(outcome));
});

test('el fake RECHAZA un cuerpo de otro tamaño que el firmado', () => {
  const store = new FakePrivateStore();
  const signed = store.signPut({ key: 'k/1', contentType: 'audio/wav', contentLength: 5 });
  const outcome = store.put(signed.url, Buffer.from('mucho mas largo'), {
    'content-type': 'audio/wav',
  });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.code, 'signature_mismatch');
});

test('el fake RECHAZA un cuerpo cuyo checksum no es el firmado', () => {
  const store = new FakePrivateStore();
  const body = Buffer.from('lo-prometido');
  const signed = store.signPut({
    key: 'k/1',
    contentType: 'audio/wav',
    contentLength: 12,
    checksumSha256Hex: sha256Hex(body),
  });
  const otro = Buffer.from('otra-cosa-12');
  assert.equal(otro.length, body.length, 'mismo tamaño: sólo el checksum lo distingue');
  const outcome = store.put(signed.url, otro, { 'content-type': 'audio/wav' });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.match(outcome.detail, /SHA-256/);
});

test('el fake RECHAZA otro content-type del firmado', () => {
  const store = new FakePrivateStore();
  const signed = store.signPut({ key: 'k/1', contentType: 'audio/wav', contentLength: 3 });
  const outcome = store.put(signed.url, Buffer.from('abc'), { 'content-type': 'text/html' });
  assert.equal(outcome.ok, false);
});

test('una URL de subida caducada deja de valer', () => {
  let now = new Date('2026-09-08T12:00:00Z');
  const store = new FakePrivateStore({ putTtlSeconds: 60, clock: () => now });
  const signed = store.signPut({ key: 'k/1', contentType: 'audio/wav', contentLength: 3 });
  now = new Date('2026-09-08T12:00:59Z');
  assert.ok(store.put(signed.url, Buffer.from('abc'), { 'content-type': 'audio/wav' }).ok);
  store.delete('k/1');
  now = new Date('2026-09-08T12:01:01Z');
  const late = store.put(signed.url, Buffer.from('abc'), { 'content-type': 'audio/wav' });
  assert.equal(late.ok, false);
  if (!late.ok) assert.equal(late.code, 'url_expired');
});

test('una URL que este store no emitió no vale', () => {
  const store = new FakePrivateStore();
  const outcome = store.put('https://fake-private.local/k?token=inventado', Buffer.from('x'));
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.code, 'url_unknown');
});

test('una URL de GET no sirve para subir', () => {
  const store = new FakePrivateStore();
  const signed = store.signGet({ key: 'k/1' });
  const outcome = store.put(signed.url, Buffer.from('x'));
  assert.equal(outcome.ok, false);
});

test('el GET firmado sirve rangos y responde 206', () => {
  const store = new FakePrivateStore();
  store.seed('k/1', Buffer.from('0123456789'));
  const signed = store.signGet({ key: 'k/1', forRangeReads: true });
  const full = store.get(signed.url);
  assert.ok(full.ok && full.status === 200 && full.bytes.toString() === '0123456789');
  const part = store.get(signed.url, { start: 2, end: 5 });
  assert.ok(part.ok && part.status === 206 && part.bytes.toString() === '2345');
  // Sin final: hasta el fin del objeto.
  const tail = store.get(signed.url, { start: 8 });
  assert.ok(tail.ok && tail.bytes.toString() === '89');
  // Más allá del final: se recorta, no falla.
  const over = store.get(signed.url, { start: 8, end: 99 });
  assert.ok(over.ok && over.bytes.toString() === '89');
});

test('renovar la URL da otra distinta y la vieja sigue viva hasta caducar', () => {
  const store = new FakePrivateStore();
  store.seed('k/1', Buffer.from('abc'));
  const first = store.signGet({ key: 'k/1' });
  const second = store.signGet({ key: 'k/1' });
  assert.notEqual(first.url, second.url);
  assert.ok(store.get(first.url).ok);
  assert.ok(store.get(second.url).ok);
});

// ── confirm() ───────────────────────────────────────────────────────────────

test('confirm aprueba cuando el objeto, el tamaño y el checksum cuadran', async () => {
  const store = new FakePrivateStore();
  const body = Buffer.from('contenido-real');
  store.seed('k/1', body, 'application/x-ndjson');
  const result = await store.confirm({
    key: 'k/1',
    expectedBytes: body.length,
    expectedChecksumSha256Hex: sha256Hex(body),
    expectedContentType: 'application/x-ndjson',
  });
  assert.ok(result.ok);
  if (result.ok) assert.equal(result.checksumVerified, true);
});

test('confirm distingue los cuatro motivos de rechazo con códigos estables', async () => {
  const store = new FakePrivateStore();
  const body = Buffer.from('contenido-real');
  const hex = sha256Hex(body);

  const missing = await store.confirm({
    key: 'no/existe',
    expectedBytes: 1,
    expectedChecksumSha256Hex: hex,
  });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.code, 'object_missing');

  store.seed('k/1', body, 'application/x-ndjson');

  const size = await store.confirm({
    key: 'k/1',
    expectedBytes: body.length + 1,
    expectedChecksumSha256Hex: hex,
  });
  assert.equal(size.ok, false);
  if (!size.ok) assert.equal(size.code, 'size_mismatch');

  const type = await store.confirm({
    key: 'k/1',
    expectedBytes: body.length,
    expectedChecksumSha256Hex: hex,
    expectedContentType: 'audio/wav',
  });
  assert.equal(type.ok, false);
  if (!type.ok) assert.equal(type.code, 'content_type_mismatch');

  // Corrupción SIN cambio de tamaño: el caso que sólo el checksum ve.
  assert.ok(store.corrupt('k/1'));
  const checksum = await store.confirm({
    key: 'k/1',
    expectedBytes: body.length,
    expectedChecksumSha256Hex: hex,
  });
  assert.equal(checksum.ok, false);
  if (!checksum.ok) assert.equal(checksum.code, 'checksum_mismatch');
});

test('sin checksum reportado, confirm aprueba pero DICE que no lo verificó', () => {
  const result = evaluateConfirm(
    { key: 'k', expectedBytes: 3, expectedChecksumSha256Hex: 'a'.repeat(64) },
    {
      key: 'k',
      bytes: 3,
      contentType: 'application/x-ndjson',
      contentEncoding: null,
      checksumSha256Hex: null,
      lastModified: null,
    },
  );
  assert.ok(result.ok);
  if (result.ok) assert.equal(result.checksumVerified, false);
});

// ── Adaptador S3, con fetch inyectado ───────────────────────────────────────

function s3(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>) {
  return new S3PrivateStore(
    {
      endpoint: 'https://cuenta.r2.cloudflarestorage.com',
      bucket: 'mai-meetings-private',
      region: 'auto',
      credentials: { accessKeyId: 'AKID', secretAccessKey: 'SECRET' },
      putTtlSeconds: 900,
      getTtlSeconds: 3600,
      forcePathStyle: true,
    },
    { fetchImpl, clock: () => new Date('2026-09-08T12:00:00Z') },
  );
}

test('el adaptador pone el bucket en la ruta y firma la clave completa', () => {
  const store = s3(async () => new Response(null, { status: 200 }));
  const signed = store.signGet({ key: 't/a/c/b/m/c/original/source' });
  const url = new URL(signed.url);
  assert.equal(url.host, 'cuenta.r2.cloudflarestorage.com');
  assert.equal(url.pathname, '/mai-meetings-private/t/a/c/b/m/c/original/source');
  assert.ok(url.searchParams.get('X-Amz-Signature'));
});

test('con forcePathStyle=false el bucket va en el subdominio', () => {
  const store = new S3PrivateStore(
    {
      endpoint: 'https://s3.us-east-1.amazonaws.com',
      bucket: 'privado',
      region: 'us-east-1',
      credentials: { accessKeyId: 'A', secretAccessKey: 'S' },
      putTtlSeconds: 60,
      getTtlSeconds: 60,
      forcePathStyle: false,
    },
    { clock: () => new Date('2026-09-08T12:00:00Z') },
  );
  const url = new URL(store.signGet({ key: 'k' }).url);
  assert.equal(url.host, 'privado.s3.us-east-1.amazonaws.com');
  assert.equal(url.pathname, '/k');
});

test('el adaptador rechaza un endpoint http que no sea local', () => {
  assert.throws(
    () =>
      new S3PrivateStore({
        endpoint: 'http://r2.example.com',
        bucket: 'b',
        region: 'auto',
        credentials: { accessKeyId: 'A', secretAccessKey: 'S' },
        putTtlSeconds: 60,
        getTtlSeconds: 60,
        forcePathStyle: true,
      }),
    /debe ser https/,
  );
});

test('el adaptador tolera http SÓLO contra un emulador local', () => {
  const store = new S3PrivateStore({
    endpoint: 'http://127.0.0.1:9000',
    bucket: 'b',
    region: 'auto',
    credentials: { accessKeyId: 'A', secretAccessKey: 'S' },
    putTtlSeconds: 60,
    getTtlSeconds: 60,
    forcePathStyle: true,
  });
  assert.equal(store.driver, 's3');
});

test('signPut firma tipo, tamaño y checksum, y devuelve las cabeceras obligatorias', () => {
  const store = s3(async () => new Response(null, { status: 200 }));
  const hex = 'b'.repeat(64);
  const signed = store.signPut({
    key: 'k',
    contentType: 'audio/wav',
    contentLength: 4096,
    checksumSha256Hex: hex,
  });
  const headers = new URL(signed.url).searchParams.get('X-Amz-SignedHeaders') ?? '';
  assert.ok(headers.includes('content-length'));
  assert.ok(headers.includes('content-type'));
  assert.ok(headers.includes('x-amz-checksum-sha256'));
  assert.equal(signed.requiredHeaders['x-amz-checksum-sha256'], hexToBase64(hex));
});

test('head devuelve null en 404 y traduce las cabeceras en 200', async () => {
  const notFound = s3(async () => new Response(null, { status: 404 }));
  assert.equal(await notFound.head('k'), null);

  const hex = 'c'.repeat(64);
  const found = s3(
    async () =>
      new Response(null, {
        status: 200,
        headers: {
          'content-length': '1234',
          'content-type': 'application/x-ndjson',
          'content-encoding': 'gzip',
          'x-amz-checksum-sha256': hexToBase64(hex),
          'last-modified': 'Mon, 08 Sep 2026 12:00:00 GMT',
        },
      }),
  );
  const stat = await found.head('k');
  assert.equal(stat?.bytes, 1234);
  assert.equal(stat?.contentEncoding, 'gzip');
  assert.equal(stat?.checksumSha256Hex, hex);
  assert.ok(stat?.lastModified instanceof Date);
});

test('head pide el checksum explícitamente (S3 no lo devuelve si no)', async () => {
  let sentHeaders: Record<string, string> = {};
  const store = s3(async (_url, init) => {
    sentHeaders = (init?.headers ?? {}) as Record<string, string>;
    return new Response(null, { status: 200, headers: { 'content-length': '1' } });
  });
  await store.head('k');
  assert.equal(sentHeaders['x-amz-checksum-mode'], 'ENABLED');
});

test('un almacenamiento caído se reporta como storage_unavailable, no como objeto ausente', async () => {
  const store = s3(async () => {
    throw new Error('ECONNREFUSED');
  });
  const result = await store.confirm({
    key: 'k',
    expectedBytes: 1,
    expectedChecksumSha256Hex: 'a'.repeat(64),
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'storage_unavailable');
});

test('getBytes manda Range y falla si el almacenamiento lo IGNORA', async () => {
  let sent: Record<string, string> = {};
  const respecting = s3(async (_url, init) => {
    sent = (init?.headers ?? {}) as Record<string, string>;
    return new Response(Buffer.from('2345'), { status: 206 });
  });
  const bytes = await respecting.getBytes('k', { start: 2, end: 5 });
  assert.equal(sent.range, 'bytes=2-5');
  assert.equal(bytes.toString(), '2345');

  // Un 200 a un Range significa que devolvió el objeto entero: hay que notarlo,
  // porque leer 4 bytes y recibir 300 MB no es "casi correcto".
  const ignoring = s3(async () => new Response(Buffer.from('0123456789'), { status: 200 }));
  await assert.rejects(() => ignoring.getBytes('k', { start: 2, end: 5 }), /ignoró la cabecera Range/);
});

test('getBytes sin final manda un rango abierto', async () => {
  let sent: Record<string, string> = {};
  const store = s3(async (_url, init) => {
    sent = (init?.headers ?? {}) as Record<string, string>;
    return new Response(Buffer.from('89'), { status: 206 });
  });
  await store.getBytes('k', { start: 8 });
  assert.equal(sent.range, 'bytes=8-');
});

test('delete trata el 404 como éxito y cualquier otro error como fallo', async () => {
  await s3(async () => new Response(null, { status: 204 })).delete('k');
  await s3(async () => new Response(null, { status: 404 })).delete('k');
  await assert.rejects(
    () => s3(async () => new Response(null, { status: 500 })).delete('k'),
    /DELETE devolvió 500/,
  );
});

// ── Resolución desde el entorno ─────────────────────────────────────────────

const S3_ENV = {
  MEETINGS_STORAGE_ENDPOINT: 'https://cuenta.r2.cloudflarestorage.com',
  MEETINGS_STORAGE_BUCKET: 'mai-meetings-private',
  MEETINGS_STORAGE_ACCESS_KEY_ID: 'AKID',
  MEETINGS_STORAGE_SECRET_ACCESS_KEY: 'SECRET',
} as const;

test('con las cuatro variables se construye el adaptador S3', () => {
  const resolution = resolveMeetingsStorage(S3_ENV);
  assert.equal(resolution.driver, 's3');
  assert.deepEqual(resolution.problems, []);
  assert.equal(resolution.putTtlSeconds, 900);
  assert.equal(resolution.getTtlSeconds, 3600);
});

test('falta una variable → no hay store y se dice CUÁL falta', () => {
  const { MEETINGS_STORAGE_SECRET_ACCESS_KEY, ...incomplete } = S3_ENV;
  const resolution = resolveMeetingsStorage(incomplete);
  assert.equal(resolution.store, null);
  assert.match(resolution.problems.join(' '), /MEETINGS_STORAGE_SECRET_ACCESS_KEY/);
});

test('el bucket privado NO puede ser el público de logos', () => {
  const problems = assertSeparateFromPublicBucket({
    ...S3_ENV,
    R2_BUCKET_NAME: 'mai-meetings-private',
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /lectura anónima/);
  const resolution = resolveMeetingsStorage({ ...S3_ENV, R2_BUCKET_NAME: 'mai-meetings-private' });
  assert.equal(resolution.store, null);
});

test('un bucket privado con URL pública configurada se rechaza', () => {
  const resolution = resolveMeetingsStorage({
    ...S3_ENV,
    MEETINGS_STORAGE_PUBLIC_URL: 'https://pub-x.r2.dev',
  });
  assert.equal(resolution.store, null);
  assert.match(resolution.problems.join(' '), /no debe tener base pública/);
});

test('buckets distintos conviven sin problema', () => {
  const resolution = resolveMeetingsStorage({ ...S3_ENV, R2_BUCKET_NAME: 'mai-public-logos' });
  assert.equal(resolution.driver, 's3');
  assert.deepEqual(resolution.problems, []);
});

test('el driver fake sólo se elige EXPLÍCITAMENTE, nunca por defecto', () => {
  assert.equal(resolveMeetingsStorage({}).driver, null, 'sin configuración no hay store');
  const fake = resolveMeetingsStorage({ MEETINGS_STORAGE_DRIVER: 'fake' });
  assert.equal(fake.driver, 'fake');
  assert.ok(fake.store);
});

test('las caducidades son configurables y un valor ilegible cae al defecto', () => {
  const custom = resolveMeetingsStorage({
    ...S3_ENV,
    MEETINGS_STORAGE_PUT_TTL_SECONDS: '120',
    MEETINGS_STORAGE_GET_TTL_SECONDS: '7200',
  });
  assert.equal(custom.putTtlSeconds, 120);
  assert.equal(custom.getTtlSeconds, 7200);
  const bad = resolveMeetingsStorage({ ...S3_ENV, MEETINGS_STORAGE_PUT_TTL_SECONDS: '-5' });
  assert.equal(bad.putTtlSeconds, 900);
});

// ── Nada de secretos en logs ────────────────────────────────────────────────

test('describeStorage no filtra credenciales', () => {
  const resolution = resolveMeetingsStorage(S3_ENV);
  const described = JSON.stringify(describeStorage(resolution, S3_ENV));
  assert.ok(!described.includes('SECRET'), described);
  assert.ok(!described.includes('AKID'), described);
  assert.ok(described.includes('mai-meetings-private'), 'el bucket sí se registra');
});

test('redactSignedUrl tira TODA la query, que es donde va la firma', () => {
  const store = s3(async () => new Response(null, { status: 200 }));
  const signed = store.signPut({ key: 't/a/objeto', contentType: 'audio/wav', contentLength: 10 });
  const redacted = redactSignedUrl(signed.url);
  assert.equal(
    redacted,
    'https://cuenta.r2.cloudflarestorage.com/mai-meetings-private/t/a/objeto?<firma-omitida>',
  );
  assert.ok(!redacted.includes('X-Amz-Signature'));
  assert.ok(!redacted.includes('X-Amz-Credential'));
  assert.ok(!redacted.includes('AKID'));
});

test('redactSignedUrl no revienta con una URL ilegible', () => {
  assert.equal(redactSignedUrl('no-es-una-url'), '<url-ilegible>');
});

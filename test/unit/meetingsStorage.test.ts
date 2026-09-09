import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
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
import { S3Client } from '@aws-sdk/client-s3';
import {
  MAX_PRESIGN_SECONDS,
  S3PrivateStore,
  evaluateConfirm,
  sha256Hex,
} from '../../src/storage/s3PrivateStore.js';
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
 * El firmado lo hace el SDK oficial (@aws-sdk/s3-request-presigner), así que
 * aquí no se prueba criptografía. Lo que se prueba es lo que sigue siendo
 * nuestro: a qué bucket y clave apunta la URL, qué cabeceras entran de verdad
 * en la firma —de eso depende que los límites no sean opcionales—, cómo se
 * codifica una clave con caracteres especiales, y cómo se traducen las
 * respuestas raras del almacenamiento a nuestros códigos.
 */

const TENANT = '11111111-1111-1111-1111-111111111111';
const CLIENT = 'aaaa0001-0000-0000-0000-000000000000';
const MEETING = 'dead0001-0000-0000-0000-000000000000';
const RUN = 'beef0001-0000-0000-0000-000000000000';
const SCOPE = { tenantId: TENANT, clientId: CLIENT, meetingId: MEETING };

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

test('el fake acepta una subida que respeta lo firmado', async () => {
  const store = new FakePrivateStore();
  const body = Buffer.from('audio-falso');
  const signed = await store.signPut({
    key: 'k/1',
    contentType: 'audio/wav',
    contentLength: body.length,
    checksumSha256Hex: sha256Hex(body),
  });
  const outcome = store.put(signed.url, body, { 'content-type': 'audio/wav' });
  assert.ok(outcome.ok, JSON.stringify(outcome));
});

test('el fake RECHAZA un cuerpo de otro tamaño que el firmado', async () => {
  const store = new FakePrivateStore();
  const signed = await store.signPut({ key: 'k/1', contentType: 'audio/wav', contentLength: 5 });
  const outcome = store.put(signed.url, Buffer.from('mucho mas largo'), {
    'content-type': 'audio/wav',
  });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.code, 'signature_mismatch');
});

test('el fake RECHAZA un cuerpo cuyo checksum no es el firmado', async () => {
  const store = new FakePrivateStore();
  const body = Buffer.from('lo-prometido');
  const signed = await store.signPut({
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

test('el fake RECHAZA otro content-type del firmado', async () => {
  const store = new FakePrivateStore();
  const signed = await store.signPut({ key: 'k/1', contentType: 'audio/wav', contentLength: 3 });
  const outcome = store.put(signed.url, Buffer.from('abc'), { 'content-type': 'text/html' });
  assert.equal(outcome.ok, false);
});

test('una URL de subida caducada deja de valer', async () => {
  let now = new Date('2026-09-08T12:00:00Z');
  const store = new FakePrivateStore({ putTtlSeconds: 60, clock: () => now });
  const signed = await store.signPut({ key: 'k/1', contentType: 'audio/wav', contentLength: 3 });
  now = new Date('2026-09-08T12:00:59Z');
  assert.ok(store.put(signed.url, Buffer.from('abc'), { 'content-type': 'audio/wav' }).ok);
  store.delete('k/1');
  now = new Date('2026-09-08T12:01:01Z');
  const late = store.put(signed.url, Buffer.from('abc'), { 'content-type': 'audio/wav' });
  assert.equal(late.ok, false);
  if (!late.ok) assert.equal(late.code, 'url_expired');
});

test('una URL que este store no emitió no vale', async () => {
  const store = new FakePrivateStore();
  const outcome = store.put('https://fake-private.local/k?token=inventado', Buffer.from('x'));
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.code, 'url_unknown');
});

test('una URL de GET no sirve para subir', async () => {
  const store = new FakePrivateStore();
  const signed = await store.signGet({ key: 'k/1' });
  const outcome = store.put(signed.url, Buffer.from('x'));
  assert.equal(outcome.ok, false);
});

test('el GET firmado sirve rangos y responde 206', async () => {
  const store = new FakePrivateStore();
  store.seed('k/1', Buffer.from('0123456789'));
  const signed = await store.signGet({ key: 'k/1', forRangeReads: true });
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

test('renovar la URL da otra distinta y la vieja sigue viva hasta caducar', async () => {
  const store = new FakePrivateStore();
  store.seed('k/1', Buffer.from('abc'));
  const first = await store.signGet({ key: 'k/1' });
  const second = await store.signGet({ key: 'k/1' });
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

test('redactSignedUrl tira TODA la query, que es donde va la firma', async () => {
  // Sobre una URL REAL del adaptador, no una construida a mano: así la prueba
  // sigue valiendo si el SDK cambia qué parámetros pone en la query.
  const signed = await s3().signPut({
    key: 't/a/objeto',
    contentType: 'audio/wav',
    contentLength: 10,
  });
  assert.ok(signed.url.includes('X-Amz-Signature'), 'la URL sin redactar sí lleva la firma');
  const redacted = redactSignedUrl(signed.url);
  assert.equal(
    redacted,
    'https://cuenta.r2.cloudflarestorage.com/mai-meetings-private/t/a/objeto?<firma-omitida>',
  );
  assert.ok(!redacted.includes('X-Amz-Signature'));
  assert.ok(!redacted.includes('X-Amz-Credential'));
  assert.ok(!redacted.includes('AKIAIOSFODNN7EXAMPLE'));
});

test('redactSignedUrl no revienta con una URL ilegible', () => {
  assert.equal(redactSignedUrl('no-es-una-url'), '<url-ilegible>');
});

// ══════════════════════════════════════════════════════════════════════════
// Adaptador S3/R2 sobre el SDK oficial
// ══════════════════════════════════════════════════════════════════════════
//
// Ya no se prueba criptografía propia: la firma la hace
// @aws-sdk/s3-request-presigner. Lo que estas pruebas verifican es lo que sigue
// siendo NUESTRO y sigue pudiendo estar mal:
//
//   · que la URL apunte al bucket y a la clave correctos, con el estilo de ruta
//     que R2 necesita;
//   · que las cabeceras que hacen cumplir los límites entren DE VERDAD en
//     X-Amz-SignedHeaders — si no, serían sugerencias;
//   · que una clave con espacios o caracteres especiales viaje codificada;
//   · que el token de sesión aparezca cuando se configura;
//   · que las respuestas raras del almacenamiento (404, 200 a un Range,
//     checksum ausente, caída) se traduzcan a nuestros códigos.

const S3_CONFIG = {
  endpoint: 'https://cuenta.r2.cloudflarestorage.com',
  bucket: 'mai-meetings-private',
  region: 'auto',
  credentials: { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' },
  putTtlSeconds: 900,
  getTtlSeconds: 3600,
  forcePathStyle: true,
} as const;

/** Un S3Client cuyo `send` responde lo que la prueba diga, sin red. */
function stubClient(handler: (command: unknown) => unknown): S3Client {
  const client = new S3Client({
    region: 'auto',
    endpoint: S3_CONFIG.endpoint,
    forcePathStyle: true,
    credentials: S3_CONFIG.credentials,
  });
  (client as unknown as { send: (command: unknown) => Promise<unknown> }).send = async (command) => {
    const result = handler(command);
    if (result instanceof Error) throw result;
    return result;
  };
  return client;
}

function s3(handler?: (command: unknown) => unknown): S3PrivateStore {
  return new S3PrivateStore(S3_CONFIG, {
    client: handler ? stubClient(handler) : undefined,
  });
}

test('la URL prefirmada apunta al bucket en la ruta y a la clave exacta', async () => {
  const signed = await s3().signGet({ key: 't/a/c/b/m/c/original/source' });
  const url = new URL(signed.url);
  assert.equal(url.host, 'cuenta.r2.cloudflarestorage.com');
  assert.equal(url.pathname, '/mai-meetings-private/t/a/c/b/m/c/original/source');
  assert.equal(url.searchParams.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
  assert.ok(url.searchParams.get('X-Amz-Signature'));
  assert.equal(url.searchParams.get('X-Amz-Expires'), '3600');
});

test('con forcePathStyle=false el bucket va en el subdominio', async () => {
  const store = new S3PrivateStore({
    ...S3_CONFIG,
    endpoint: 'https://s3.us-east-1.amazonaws.com',
    bucket: 'privado',
    region: 'us-east-1',
    forcePathStyle: false,
  });
  const url = new URL((await store.signGet({ key: 'k' })).url);
  assert.equal(url.host, 'privado.s3.us-east-1.amazonaws.com');
  assert.equal(url.pathname, '/k');
});

test('el secreto NUNCA aparece en la URL firmada', async () => {
  const signed = await s3().signPut({
    key: 'k',
    contentType: 'audio/wav',
    contentLength: 10,
  });
  assert.ok(!signed.url.includes(S3_CONFIG.credentials.secretAccessKey));
  // El access key id sí va, dentro de X-Amz-Credential: es público por diseño.
  assert.ok(signed.url.includes('AKIAIOSFODNN7EXAMPLE'));
});

test('una clave con espacios y caracteres especiales viaja CODIFICADA', async () => {
  // No es hipotético: la reunión no elige la clave, pero un rol o un nombre de
  // objeto futuro podría traerlos, y una clave mal codificada da un 403 que no
  // se puede diagnosticar desde el cliente.
  const key = 't/a/reunión con espacio/y(paréntesis)/año+2026/objeto&raro.wav';
  const signed = await s3().signGet({ key });
  const url = new URL(signed.url);
  assert.ok(!url.pathname.includes(' '), url.pathname);
  assert.ok(url.pathname.includes('%20'), url.pathname);
  assert.ok(url.pathname.includes('%28') && url.pathname.includes('%29'), url.pathname);
  // Y la ruta decodificada recupera la clave original íntegra.
  assert.equal(decodeURIComponent(url.pathname), `/${S3_CONFIG.bucket}/${key}`);
});

test('las barras de la clave se conservan como separadores, no se codifican', async () => {
  const signed = await s3().signGet({ key: 't/a/b/c/objeto' });
  assert.equal(new URL(signed.url).pathname, '/mai-meetings-private/t/a/b/c/objeto');
});

test('content-type, content-length y checksum entran en X-Amz-SignedHeaders', async () => {
  const hex = 'b'.repeat(64);
  const signed = await s3().signPut({
    key: 'k',
    contentType: 'application/x-ndjson',
    contentLength: 4096,
    checksumSha256Hex: hex,
    contentEncoding: 'gzip',
  });
  const headers = (new URL(signed.url).searchParams.get('X-Amz-SignedHeaders') ?? '').split(';');
  // Sin esto, las cabeceras serían sugerencias y los límites, opcionales.
  for (const name of ['content-length', 'content-type', 'content-encoding', 'host', 'x-amz-checksum-sha256']) {
    assert.ok(headers.includes(name), `${name} debe ir firmada; van: ${headers.join(',')}`);
  }
  assert.deepEqual(signed.requiredHeaders, {
    'content-type': 'application/x-ndjson',
    'content-length': '4096',
    'content-encoding': 'gzip',
    'x-amz-checksum-sha256': hexToBase64(hex),
  });
});

test('sin checksum no se firma la cabecera de checksum', async () => {
  const signed = await s3().signPut({ key: 'k', contentType: 'audio/wav', contentLength: 10 });
  const headers = new URL(signed.url).searchParams.get('X-Amz-SignedHeaders') ?? '';
  assert.ok(!headers.includes('checksum'), headers);
  assert.ok(!('x-amz-checksum-sha256' in signed.requiredHeaders));
});

test('cambiar el tamaño firmado cambia la firma', async () => {
  const store = s3();
  const a = await store.signPut({ key: 'k', contentType: 'audio/wav', contentLength: 10 });
  const b = await store.signPut({ key: 'k', contentType: 'audio/wav', contentLength: 11 });
  const sig = (u: string) => new URL(u).searchParams.get('X-Amz-Signature');
  assert.notEqual(sig(a.url), sig(b.url));
});

test('un token de sesión se incluye como X-Amz-Security-Token', async () => {
  const store = new S3PrivateStore({
    ...S3_CONFIG,
    credentials: { ...S3_CONFIG.credentials, sessionToken: 'FQoDYXdzE-token-temporal' },
  });
  const params = new URL((await store.signGet({ key: 'k' })).url).searchParams;
  assert.equal(params.get('X-Amz-Security-Token'), 'FQoDYXdzE-token-temporal');
});

test('sin token de sesión el parámetro NO aparece', async () => {
  const params = new URL((await s3().signGet({ key: 'k' })).url).searchParams;
  assert.equal(params.get('X-Amz-Security-Token'), null);
});

test('la caducidad se puede acortar por llamada y se refleja en la URL', async () => {
  const signed = await s3().signPut({
    key: 'k',
    contentType: 'audio/wav',
    contentLength: 10,
    expiresInSeconds: 120,
  });
  assert.equal(new URL(signed.url).searchParams.get('X-Amz-Expires'), '120');
  assert.ok(signed.expiresAt.getTime() > Date.now());
  assert.ok(signed.expiresAt.getTime() <= Date.now() + 121_000);
});

test('se rechazan caducidades imposibles antes de firmar', async () => {
  const store = s3();
  await assert.rejects(
    () => store.signGet({ key: 'k', expiresInSeconds: 0 }),
    /entero >= 1/,
  );
  await assert.rejects(
    () => store.signGet({ key: 'k', expiresInSeconds: MAX_PRESIGN_SECONDS + 1 }),
    /máximo/,
  );
});

test('signPut exige un contentLength entero positivo', async () => {
  const store = s3();
  await assert.rejects(
    () => store.signPut({ key: 'k', contentType: 'audio/wav', contentLength: 0 }),
    /entero positivo/,
  );
  await assert.rejects(
    () => store.signPut({ key: 'k', contentType: 'audio/wav', contentLength: 1.5 }),
    /entero positivo/,
  );
});

test('una clave vacía o absoluta se rechaza', async () => {
  const store = s3();
  await assert.rejects(() => store.signGet({ key: '' }), /no puede estar vacía/);
  await assert.rejects(() => store.signGet({ key: '/absoluta' }), /no debe empezar por/);
});

test('el adaptador rechaza un endpoint http que no sea local', () => {
  assert.throws(
    () => new S3PrivateStore({ ...S3_CONFIG, endpoint: 'http://r2.example.com' }),
    /debe ser https/,
  );
});

test('el adaptador tolera http SÓLO contra un emulador local', () => {
  const store = new S3PrivateStore({ ...S3_CONFIG, endpoint: 'http://127.0.0.1:9000' });
  assert.equal(store.driver, 's3');
});

test('head devuelve null en 404 y traduce las cabeceras cuando existe', async () => {
  const notFound = s3(() => Object.assign(new Error('NotFound'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } }));
  assert.equal(await notFound.head('k'), null);

  const hex = 'c'.repeat(64);
  const found = s3(() => ({
    ContentLength: 1234,
    ContentType: 'application/x-ndjson',
    ContentEncoding: 'gzip',
    ChecksumSHA256: hexToBase64(hex),
    LastModified: new Date('2026-09-08T12:00:00Z'),
    $metadata: { httpStatusCode: 200 },
  }));
  const stat = await found.head('k');
  assert.equal(stat?.bytes, 1234);
  assert.equal(stat?.contentEncoding, 'gzip');
  assert.equal(stat?.checksumSha256Hex, hex);
  assert.ok(stat?.lastModified instanceof Date);
});

test('head pide el checksum explícitamente: S3 no lo devuelve si no', async () => {
  let checksumMode: unknown;
  const store = s3((command) => {
    checksumMode = (command as { input?: { ChecksumMode?: string } }).input?.ChecksumMode;
    return { ContentLength: 1, $metadata: { httpStatusCode: 200 } };
  });
  await store.head('k');
  assert.equal(checksumMode, 'ENABLED');
});

test('un almacenamiento caído se reporta como storage_unavailable, no como objeto ausente', async () => {
  const store = s3(() => new Error('ECONNREFUSED'));
  const result = await store.confirm({
    key: 'k',
    expectedBytes: 1,
    expectedChecksumSha256Hex: 'a'.repeat(64),
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'storage_unavailable');
});

test('getBytes manda Range y falla si el almacenamiento lo IGNORA', async () => {
  let sentRange: unknown;
  const respecting = s3((command) => {
    sentRange = (command as { input?: { Range?: string } }).input?.Range;
    return { Body: Buffer.from('2345'), $metadata: { httpStatusCode: 206 } };
  });
  assert.equal((await respecting.getBytes('k', { start: 2, end: 5 })).toString(), '2345');
  assert.equal(sentRange, 'bytes=2-5');

  // Un 200 a un Range significa que devolvió el objeto entero. Leer 4 bytes y
  // recibir 300 MB no es "casi correcto".
  const ignoring = s3(() => ({ Body: Buffer.from('0123456789'), $metadata: { httpStatusCode: 200 } }));
  await assert.rejects(() => ignoring.getBytes('k', { start: 2, end: 5 }), /ignoró la cabecera Range/);
});

test('getBytes sin final manda un rango abierto', async () => {
  let sentRange: unknown;
  const store = s3((command) => {
    sentRange = (command as { input?: { Range?: string } }).input?.Range;
    return { Body: Buffer.from('89'), $metadata: { httpStatusCode: 206 } };
  });
  await store.getBytes('k', { start: 8 });
  assert.equal(sentRange, 'bytes=8-');
});

test('getBytes junta un cuerpo en streaming del SDK', async () => {
  // El SDK devuelve un objeto con transformToByteArray en Node; se cubre la
  // rama de async iterator, que es la que aparece en otros runtimes.
  async function* chunks(): AsyncGenerator<Uint8Array> {
    yield Buffer.from('hola ');
    yield Buffer.from('mundo');
  }
  const store = s3(() => ({ Body: chunks(), $metadata: { httpStatusCode: 200 } }));
  assert.equal((await store.getBytes('k')).toString(), 'hola mundo');
});

test('delete trata el 404 como éxito y cualquier otro error como fallo', async () => {
  await s3(() => ({ $metadata: { httpStatusCode: 204 } })).delete('k');
  await s3(() => Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' })).delete('k');
  await assert.rejects(
    () => s3(() => Object.assign(new Error('boom'), { $metadata: { httpStatusCode: 500 } })).delete('k'),
    /DELETE falló/,
  );
});

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  ClaimBody,
  CreateMeetingBody,
  FailBody,
  HeartbeatBody,
  MaintenanceBody,
  MeetingStateQuery,
  ResultCompleteBody,
  ResultInitBody,
  SOURCE_KINDS,
  UploadCompleteBody,
  UploadInitBody,
  isUuid,
  parseBody,
} from '../../web/lib/meetingsValidation.js';

/**
 * La validación de los cuerpos de `/api/meetings/v1`, en aislamiento.
 *
 * Estas pruebas cubren la FORMA; las de `meetingsRoutes.test.ts` cubren que los
 * handlers la apliquen. Separarlas importa: una validación correcta que ninguna
 * ruta invoca no sirve de nada, y una ruta que valida con un esquema
 * equivocado tampoco.
 */

const UUID = '11111111-1111-1111-1111-111111111111';
const SHA = 'a'.repeat(64);
const TOKEN = 'mlt_' + 'x'.repeat(30);

function bad<T extends Parameters<typeof parseBody>[0]>(schema: T, input: unknown): string {
  const result = parseBody(schema, input);
  assert.equal(result.ok, false, `debería fallar: ${JSON.stringify(input)}`);
  return result.ok ? '' : result.error;
}

// ── isUuid ──────────────────────────────────────────────────────────────────

test('isUuid acepta un uuid y rechaza lo que se le parece', () => {
  assert.ok(isUuid(UUID));
  assert.ok(isUuid(UUID.toUpperCase()));
  assert.ok(!isUuid('11111111-1111-1111-1111-11111111111'));
  assert.ok(!isUuid('11111111111111111111111111111111'));
  assert.ok(!isUuid(''));
  assert.ok(!isUuid(null));
  assert.ok(!isUuid(123));
});

// ── Claves desconocidas ─────────────────────────────────────────────────────

test('un campo desconocido se rechaza y se NOMBRA en el mensaje', () => {
  // El caso que más importa: `tenantId` es exactamente el campo que nunca debe
  // leerse de la petición.
  const error = bad(CreateMeetingBody, {
    clientId: UUID,
    title: 'X',
    idempotencyKey: 'k',
    tenantId: UUID,
  });
  assert.match(error, /no reconocido/);
  assert.match(error, /tenantId/);
});

test('TODOS los esquemas rechazan claves desconocidas', () => {
  const cases: Array<[Parameters<typeof parseBody>[0], Record<string, unknown>]> = [
    [CreateMeetingBody, { clientId: UUID, title: 'X', idempotencyKey: 'k' }],
    [UploadInitBody, { clientId: UUID, filename: 'a.wav', contentType: 'audio/wav', bytes: 1 }],
    [UploadCompleteBody, { clientId: UUID, bytes: 1, checksumSha256: SHA }],
    [ClaimBody, {}],
    [HeartbeatBody, { attempt: 1, leaseToken: TOKEN }],
    [FailBody, { attempt: 1, leaseToken: TOKEN, failureCode: 'x' }],
    [ResultInitBody, { attempt: 1, leaseToken: TOKEN, bytes: 1, checksumSha256: SHA }],
    [ResultCompleteBody, { attempt: 1, leaseToken: TOKEN, bytes: 1, checksumSha256: SHA }],
    [MaintenanceBody, {}],
    [MeetingStateQuery, { clientId: UUID }],
  ];
  for (const [schema, valid] of cases) {
    assert.ok(parseBody(schema, valid).ok, `el caso válido debería pasar: ${JSON.stringify(valid)}`);
    assert.match(bad(schema, { ...valid, sobra: 1 }), /no reconocido/);
  }
});

// ── Sin coerción ────────────────────────────────────────────────────────────

test('no hay coerción: "1" no es 1, "true" no es true', () => {
  assert.match(bad(HeartbeatBody, { attempt: '1', leaseToken: TOKEN }), /attempt/);
  assert.match(bad(ResultInitBody, { attempt: 1, leaseToken: TOKEN, bytes: '10', checksumSha256: SHA }), /bytes/);
  assert.match(
    bad(ResultCompleteBody, {
      attempt: 1,
      leaseToken: TOKEN,
      bytes: 1,
      checksumSha256: SHA,
      probe: { channels: '1' },
    }),
    /channels/,
  );
});

test('los enteros se exigen enteros', () => {
  assert.match(bad(HeartbeatBody, { attempt: 1.5, leaseToken: TOKEN }), /attempt/);
  assert.match(bad(ResultInitBody, { attempt: 1, leaseToken: TOKEN, bytes: 1.5, checksumSha256: SHA }), /bytes/);
});

// ── Enums ───────────────────────────────────────────────────────────────────

test('sourceKind acepta sólo los cinco valores del CHECK y rechaza el resto', () => {
  for (const kind of SOURCE_KINDS) {
    assert.ok(parseBody(CreateMeetingBody, {
      clientId: UUID, title: 'X', idempotencyKey: 'k', sourceKind: kind,
    }).ok, kind);
  }
  // Antes esto se resolvía con un cast y llegaba al INSERT: la violación de
  // CHECK salía como 500.
  assert.match(
    bad(CreateMeetingBody, { clientId: UUID, title: 'X', idempotencyKey: 'k', sourceKind: 'loquesea' }),
    /sourceKind/,
  );
  assert.match(
    bad(CreateMeetingBody, { clientId: UUID, title: 'X', idempotencyKey: 'k', sourceKind: 'FILE' }),
    /sourceKind/,
  );
});

test('las capacidades del claim son un array de un enum, acotado', () => {
  assert.ok(parseBody(ClaimBody, { capabilities: ['meetings.transcribe'] }).ok);
  assert.match(bad(ClaimBody, { capabilities: ['meetings.inventada'] }), /capabilities/);
  assert.match(bad(ClaimBody, { capabilities: [] }), /capabilities/);
  assert.match(bad(ClaimBody, { capabilities: 'meetings.transcribe' }), /capabilities/);
  // `meetings.maintenance` NO es reclamable, así que no cabe en este filtro.
  assert.match(bad(ClaimBody, { capabilities: ['meetings.maintenance'] }), /capabilities/);
});

// ── UUIDs, ISO, SHA-256 ─────────────────────────────────────────────────────

test('los uuid se validan por forma, no por longitud', () => {
  assert.match(bad(CreateMeetingBody, { clientId: 'no-uuid', title: 'X', idempotencyKey: 'k' }), /clientId/);
  assert.match(bad(MeetingStateQuery, { clientId: '' }), /clientId/);
});

test('startedAt exige ISO 8601 CON offset', () => {
  const base = { clientId: UUID, title: 'X', idempotencyKey: 'k' };
  assert.ok(parseBody(CreateMeetingBody, { ...base, startedAt: '2026-09-08T12:00:00Z' }).ok);
  assert.ok(parseBody(CreateMeetingBody, { ...base, startedAt: '2026-09-08T12:00:00+02:00' }).ok);
  // Sin offset, «cuándo empezó» es ambiguo.
  assert.match(bad(CreateMeetingBody, { ...base, startedAt: '2026-09-08T12:00:00' }), /startedAt/);
  assert.match(bad(CreateMeetingBody, { ...base, startedAt: '2026-09-08 12:00:00' }), /startedAt/);
  assert.match(bad(CreateMeetingBody, { ...base, startedAt: '08/09/2026' }), /startedAt/);
  // null y ausente sí valen: es opcional.
  assert.ok(parseBody(CreateMeetingBody, { ...base, startedAt: null }).ok);
  assert.ok(parseBody(CreateMeetingBody, base).ok);
});

test('el checksum exige 64 hex exactos', () => {
  const base = { attempt: 1, leaseToken: TOKEN, bytes: 1 };
  assert.ok(parseBody(ResultInitBody, { ...base, checksumSha256: SHA }).ok);
  assert.ok(parseBody(ResultInitBody, { ...base, checksumSha256: SHA.toUpperCase() }).ok);
  assert.match(bad(ResultInitBody, { ...base, checksumSha256: 'a'.repeat(63) }), /checksum/);
  assert.match(bad(ResultInitBody, { ...base, checksumSha256: 'a'.repeat(65) }), /checksum/);
  assert.match(bad(ResultInitBody, { ...base, checksumSha256: 'z'.repeat(64) }), /checksum/);
});

// ── Cotas ───────────────────────────────────────────────────────────────────

test('las cotas evitan que una violación de constraint se convierta en 500', () => {
  // attempt es smallint en la base.
  assert.match(bad(HeartbeatBody, { attempt: -1, leaseToken: TOKEN }), /attempt/);
  assert.match(bad(HeartbeatBody, { attempt: 100000, leaseToken: TOKEN }), /attempt/);
  // progress_pct tiene un CHECK 0..100.
  assert.match(bad(HeartbeatBody, { attempt: 1, leaseToken: TOKEN, progressPct: 101 }), /progressPct/);
  assert.match(bad(HeartbeatBody, { attempt: 1, leaseToken: TOKEN, progressPct: -1 }), /progressPct/);
  // bytes positivo: un 0 firmaría un PUT vacío.
  assert.match(bad(ResultInitBody, { attempt: 1, leaseToken: TOKEN, bytes: 0, checksumSha256: SHA }), /bytes/);
});

test('los textos tienen límite y se recorta el relleno', () => {
  const long = 'x'.repeat(600);
  assert.match(bad(CreateMeetingBody, { clientId: UUID, title: long, idempotencyKey: 'k' }), /title/);
  assert.match(
    bad(CreateMeetingBody, { clientId: UUID, title: 'X', idempotencyKey: 'k'.repeat(300) }),
    /idempotencyKey/,
  );
  // Un título de espacios es vacío tras recortar.
  assert.match(bad(CreateMeetingBody, { clientId: UUID, title: '   ', idempotencyKey: 'k' }), /title/);
  const parsed = parseBody(CreateMeetingBody, { clientId: UUID, title: '  Hola  ', idempotencyKey: ' k ' });
  assert.ok(parsed.ok);
  if (parsed.ok) {
    assert.equal(parsed.value.title, 'Hola');
    assert.equal(parsed.value.idempotencyKey, 'k');
  }
});

test('failureCode exige lower_snake_case y una longitud razonable', () => {
  const base = { attempt: 1, leaseToken: TOKEN };
  assert.ok(parseBody(FailBody, { ...base, failureCode: 'audio_unreadable' }).ok);
  assert.match(bad(FailBody, { ...base, failureCode: 'Audio Unreadable' }), /failureCode/);
  assert.match(bad(FailBody, { ...base, failureCode: 'audio-unreadable' }), /failureCode/);
  assert.match(bad(FailBody, { ...base, failureCode: 'x'.repeat(100) }), /failureCode/);
  assert.match(bad(FailBody, { ...base, failureCode: '' }), /failureCode/);
});

test('el detalle de fallo se rechaza si excede, en vez de recortarse en silencio', () => {
  const base = { attempt: 1, leaseToken: TOKEN, failureCode: 'x' };
  assert.ok(parseBody(FailBody, { ...base, failureDetail: 'y'.repeat(2000) }).ok);
  assert.match(bad(FailBody, { ...base, failureDetail: 'y'.repeat(2001) }), /failureDetail/);
});

test('schemaVersion admite sólo la versión que mai sabe leer', () => {
  const base = { attempt: 1, leaseToken: TOKEN, bytes: 1, checksumSha256: SHA };
  assert.ok(parseBody(ResultInitBody, { ...base, schemaVersion: 1 }).ok);
  assert.ok(parseBody(ResultInitBody, base).ok, 'ausente = 1');
  assert.match(bad(ResultInitBody, { ...base, schemaVersion: 2 }), /schemaVersion/);
  assert.match(bad(ResultInitBody, { ...base, schemaVersion: 99 }), /schemaVersion/);
});

test('el lease token tiene forma acotada', () => {
  assert.match(bad(HeartbeatBody, { attempt: 1, leaseToken: 'corto' }), /leaseToken/);
  assert.match(bad(HeartbeatBody, { attempt: 1, leaseToken: 'x'.repeat(600) }), /leaseToken/);
});

// ── Cuerpos vacíos y tipos raros ────────────────────────────────────────────

test('un cuerpo que no es objeto se rechaza sin lanzar', () => {
  for (const input of [null, undefined, 42, 'texto', [], true]) {
    const result = parseBody(CreateMeetingBody, input);
    assert.equal(result.ok, false, JSON.stringify(input));
  }
});

test('el barrido no lleva cuerpo: un objeto vacío vale, cualquier campo no', () => {
  assert.ok(parseBody(MaintenanceBody, {}).ok);
  assert.match(bad(MaintenanceBody, { tenantId: UUID }), /no reconocido/);
});

test('el mensaje de error NO devuelve el valor recibido', () => {
  // Un checksum mal formado puede ser cualquier cosa que alguien pegara por
  // error; devolverlo lo pondría en la respuesta y de ahí en un log.
  const secreto = 'mtk_esto_parece_un_token_secreto_de_verdad';
  const error = bad(ResultInitBody, {
    attempt: 1,
    leaseToken: TOKEN,
    bytes: 1,
    checksumSha256: secreto,
  });
  assert.ok(!error.includes(secreto), error);
  assert.match(error, /checksumSha256/);
});

test('el campo se nombra con su path completo cuando está anidado', () => {
  const error = bad(ResultCompleteBody, {
    attempt: 1,
    leaseToken: TOKEN,
    bytes: 1,
    checksumSha256: SHA,
    probe: { sampleRate: -1 },
  });
  assert.match(error, /probe\.sampleRate/);
});

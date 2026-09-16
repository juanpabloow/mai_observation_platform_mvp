import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { buildRequestedOptions } from '../../src/meetings/service.js';
import {
  SPEAKER_COUNT_MAX,
  SPEAKER_COUNT_MIN,
  UploadCompleteBody,
} from '../../web/lib/meetingsValidation.js';

/**
 * «¿Cuántas personas hablan?» — automático por defecto, número si se sabe.
 *
 * Lo que se afirma es la distinción que hace que esto sirva: AUTOMÁTICO no es 1, y
 * automático no deja rastro en las opciones del run. Un `speakerCount: null` guardado
 * haría que «alguien eligió automático» y «este run es anterior a la opción» tuvieran
 * formas distintas para el worker sin significar nada distinto.
 */

test('automático no escribe opciones: la ausencia ya es automático', () => {
  assert.deepEqual(buildRequestedOptions(null), {});
  assert.deepEqual(buildRequestedOptions(undefined), {});
});

test('un número sí se persiste, y sólo ese', () => {
  assert.deepEqual(buildRequestedOptions(2), { speakerCount: 2 });
  assert.deepEqual(buildRequestedOptions(1), { speakerCount: 1 }, '1 es una afirmación, no automático');
});

test('el cuerpo acepta automático de las tres formas equivalentes', () => {
  const base = {
    clientId: '11111111-1111-4111-8111-111111111111',
    bytes: 10,
    checksumSha256: 'a'.repeat(64),
  };
  for (const variant of [base, { ...base, speakerCount: null }, { ...base, speakerCount: undefined }]) {
    const parsed = UploadCompleteBody.parse(variant);
    assert.deepEqual(buildRequestedOptions(parsed.speakerCount), {});
  }
});

test('el cuerpo rechaza lo que el worker no podría honrar', () => {
  const base = {
    clientId: '11111111-1111-4111-8111-111111111111',
    bytes: 10,
    checksumSha256: 'a'.repeat(64),
  };
  assert.equal(SPEAKER_COUNT_MIN, 1);
  assert.equal(SPEAKER_COUNT_MAX, 10, 'el mismo diarization_max_speakers del worker');

  assert.ok(UploadCompleteBody.safeParse({ ...base, speakerCount: 10 }).success);
  for (const bad of [0, -1, 11, 2.5, '2']) {
    assert.equal(
      UploadCompleteBody.safeParse({ ...base, speakerCount: bad }).success,
      false,
      `speakerCount=${String(bad)} debe rechazarse en el 400, no acabar recortado en el worker`,
    );
  }
});

test('sigue siendo estricto: una clave desconocida no pasa', () => {
  const parsed = UploadCompleteBody.safeParse({
    clientId: '11111111-1111-4111-8111-111111111111',
    bytes: 10,
    checksumSha256: 'a'.repeat(64),
    diarizationBackend: 'pyannote_full',
  });
  assert.equal(parsed.success, false, 'el motor NO se elige desde la interfaz');
});

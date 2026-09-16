import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { MeetingsApiError } from '../../src/meetings/errors.js';
import {
  NORMALIZED_AUDIO,
  assertProbeMatchesStage,
  type MediaProbe,
} from '../../src/meetings/normalizedAudio.js';

/**
 * El contrato del sondeo de `normalize`, sin base de datos ni HTTP.
 *
 * Está probado también por los handlers y por el servicio, y las tres capas
 * miden cosas distintas: aquí, la REGLA; en el servicio, que se aplique antes
 * de escribir nada; en los handlers, que llegue al cliente con su código.
 */

const VALID: MediaProbe = {
  durationSeconds: 12.5,
  sampleRate: NORMALIZED_AUDIO.sampleRate,
  channels: NORMALIZED_AUDIO.channels,
  codec: NORMALIZED_AUDIO.codec,
};

function codeOf(fn: () => void): string {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof MeetingsApiError, `se esperaba MeetingsApiError: ${String(error)}`);
    return error.code;
  }
  return 'ninguno';
}

test('el formato pactado son 16 kHz, mono, pcm_s16le', () => {
  // Los mismos tres valores viven en el worker (app/pull/stages.py). Fijarlos
  // aquí es lo que hace que una discrepancia se detecte en el borde en vez de
  // propagarse hasta una transcripción rara.
  assert.deepEqual(NORMALIZED_AUDIO, { sampleRate: 16_000, channels: 1, codec: 'pcm_s16le' });
});

test('normalize con el sondeo pactado pasa', () => {
  assert.equal(codeOf(() => assertProbeMatchesStage('normalize', VALID)), 'ninguno');
});

test('normalize SIN sondeo es invalid_request', () => {
  assert.equal(codeOf(() => assertProbeMatchesStage('normalize', undefined)), 'invalid_request');
  // `null` explícito significa lo mismo que ausente: no hay sondeo.
  assert.equal(codeOf(() => assertProbeMatchesStage('normalize', null)), 'invalid_request');
});

test('normalize con el formato equivocado es media_rejected, campo a campo', () => {
  // El código es distinto del anterior a propósito: la petición está bien y
  // dice la verdad; lo que no vale es el medio que describe.
  for (const probe of [
    { ...VALID, sampleRate: 48_000 },
    { ...VALID, channels: 2 },
    { ...VALID, codec: 'aac' },
  ]) {
    assert.equal(
      codeOf(() => assertProbeMatchesStage('normalize', probe)),
      'media_rejected',
      JSON.stringify(probe),
    );
  }
});

test('el mensaje nombra los campos que no cuadran y el valor ESPERADO', () => {
  try {
    assertProbeMatchesStage('normalize', { ...VALID, sampleRate: 48_000, channels: 2 });
    assert.fail('debía lanzar');
  } catch (error) {
    assert.ok(error instanceof MeetingsApiError);
    assert.match(error.message, /sampleRate, channels/);
    assert.match(error.message, /16000 Hz/);
    // Y NO el recibido: el mensaje va al cuerpo de la respuesta y de ahí a un
    // log, y lo que entra por el cable no se devuelve interpolado.
    assert.doesNotMatch(error.message, /48000/);
  }
});

test('durationSeconds puede faltar o ser null: es la única concesión', () => {
  // ffprobe no siempre informa duración —un WAV truncado, un contenedor sin
  // cabecera— y rechazar por eso descartaría audio transcribible.
  const { durationSeconds: _omitted, ...withoutDuration } = VALID;
  assert.equal(
    codeOf(() => assertProbeMatchesStage('normalize', withoutDuration as MediaProbe)),
    'ninguno',
  );
  assert.equal(
    codeOf(() => assertProbeMatchesStage('normalize', { ...VALID, durationSeconds: null })),
    'ninguno',
  );
});

test('las otras etapas PROHÍBEN el sondeo en vez de ignorarlo', () => {
  for (const stage of ['transcribe', 'diarize', 'analyze'] as const) {
    assert.equal(
      codeOf(() => assertProbeMatchesStage(stage, VALID)),
      'invalid_request',
      `${stage} no debe aceptar sondeo`,
    );
    // Y sin sondeo pasan, que es lo que hacen siempre.
    assert.equal(codeOf(() => assertProbeMatchesStage(stage, undefined)), 'ninguno');
    assert.equal(codeOf(() => assertProbeMatchesStage(stage, null)), 'ninguno');
  }
});

import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { query } from '../../src/db/client.js';
import { cleanupTenant, closeDb, seedScenario } from './fixtures.js';
import * as analysesRepo from '../../src/db/repositories/meetings/analyses.js';
import { generateAnalysis, getAnalysis } from '../../src/meetings/analysis/service.js';
import { MeetingsApiError } from '../../src/meetings/errors.js';

/**
 * Lo que sólo se puede demostrar contra PostgreSQL de verdad: que dos peticiones
 * simultáneas producen EXACTAMENTE una llamada de pago, y que un cambio de
 * transcripción a mitad no activa un resumen que habla de otro texto.
 *
 * Todo el texto es SINTÉTICO. Ninguna grabación real entra aquí.
 */

after(async () => { await closeDb(); });

const CRUDO = {
  executive: 'Se revisó el estado del índice y se acordó migrarlo.',
  themes: [{ label: 'Migración', segmentIndex: 1 }],
  findings: [
    { kind: 'decision', title: 'Se migra el viernes', detail: null, level: null, segmentIndex: 2, confidence: null },
  ],
  nextSteps: [{ text: 'Avisar al equipo', owner: null, dueText: null, segmentIndex: 3 }],
  absences: [],
  caveat: null,
};

function respuestaOk(model = 'gpt-4o-mini-2024-07-18'): Response {
  return new Response(
    JSON.stringify({
      model,
      choices: [{ message: { content: JSON.stringify(CRUDO) } }],
      usage: { prompt_tokens: 900, completion_tokens: 250 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

/** Una reunión desechable con transcripción y cuatro segmentos sintéticos. */
async function sembrar(): Promise<{
  tenantId: string; clientId: string; meetingId: string; transcriptId: string; scope: { tenantId: string; clientId: string };
}> {
  const s = await seedScenario();
  const meetingId = randomUUID();
  const runId = randomUUID();
  const transcriptId = randomUUID();
  await query(
    `INSERT INTO meetings (id, tenant_id, client_id, title, source_kind, idempotency_key)
     VALUES ($1,$2,$3,'Reunión sintética de prueba','file',$4)`,
    [meetingId, s.tenantId, s.clientId, `k-${meetingId}`],
  );
  await query(
    `INSERT INTO meeting_processing_runs (id, tenant_id, client_id, meeting_id, run_number, trigger,
                                          started_at, finished_at, outcome)
     VALUES ($1,$2,$3,$4,1,'initial',now(),now(),'succeeded')`,
    [runId, s.tenantId, s.clientId, meetingId],
  );
  await query(
    `INSERT INTO meeting_transcript_versions (id, tenant_id, client_id, meeting_id, run_id,
                                              whisper_model, diarization_backend, language,
                                              duration_seconds, segment_count, schema_version, metrics)
     VALUES ($1,$2,$3,$4,$5,'medium','pyannote_full','es',100,4,2,'{}'::jsonb)`,
    [transcriptId, s.tenantId, s.clientId, meetingId, runId],
  );
  for (let i = 0; i < 4; i += 1) {
    await query(
      `INSERT INTO meeting_segments (tenant_id, client_id, transcript_id, segment_index,
                                     start_sec, end_sec, speaker_label, text)
       VALUES ($1,$2,$3,$4,$5,$6,'SPEAKER_00',$7)`,
      [s.tenantId, s.clientId, transcriptId, i, i * 10, i * 10 + 8, `Frase sintética ${i}.`],
    );
  }
  await query(`UPDATE meetings SET active_transcript_id = $2 WHERE id = $1`, [meetingId, transcriptId]);
  return { ...s, meetingId, transcriptId, scope: { tenantId: s.tenantId, clientId: s.clientId } };
}

// ══════════════════════════════════════════════════════════════════════════
//  La prueba que importa: dos a la vez, UNA sola llamada de pago
// ══════════════════════════════════════════════════════════════════════════

test('dos peticiones simultáneas hacen EXACTAMENTE una llamada al proveedor', async () => {
  const w = await sembrar();
  try {
    let llamadas = 0;
    // Lenta a propósito: sin retardo, la primera podría terminar antes de que la
    // segunda empiece, y la prueba pasaría sin haber probado la carrera.
    const fetchLento = (async () => {
      llamadas += 1;
      await new Promise((r) => setTimeout(r, 250));
      return respuestaOk();
    }) as unknown as typeof fetch;

    const [a, b] = await Promise.all([
      generateAnalysis(w.scope, w.meetingId, { apiKey: 'k', fetchImpl: fetchLento }),
      generateAnalysis(w.scope, w.meetingId, { apiKey: 'k', fetchImpl: fetchLento }),
    ]);

    assert.equal(llamadas, 1, 'UNA llamada de pago, no dos');
    const dueños = [a, b].filter((r) => !r.reused);
    assert.equal(dueños.length, 1, 'exactamente una petición fue la dueña de la reserva');
    const otra = [a, b].find((r) => r.reused)!;
    assert.ok(
      otra.state === 'generating' || (otra.state === 'ready' && otra.view !== null),
      'la otra devuelve «generando» o el resultado, nunca un error',
    );

    const filas = await query(`SELECT count(*)::int n FROM meeting_analyses WHERE meeting_id=$1`, [w.meetingId]);
    assert.equal(filas.rows[0].n, 1, 'y una sola fila');
  } finally {
    await cleanupTenant(w.tenantId);
  }
});

test('cinco simultáneas: sigue siendo una sola llamada', async () => {
  const w = await sembrar();
  try {
    let llamadas = 0;
    const f = (async () => { llamadas += 1; await new Promise((r) => setTimeout(r, 200)); return respuestaOk(); }) as unknown as typeof fetch;
    const rs = await Promise.all(
      Array.from({ length: 5 }, () => generateAnalysis(w.scope, w.meetingId, { apiKey: 'k', fetchImpl: f })),
    );
    assert.equal(llamadas, 1);
    assert.equal(rs.filter((r) => !r.reused).length, 1);
  } finally {
    await cleanupTenant(w.tenantId);
  }
});

test('una segunda petición POSTERIOR devuelve lo guardado sin volver a llamar', async () => {
  const w = await sembrar();
  try {
    let llamadas = 0;
    const f = (async () => { llamadas += 1; return respuestaOk(); }) as unknown as typeof fetch;
    await generateAnalysis(w.scope, w.meetingId, { apiKey: 'k', fetchImpl: f });
    const segunda = await generateAnalysis(w.scope, w.meetingId, { apiKey: 'k', fetchImpl: f });
    assert.equal(llamadas, 1, 'el doble clic tardío tampoco paga');
    assert.equal(segunda.reused, true);
    assert.equal(segunda.state, 'ready');
  } finally {
    await cleanupTenant(w.tenantId);
  }
});

// ══════════════════════════════════════════════════════════════════════════
//  Reserva abandonada
// ══════════════════════════════════════════════════════════════════════════

test('una reserva abandonada por una caída se puede reclamar pasado el plazo', async () => {
  const w = await sembrar();
  try {
    // Simula el proceso que reservó y murió: fila 'pending' y vieja.
    await analysesRepo.reserve({
      tenantId: w.tenantId, clientId: w.clientId, meetingId: w.meetingId,
      transcriptId: w.transcriptId, provider: 'openai', model: 'gpt-4o-mini',
      promptVersion: 1, reservedBy: 'proceso-muerto', createdByUserId: null,
    });
    // Sin envejecerla, nadie puede reclamarla: eso es lo que evita la doble llamada.
    let llamadas = 0;
    const f = (async () => { llamadas += 1; return respuestaOk(); }) as unknown as typeof fetch;
    const bloqueada = await generateAnalysis(w.scope, w.meetingId, { apiKey: 'k', fetchImpl: f });
    assert.equal(llamadas, 0, 'con la reserva viva no se llama');
    assert.equal(bloqueada.state, 'generating');

    await query(
      `UPDATE meeting_analyses SET reserved_at = now() - interval '1 hour' WHERE transcript_id = $1`,
      [w.transcriptId],
    );
    const recuperada = await generateAnalysis(w.scope, w.meetingId, { apiKey: 'k', fetchImpl: f });
    assert.equal(llamadas, 1, 'caducada, se reclama y se llama UNA vez');
    assert.equal(recuperada.state, 'ready');
    assert.ok(recuperada.view);
  } finally {
    await cleanupTenant(w.tenantId);
  }
});

test('una reserva fallida se puede volver a intentar', async () => {
  const w = await sembrar();
  try {
    let llamadas = 0;
    const falla = (async () => { llamadas += 1; return new Response('{}', { status: 400 }); }) as unknown as typeof fetch;
    await assert.rejects(() => generateAnalysis(w.scope, w.meetingId, { apiKey: 'k', fetchImpl: falla }));
    const estado = await query(`SELECT status FROM meeting_analyses WHERE transcript_id=$1`, [w.transcriptId]);
    assert.equal(estado.rows[0].status, 'failed', 'la fila queda, con el fallo anotado');

    const bien = (async () => { llamadas += 1; return respuestaOk(); }) as unknown as typeof fetch;
    const r = await generateAnalysis(w.scope, w.meetingId, { apiKey: 'k', fetchImpl: bien });
    assert.equal(r.state, 'ready');
    assert.equal(llamadas, 2, 'la fallida y la buena, ni una más');
  } finally {
    await cleanupTenant(w.tenantId);
  }
});

// ══════════════════════════════════════════════════════════════════════════
//  La transcripción cambia mientras se genera
// ══════════════════════════════════════════════════════════════════════════

test('si la transcripción cambia a mitad, el resumen se conserva pero NO se activa', async () => {
  const w = await sembrar();
  try {
    // Otra versión, que pasa a ser la activa mientras el proveedor «piensa».
    const otraId = randomUUID();
    const runId = randomUUID();
    const fetchQueCambia = (async () => {
      await query(
        `INSERT INTO meeting_processing_runs (id, tenant_id, client_id, meeting_id, run_number, trigger,
                                              started_at, finished_at, outcome)
         VALUES ($1,$2,$3,$4,2,'reprocess',now(),now(),'succeeded')`,
        [runId, w.tenantId, w.clientId, w.meetingId],
      );
      await query(
        `INSERT INTO meeting_transcript_versions (id, tenant_id, client_id, meeting_id, run_id,
                                                  whisper_model, diarization_backend, language,
                                                  duration_seconds, segment_count, schema_version, metrics)
         VALUES ($1,$2,$3,$4,$5,'medium','pyannote_full','es',100,4,2,'{}'::jsonb)`,
        [otraId, w.tenantId, w.clientId, w.meetingId, runId],
      );
      await query(`UPDATE meetings SET active_transcript_id = $2 WHERE id = $1`, [w.meetingId, otraId]);
      return respuestaOk();
    }) as unknown as typeof fetch;

    const r = await generateAnalysis(w.scope, w.meetingId, { apiKey: 'k', fetchImpl: fetchQueCambia });

    assert.equal(r.state, 'ready', 'el resumen se produjo');
    assert.equal(r.supersededDuringGeneration, true, 'y se dice que quedó superado');

    const guardado = await query(
      `SELECT status, transcript_id FROM meeting_analyses WHERE meeting_id=$1`, [w.meetingId]);
    assert.equal(guardado.rows[0].status, 'ready', 'se CONSERVA como histórico');
    assert.equal(guardado.rows[0].transcript_id, w.transcriptId, 'atado a la versión con la que se hizo');

    const m = await query(`SELECT active_analysis_id FROM meetings WHERE id=$1`, [w.meetingId]);
    assert.equal(m.rows[0].active_analysis_id, null, 'pero NO se marcó activo');

    // Y la pantalla no lo enseña como si fuera de la versión vigente.
    assert.equal(await getAnalysis(w.scope, w.meetingId), null);
  } finally {
    await cleanupTenant(w.tenantId);
  }
});

test('sin cambio de transcripción, sí se activa', async () => {
  const w = await sembrar();
  try {
    const r = await generateAnalysis(w.scope, w.meetingId, {
      apiKey: 'k', fetchImpl: (async () => respuestaOk()) as unknown as typeof fetch,
    });
    assert.equal(r.supersededDuringGeneration, false);
    const m = await query(`SELECT active_analysis_id, analysis_state FROM meetings WHERE id=$1`, [w.meetingId]);
    assert.equal(m.rows[0].active_analysis_id, r.view!.id);
    assert.equal(m.rows[0].analysis_state, 'ready');
    const v = await getAnalysis(w.scope, w.meetingId);
    assert.ok(v && !v.outdated);
  } finally {
    await cleanupTenant(w.tenantId);
  }
});

// ══════════════════════════════════════════════════════════════════════════
//  Validación de referencias contra la versión exacta
// ══════════════════════════════════════════════════════════════════════════

test('si TODAS las referencias son inválidas, no se activa nada y se explica', async () => {
  const w = await sembrar();
  try {
    const basura = {
      executive: '', themes: [{ label: 'X', segmentIndex: 900 }],
      findings: [{ kind: 'decision', title: 'Y', detail: null, level: null, segmentIndex: 901, confidence: null }],
      nextSteps: [], absences: [], caveat: null,
    };
    const f = (async () => new Response(JSON.stringify({
      model: 'gpt-4o-mini-2024-07-18',
      choices: [{ message: { content: JSON.stringify(basura) } }],
      usage: { prompt_tokens: 100, completion_tokens: 40 },
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

    await assert.rejects(
      () => generateAnalysis(w.scope, w.meetingId, { apiKey: 'k', fetchImpl: f }),
      (e: unknown) => e instanceof MeetingsApiError && /no citó ningún segmento válido/.test(e.message),
    );
    const m = await query(`SELECT active_analysis_id FROM meetings WHERE id=$1`, [w.meetingId]);
    assert.equal(m.rows[0].active_analysis_id, null, 'no reemplaza al análisis activo');
    const fila = await query(`SELECT status, input_tokens FROM meeting_analyses WHERE meeting_id=$1`, [w.meetingId]);
    assert.equal(fila.rows[0].status, 'failed');
    assert.equal(fila.rows[0].input_tokens, 100, 'pero el gasto queda contado');
  } finally {
    await cleanupTenant(w.tenantId);
  }
});

test('un índice de OTRA versión no cuela: los segmentos se cargan de la versión exacta', async () => {
  const w = await sembrar();
  try {
    // Una segunda versión con 40 segmentos. El índice 30 existe ahí, no aquí.
    const otraId = randomUUID();
    const runId = randomUUID();
    await query(
      `INSERT INTO meeting_processing_runs (id, tenant_id, client_id, meeting_id, run_number, trigger,
                                            started_at, finished_at, outcome)
       VALUES ($1,$2,$3,$4,2,'reprocess',now(),now(),'succeeded')`,
      [runId, w.tenantId, w.clientId, w.meetingId],
    );
    await query(
      `INSERT INTO meeting_transcript_versions (id, tenant_id, client_id, meeting_id, run_id,
                                                whisper_model, diarization_backend, language,
                                                duration_seconds, segment_count, schema_version, metrics)
       VALUES ($1,$2,$3,$4,$5,'medium','pyannote_full','es',100,40,2,'{}'::jsonb)`,
      [otraId, w.tenantId, w.clientId, w.meetingId, runId],
    );
    for (let i = 0; i < 40; i += 1) {
      await query(
        `INSERT INTO meeting_segments (tenant_id, client_id, transcript_id, segment_index,
                                       start_sec, end_sec, speaker_label, text)
         VALUES ($1,$2,$3,$4,$5,$6,'SPEAKER_00',$7)`,
        [w.tenantId, w.clientId, otraId, i, i, i + 1, `otra ${i}`],
      );
    }
    const conIndiceAjeno = {
      ...CRUDO, themes: [{ label: 'De la otra versión', segmentIndex: 30 }],
    };
    const f = (async () => new Response(JSON.stringify({
      model: 'm', choices: [{ message: { content: JSON.stringify(conIndiceAjeno) } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

    const r = await generateAnalysis(w.scope, w.meetingId, { apiKey: 'k', fetchImpl: f });
    assert.equal(r.droppedRefs, 1, 'el índice 30 no existe en LA versión que se resumió');
    assert.equal(r.view!.summary.themes.length, 0);
    assert.ok(r.view!.summary.caveat?.includes('1 referencia'));
  } finally {
    await cleanupTenant(w.tenantId);
  }
});

// ══════════════════════════════════════════════════════════════════════════
//  Coste
// ══════════════════════════════════════════════════════════════════════════

test('un modelo sin precio conocido guarda coste NULL, no cero', async () => {
  const w = await sembrar();
  try {
    const f = (async () => respuestaOk('modelo-desconocido-99')) as unknown as typeof fetch;
    const r = await generateAnalysis(w.scope, w.meetingId, { apiKey: 'k', fetchImpl: f });
    assert.equal(r.view!.costUsd, null, 'no disponible');
    assert.equal(r.view!.costEstimated, true);
    assert.equal(r.view!.modelReturned, 'modelo-desconocido-99', 'se guarda el devuelto');
    const fila = await query(`SELECT cost_usd FROM meeting_analyses WHERE meeting_id=$1`, [w.meetingId]);
    assert.equal(fila.rows[0].cost_usd, null);
  } finally {
    await cleanupTenant(w.tenantId);
  }
});

// ══════════════════════════════════════════════════════════════════════════
//  Aislamiento
// ══════════════════════════════════════════════════════════════════════════

test('otro cliente no ve ni puede generar el resumen de esta reunión', async () => {
  const w = await sembrar();
  const otro = await seedScenario();
  try {
    const ajeno = { tenantId: otro.tenantId, clientId: otro.clientId };
    // 404, no `null`: para otro cliente esa reunión NO EXISTE, y es
    // indistinguible de un uuid inventado. Probar uuids no revela nada.
    await assert.rejects(
      () => getAnalysis(ajeno, w.meetingId),
      (e: unknown) => e instanceof MeetingsApiError && e.code === 'not_found',
    );
    await assert.rejects(
      () => generateAnalysis(ajeno, w.meetingId, {
        apiKey: 'k', fetchImpl: (async () => respuestaOk()) as unknown as typeof fetch,
      }),
      (e: unknown) => e instanceof MeetingsApiError && e.code === 'not_found',
    );
  } finally {
    await cleanupTenant(w.tenantId);
    await cleanupTenant(otro.tenantId);
  }
});

// ══════════════════════════════════════════════════════════════════════════
//  Muerte del proceso a mitad de la llamada
// ══════════════════════════════════════════════════════════════════════════
//
// El caso que NO cubre el `catch`: un SIGKILL, un contenedor reciclado, un
// despliegue. No se ejecuta ningún `finally`, así que la fila se queda en
// `pending` con un dueño que ya no existe. La pregunta que hay que contestar
// con una prueba y no con un comentario es si esa reunión queda bloqueada
// para siempre.
//
// Se simula matando la petición de verdad —la promesa del proveedor nunca
// resuelve y se abandona— en vez de lanzando un error, que sí dispararía el
// `catch`. La fila queda exactamente como la dejaría una muerte real.

test('si el proceso muere a mitad, la reserva NO queda bloqueada para siempre', async () => {
  const w = await sembrar();
  try {
    let llamadas = 0;

    // El «proceso muerto»: llama y jamás vuelve. No se espera.
    const fetchColgado = (async () => {
      llamadas += 1;
      await new Promise(() => {}); // nunca resuelve
      return respuestaOk();
    }) as unknown as typeof fetch;

    void generateAnalysis(w.scope, w.meetingId, { apiKey: 'k', fetchImpl: fetchColgado }).catch(() => {});
    // Esperar a que la reserva esté escrita, no a un plazo arbitrario.
    for (let i = 0; i < 100 && llamadas === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
    assert.equal(llamadas, 1, 'el dueño llegó a llamar al proveedor');

    const antes = await query<{ status: string; reserved_by: string | null }>(
      `SELECT status, reserved_by FROM meeting_analyses WHERE meeting_id=$1`, [w.meetingId],
    );
    assert.equal(antes.rows[0].status, 'pending', 'la fila se queda pending, como tras una muerte real');
    const dueñoMuerto = antes.rows[0].reserved_by;

    // ── Dentro del plazo: nadie más paga ──────────────────────────────────
    let llamadas2 = 0;
    const f2 = (async () => { llamadas2 += 1; return respuestaOk(); }) as unknown as typeof fetch;
    const enPlazo = await generateAnalysis(w.scope, w.meetingId, { apiKey: 'k', fetchImpl: f2 });
    assert.equal(llamadas2, 0, 'mientras la reserva vive, una segunda petición NO llama');
    assert.equal(enPlazo.state, 'generating');
    assert.equal(enPlazo.reused, true);

    // ── Pasado el plazo: se puede retomar ─────────────────────────────────
    //
    // Se envejece `reserved_at` en la base en vez de esperar diez minutos. Lo
    // que se prueba es la condición SQL de caducidad, que es donde vive la
    // decisión; dormir el reloj real no probaría nada distinto.
    await query(
      `UPDATE meeting_analyses
          SET reserved_at = now() - ($2 || ' milliseconds')::interval
        WHERE meeting_id = $1`,
      [w.meetingId, String(analysesRepo.RESERVA_CADUCA_MS + 60_000)],
    );

    const retoma = await generateAnalysis(w.scope, w.meetingId, { apiKey: 'k', fetchImpl: f2 });
    assert.equal(llamadas2, 1, 'pasado el plazo sí se retoma, y exactamente una vez');
    assert.equal(retoma.state, 'ready');
    assert.equal(retoma.reused, false);

    const despues = await query<{ status: string; reserved_by: string | null; n: string }>(
      `SELECT status, reserved_by, count(*) OVER ()::text n
         FROM meeting_analyses WHERE meeting_id=$1`, [w.meetingId],
    );
    assert.equal(despues.rows.length, 1, 'sigue habiendo UNA fila: se retomó, no se duplicó');
    assert.equal(despues.rows[0].status, 'ready');
    assert.notEqual(despues.rows[0].reserved_by, dueñoMuerto, 'el dueño es el nuevo, no el muerto');

    // Y el que murió no puede volver de entre los muertos a pisar el resultado:
    // `complete` exige seguir siendo el dueño.
    const zombi = await analysesRepo.complete({
      id: (await query<{ id: string }>(`SELECT id FROM meeting_analyses WHERE meeting_id=$1`, [w.meetingId])).rows[0].id,
      reservedBy: dueñoMuerto!,
      payload: { executive: 'resultado del proceso muerto' },
      modelReturned: null, inputTokens: 0, outputTokens: 0, costUsd: null, durationMs: null,
    });
    assert.equal(zombi, null, 'el dueño caducado ya no puede escribir');
  } finally {
    await cleanupTenant(w.tenantId);
  }
});

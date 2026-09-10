import { pathToFileURL } from 'node:url';
import { closePool, query, withTransaction } from '../db/client.js';
import * as jobsRepo from '../db/repositories/meetings/jobs.js';
import * as meetingsRepo from '../db/repositories/meetings/meetings.js';
import type { Queryable } from '../db/repositories/meetings/types.js';
import {
  StagingGuardError,
  assertConnectedDatabase,
  parseArgs,
  requireStagingEnvironment,
  requireUuid,
} from './stagingGuard.js';

/**
 * Reintenta una reunión cuyo pipeline falló, **desde su audio original**.
 *
 *   # plan, sin escribir (el defecto)
 *   MEETINGS_ENV_KIND=staging MEETINGS_EXPECTED_DB_HOST=… MEETINGS_EXPECTED_DB_NAME=… \
 *   DATABASE_URL=… npx tsx src/scripts/meetingsStagingReprocess.ts \
 *     --tenant-id <uuid> --client-id <uuid> --meeting-id <uuid>
 *
 *   # ejecutar
 *   … --tenant-id <uuid> --client-id <uuid> --meeting-id <uuid> --execute
 *
 * ── Qué es un reproceso y por qué NO es «reintentar el job» ─────────────────
 *
 * El job fallido no se toca: se queda `failed` con sus `attempts` para siempre.
 * Es el registro de lo que pasó, y sobrescribirlo para volver a intentar
 * borraría la única prueba de que pasó. Lo que se crea es un **run nuevo** con
 * `trigger='reprocess'` y su propio job `normalize` en `queued` con
 * `attempts=0`.
 *
 * El esquema lo previó desde M-1 y este script sólo pone la entrada que faltaba:
 *
 * · `trigger CHECK IN ('initial','reprocess','import','backfill')` — 'reprocess'
 *   estaba declarado y ningún código lo usaba.
 * · `createRun` deriva `run_number` dentro del propio INSERT, así que el run 2
 *   no se calcula en JS ni tiene ventana de carrera.
 * · `runs_one_active_per_meeting_idx ... WHERE finished_at IS NULL` — la base
 *   garantiza que no haya dos runs activos. La comprobación en código de aquí
 *   abajo es para dar un mensaje decente; la garantía es el índice.
 * · `jobs_stage_key UNIQUE (run_id, stage)` más el `ON CONFLICT DO NOTHING` de
 *   `createJob` — nunca dos `normalize` del mismo run.
 * · `requires` es una columna GENERATED desde `stage`, así que el job nuevo
 *   nace exigiendo `meetings.transcribe` sin que nadie lo declare.
 *
 * ── El audio no se vuelve a subir, y esto es verificable ────────────────────
 *
 * El `original` tiene `run_id NULL` a propósito: pertenece a la REUNIÓN, no a un
 * run. Y `service.buildInputs` resuelve el insumo de `normalize` con
 * `findLiveOriginal(job.meeting_id)` —por reunión, no por run—, así que el job
 * del run nuevo recibe una URL firmada recién hecha sobre el MISMO objeto de
 * R2. No hay nada que copiar ni que volver a subir; este script comprueba que
 * ese original sigue vivo y se niega si no lo está.
 *
 * ── Por qué el defecto es no escribir ──────────────────────────────────────
 *
 * Igual que `meetingsStagingCleanup`: sin `--execute` hace las comprobaciones,
 * imprime el plan y sale con 0. No es destructivo —añade filas, no las quita—
 * así que no exige la frase de confirmación que sí exige el borrado; pero
 * encolar trabajo en una GPU tampoco debería pasar por escribir mal un comando.
 */

// ── El vocabulario de negativas ─────────────────────────────────────────────
//
// Un código estable por motivo, para que las pruebas afirmen el MOTIVO y no un
// trozo de texto. Cada uno corresponde a una condición que el runbook exige
// rechazar.
export type RefusalCode =
  | 'meeting_not_found'
  | 'meeting_cancelled'
  | 'media_not_ready'
  | 'original_missing'
  | 'run_active';

export class ReprocessRefused extends Error {
  constructor(
    readonly code: RefusalCode,
    message: string,
  ) {
    super(message);
    this.name = 'ReprocessRefused';
  }
}

export interface ReprocessTarget {
  readonly tenantId: string;
  readonly clientId: string;
  readonly meetingId: string;
}

export interface ReprocessPlan {
  readonly meeting: meetingsRepo.MeetingRow;
  readonly original: meetingsRepo.MeetingMediaRow;
  /** Sólo informativo: el número REAL lo decide el INSERT de `createRun`. */
  readonly nextRunNumber: number;
  readonly previousRuns: readonly {
    readonly id: string;
    readonly runNumber: number;
    readonly trigger: string;
    readonly outcome: string | null;
  }[];
  /** Los jobs que ya existen y que este script NO va a tocar. */
  readonly untouchedJobs: readonly {
    readonly id: string;
    readonly runId: string;
    readonly stage: string;
    readonly status: string;
    readonly attempts: number;
    readonly failureCode: string | null;
  }[];
  readonly warnings: readonly Record<string, unknown>[];
}

/**
 * Lee y valida. **No escribe nada.**
 *
 * La misma función sirve para el dry-run y para el interior de la transacción;
 * si fueran dos, el plan que se imprime y las condiciones que se aplican
 * podrían divergir, y entonces el dry-run mentiría.
 *
 * `lock: true` toma `FOR UPDATE` sobre la reunión. Serializa dos reprocesos
 * simultáneos para que el segundo vea el run del primero en vez de chocar con
 * el índice único; el índice sigue estando debajo como garantía real.
 */
export async function planReprocess(
  target: ReprocessTarget,
  executor: Queryable,
  options: { readonly lock?: boolean } = {},
): Promise<ReprocessPlan> {
  const locked = await executor.query<meetingsRepo.MeetingRow>(
    `SELECT * FROM meetings WHERE id = $1 AND tenant_id = $2 AND client_id = $3` +
      (options.lock === true ? ' FOR UPDATE' : ''),
    [target.meetingId, target.tenantId, target.clientId],
  );
  const meeting = locked.rows[0];
  if (!meeting) {
    // El mismo mensaje para «no existe» y «no es de este tenant/cliente»: son
    // las tres guardas de identidad a la vez, y separarlas aquí no aportaría
    // nada porque quien ejecuta ya declaró las tres.
    throw new ReprocessRefused(
      'meeting_not_found',
      `No hay ninguna reunión ${target.meetingId} en el tenant ${target.tenantId} ` +
        `y el cliente ${target.clientId}. Comprueba los tres uuids: el guardián ` +
        `no adivina cuál de ellos está mal.`,
    );
  }
  if (meeting.cancelled_at !== null) {
    throw new ReprocessRefused(
      'meeting_cancelled',
      `La reunión está cancelada (${meeting.cancelled_at.toISOString()}). Reprocesar ` +
        `algo cancelado resucitaría trabajo que alguien detuvo a propósito.`,
    );
  }
  if (meeting.media_state !== 'ready') {
    throw new ReprocessRefused(
      'media_not_ready',
      `media_state='${meeting.media_state}', y un reproceso parte del audio ya ` +
        `confirmado. Con 'pending' o 'uploading' la subida no terminó; con ` +
        `'invalid' el medio se rechazó y volver a intentarlo daría el mismo ` +
        `resultado.`,
    );
  }

  const original = await meetingsRepo.findLiveOriginal(target.meetingId, executor);
  if (!original) {
    throw new ReprocessRefused(
      'original_missing',
      `No hay un meeting_media 'original' vivo para esta reunión. O nunca se ` +
        `subió, o la retención lo marcó borrado. Sin el original no hay nada que ` +
        `reprocesar, y este script no sube audio.`,
    );
  }

  const active = await jobsRepo.getActiveRun(target.meetingId, executor);
  if (active) {
    throw new ReprocessRefused(
      'run_active',
      `El run ${active.id} (nº${active.run_number}, trigger='${active.trigger}') sigue ` +
        `abierto: finished_at IS NULL. Cerrarlo por ti sería decidir su desenlace, ` +
        `que es justo lo que no me toca. Espera a que termine, o ciérralo a ` +
        `conciencia con el outcome que corresponda.`,
    );
  }

  const runs = await executor.query<{
    id: string;
    run_number: number;
    trigger: string;
    outcome: string | null;
  }>(
    `SELECT id, run_number, trigger, outcome FROM meeting_processing_runs
      WHERE meeting_id = $1 ORDER BY run_number`,
    [target.meetingId],
  );
  const jobs = await jobsRepo.listJobsForMeeting(target.meetingId, executor);

  return {
    meeting,
    original,
    nextRunNumber: runs.rows.reduce((max, run) => Math.max(max, run.run_number), 0) + 1,
    previousRuns: runs.rows.map((run) => ({
      id: run.id,
      runNumber: run.run_number,
      trigger: run.trigger,
      outcome: run.outcome,
    })),
    untouchedJobs: jobs.map((job) => ({
      id: job.id,
      runId: job.run_id,
      stage: job.stage,
      status: job.status,
      attempts: job.attempts,
      failureCode: job.failure_code,
    })),
    warnings: (Array.isArray(meeting.warnings) ? meeting.warnings : []) as Record<
      string,
      unknown
    >[],
  };
}

/** El código del aviso que este script añade. */
export const REPROCESS_WARNING_CODE = 'reprocess_requested';

/**
 * ¿Ya hay un aviso de reproceso para este run?
 *
 * El histórico se CONSERVA —`updatePipelineState` concatena con `||`, nunca
 * reemplaza— y lo que hay que evitar es la otra mitad: añadir dos veces el
 * mismo. La clave es `run_number`, que es único por reunión, así que el aviso
 * de un run no puede repetirse sin que sea literalmente el mismo run.
 */
export function hasWarningForRun(
  warnings: readonly unknown[],
  runNumber: number,
): boolean {
  return warnings.some(
    (entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      (entry as Record<string, unknown>).code === REPROCESS_WARNING_CODE &&
      Number((entry as Record<string, unknown>).run_number) === runNumber,
  );
}

export interface ReprocessResult {
  readonly runId: string;
  readonly runNumber: number;
  readonly jobId: string;
  readonly requires: readonly string[];
  readonly warningAppended: boolean;
  readonly reusedStorageKey: string;
  readonly reusedBytes: string;
  readonly reusedChecksum: string;
}

/**
 * Crea el run de reproceso y su job. **Escribe.** Debe llamarse dentro de una
 * transacción: si el job no se pudiera crear, un run huérfano y activo dejaría
 * la reunión bloqueada para cualquier reproceso futuro por el propio índice
 * único que la protege.
 */
export async function applyReprocess(
  target: ReprocessTarget,
  executor: Queryable,
): Promise<ReprocessResult> {
  const plan = await planReprocess(target, executor, { lock: true });

  const run = await jobsRepo.createRun(
    {
      tenantId: target.tenantId,
      clientId: target.clientId,
      meetingId: target.meetingId,
      trigger: 'reprocess',
      // Sin usuario: lo ejecuta un operador desde una shell, no una sesión.
      // Falsear un `requested_by_user_id` para rellenar la columna sería
      // inventar un autor. Quién lo hizo queda en el detalle del evento.
      requestedByUserId: null,
      requestedOptions: {},
    },
    executor,
  );

  const { job, created } = await jobsRepo.createJob(
    {
      tenantId: target.tenantId,
      clientId: target.clientId,
      meetingId: target.meetingId,
      runId: run.id,
      stage: 'normalize',
    },
    executor,
  );
  if (!created) {
    // Imposible por construcción —el run se acaba de crear, no puede tener
    // etapas— así que si pasa, algo entiende mal el esquema. Se aborta la
    // transacción entera en vez de seguir sobre una premisa falsa.
    throw new Error(
      `El run ${run.id} recién creado ya tenía un job 'normalize' (${job.id}). ` +
        `Nada se ha escrito.`,
    );
  }

  await jobsRepo.appendJobEvent(
    {
      tenantId: target.tenantId,
      clientId: target.clientId,
      meetingId: target.meetingId,
      jobId: job.id,
      attempt: 0,
      kind: 'state_changed',
      stage: 'normalize',
      detail: {
        to: 'queued',
        reason: 'reprocess',
        actor: 'meetingsStagingReprocess',
        run_number: run.run_number,
        previous_runs: plan.previousRuns.map((previous) => ({
          id: previous.id,
          run_number: previous.runNumber,
          outcome: previous.outcome,
        })),
      },
    },
    executor,
  );

  // El número REAL sale del INSERT, no del plan: `createRun` lo deriva con
  // COALESCE(MAX(...))+1 y usar el calculado antes abriría una discrepancia
  // entre el aviso y la fila.
  const warningAppended = !hasWarningForRun(plan.warnings, run.run_number);
  await meetingsRepo.updatePipelineState(
    target.meetingId,
    {
      // De 'failed' a 'pending': hay trabajo en cola otra vez. No se toca
      // `active_transcript_id` —sigue siendo el que sea— ni los estados de
      // diarización y análisis, que dependen de sus propias etapas.
      transcriptState: 'pending',
      appendWarnings: warningAppended
        ? [
            {
              at: new Date().toISOString(),
              code: REPROCESS_WARNING_CODE,
              run_number: run.run_number,
              // El motivo del reproceso ES el fallo anterior. Se copia el
              // código, no el detalle: el detalle puede llevar rutas y texto
              // de excepción, y `warnings` se sirve por la API.
              previous_failure_code:
                plan.untouchedJobs.find((entry) => entry.failureCode !== null)?.failureCode ?? null,
            },
          ]
        : undefined,
    },
    executor,
  );

  return {
    runId: run.id,
    runNumber: run.run_number,
    jobId: job.id,
    requires: job.requires,
    warningAppended,
    reusedStorageKey: plan.original.storage_key,
    reusedBytes: String(plan.original.bytes),
    reusedChecksum: plan.original.checksum_sha256,
  };
}

// ── La línea de órdenes ─────────────────────────────────────────────────────

async function main(): Promise<number> {
  let target: ReprocessTarget;
  let execute: boolean;
  let database: ReturnType<typeof requireStagingEnvironment>;
  try {
    database = requireStagingEnvironment();
    const { flags, values } = parseArgs(process.argv.slice(2));
    target = {
      tenantId: requireUuid(values['tenant-id'], '--tenant-id'),
      clientId: requireUuid(values['client-id'], '--client-id'),
      meetingId: requireUuid(values['meeting-id'], '--meeting-id'),
    };
    execute = flags.has('execute');
    if (flags.has('dry-run') && execute) {
      throw new StagingGuardError('--dry-run y --execute son incompatibles.');
    }
  } catch (error) {
    if (error instanceof StagingGuardError) {
      process.stderr.write(`✗ ${error.message}\n`);
      return 2;
    }
    throw error;
  }

  const out = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };

  try {
    out(`base:     ${database.database} @ ${database.host}`);
    out(`tenant:   ${target.tenantId}`);
    out(`cliente:  ${target.clientId}`);
    out(`reunión:  ${target.meetingId}`);
    out('');

    await assertConnectedDatabase({ query });

    if (!execute) {
      const plan = await planReprocess(target, { query } as unknown as Queryable);
      out('── el plan ─────────────────────────────────────────────────');
      out(`  run nuevo        nº${plan.nextRunNumber}, trigger='reprocess'`);
      out(`  job nuevo        normalize · queued · attempts=0 · requires={meetings.transcribe}`);
      out(`  transcript_state ${plan.meeting.transcript_state} → pending`);
      out(
        `  aviso            ${
          hasWarningForRun(plan.warnings, plan.nextRunNumber)
            ? 'ya existe para este run; no se duplica'
            : `+1 '${REPROCESS_WARNING_CODE}' (${
                plan.warnings.length === 1
                  ? 'el aviso anterior se conserva'
                  : `los ${plan.warnings.length} anteriores se conservan`
              })`
        }`,
      );
      out('');
      out('── el audio que se reutiliza ───────────────────────────────');
      out(`  clave R2         ${plan.original.storage_key}`);
      out(`  bytes            ${plan.original.bytes}`);
      out(`  sha256           ${plan.original.checksum_sha256}`);
      out('  No se vuelve a subir: el claim de normalize resuelve el original por');
      out('  reunión, así que el run nuevo firma un GET sobre este mismo objeto.');
      out('');
      out('── lo que NO se toca ───────────────────────────────────────');
      for (const job of plan.untouchedJobs) {
        out(
          `  job ${job.id}  ${job.stage.padEnd(10)} ${job.status.padEnd(10)} ` +
            `attempts=${job.attempts} failure_code=${job.failureCode ?? '—'}`,
        );
      }
      for (const run of plan.previousRuns) {
        out(`  run ${run.id}  nº${run.runNumber} ${run.trigger} outcome=${run.outcome ?? 'abierto'}`);
      }
      out('');
      out('── DRY-RUN (el defecto) ────────────────────────────────────');
      out('No se ha escrito nada. Para ejecutarlo de verdad:  --execute');
      return 0;
    }

    out('── ENCOLANDO EL REPROCESO ──────────────────────────────────');
    const result = await withTransaction(async (client) => {
      const executor = client as unknown as Queryable;
      // Dentro de la transacción y antes de la primera escritura: la
      // comparación de `requireStagingEnvironment` es de cadenas, ésta la
      // responde el servidor.
      await assertConnectedDatabase(executor);
      return applyReprocess(target, executor);
    });

    out(`  run       ${result.runId}  (nº${result.runNumber}, trigger='reprocess')`);
    out(`  job       ${result.jobId}  normalize · queued · attempts=0`);
    out(`  requires  {${result.requires.join(', ')}}`);
    out(`  aviso     ${result.warningAppended ? 'añadido, sin borrar los anteriores' : 'ya estaba; no se duplicó'}`);
    out('');
    out(`  audio reutilizado: ${result.reusedStorageKey}`);
    out(`                     ${result.reusedBytes} bytes · sha256 ${result.reusedChecksum}`);
    out('');

    // Verificación posterior, con la transacción ya cerrada: lo que importa no
    // es lo que el script cree haber escrito, sino lo que la base contiene.
    const after = await query<{
      runs_activos: string;
      jobs_normalize_del_run: string;
      reclamable: string;
      job_viejo_intacto: string;
    }>(
      `SELECT
         (SELECT count(*) FROM meeting_processing_runs
           WHERE meeting_id = $1 AND finished_at IS NULL)::text AS runs_activos,
         (SELECT count(*) FROM meeting_processing_jobs
           WHERE run_id = $2 AND stage = 'normalize')::text AS jobs_normalize_del_run,
         (SELECT count(*) FROM meeting_processing_jobs
           WHERE id = $3 AND status = 'queued' AND attempts = 0
             AND next_attempt_at <= now() AND lease_token_hash IS NULL)::text AS reclamable,
         (SELECT count(*) FROM meeting_processing_jobs
           WHERE meeting_id = $1 AND id <> $3 AND status = 'failed' AND attempts = 3)::text
           AS job_viejo_intacto`,
      [target.meetingId, result.runId, result.jobId],
    );
    const row = after.rows[0];
    const checks: [string, boolean, string][] = [
      ['exactamente un run activo', row.runs_activos === '1', row.runs_activos],
      ['un solo normalize en el run nuevo', row.jobs_normalize_del_run === '1', row.jobs_normalize_del_run],
      ['el job nuevo es reclamable', row.reclamable === '1', row.reclamable],
    ];
    out('── verificación ────────────────────────────────────────────');
    let failed = 0;
    for (const [label, ok, got] of checks) {
      out(`  ${ok ? '✓' : '✗'} ${label.padEnd(40)} ${ok ? '' : `(${got})`}`);
      if (!ok) failed += 1;
    }
    out(`  · jobs fallidos que siguen intactos: ${row.job_viejo_intacto}`);
    if (failed > 0) {
      process.stderr.write(`✗ ${failed} comprobación(es) posterior(es) no cuadran.\n`);
      return 1;
    }
    out('');
    out('El worker reclamará este job en su siguiente sondeo. Si no debe hacerlo');
    out('todavía, tenlo apagado antes de ejecutar esto.');
    return 0;
  } catch (error) {
    if (error instanceof ReprocessRefused) {
      process.stderr.write(`✗ [${error.code}] ${error.message}\n`);
      return 2;
    }
    process.stderr.write(`✗ fallo al encolar el reproceso: ${(error as Error).message}\n`);
    return 1;
  } finally {
    await closePool();
  }
}

// Sólo cuando se ejecuta como programa. Las pruebas de concurrencia importan
// `applyReprocess` para llamarla dos veces a la vez con dos clientes, y sin
// esta guarda el import ejecutaría el script.
const invokedAsScript =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedAsScript) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`✗ ${(error as Error).message}\n`);
      process.exit(1);
    },
  );
}

import { closePool, query } from '../db/client.js';
import {
  StagingGuardError,
  assertConnectedDatabase,
  parseArgs,
  requireStagingEnvironment,
  requireUuid,
} from './stagingGuard.js';

/**
 * Las verificaciones del §6 del runbook, ejecutadas de una vez.
 *
 *   MEETINGS_ENV_KIND=staging DATABASE_URL=… \
 *     npx tsx src/scripts/meetingsStagingVerify.ts --tenant-id … [--meeting-id …]
 *
 * **SÓLO LECTURA.** Ni un `INSERT`, ni un `UPDATE`, ni un `DELETE`: la única
 * sentencia que emite es `SELECT`, y la comprobación de que eso es cierto está
 * en `test/unit/meetingsStagingScripts.test.ts`, leyendo este fichero. Un script
 * de verificación que escribe deja de ser una verificación — mediría un estado
 * que él mismo causó.
 *
 * Salida: una línea por comprobación con `PASS`/`FAIL`/`n/a`, y el código de
 * salida es 0 sólo si no hay ningún `FAIL`. `n/a` es para lo que todavía no ha
 * ocurrido (no hay diarización porque el run va por `transcribe`) y no cuenta
 * como fallo: durante W-3 este script se ejecuta varias veces mientras el
 * recorrido avanza, y marcar en rojo lo que aún no ha pasado lo haría inútil.
 */

type Verdict = 'PASS' | 'FAIL' | 'n/a';
interface Check {
  readonly id: string;
  readonly label: string;
  readonly verdict: Verdict;
  readonly detail: string;
}

const checks: Check[] = [];
function record(id: string, label: string, verdict: Verdict, detail: string): void {
  checks.push({ id, label, verdict, detail });
}

async function run(tenantId: string, meetingId: string | null): Promise<void> {
  // El servidor confirma a qué base se ha conectado de verdad. Aquí no se
  // escribe nada, así que el riesgo es otro: dar un informe en verde de una
  // base que no es la que se cree.
  await assertConnectedDatabase({ query });
  // Las de ámbito de TENANT van primero y no dependen de que haya reunión: es
  // lo único verificable justo después del seed, que es cuando este script se
  // ejecuta por primera vez. Detrás del corte por «no hay reunión» habrían sido
  // inútiles precisamente entonces.
  await verifyTenantScope(tenantId);
  await verifyMeeting(tenantId, meetingId);
}

async function verifyMeeting(tenantId: string, meetingId: string | null): Promise<void> {
  // ── Qué reunión se verifica ───────────────────────────────────────────────
  const meetings = await query<{
    id: string;
    media_state: string;
    transcript_state: string;
    diarization_state: string;
    active_transcript_id: string | null;
    warnings: unknown;
  }>(
    meetingId === null
      ? `SELECT id, media_state, transcript_state, diarization_state, active_transcript_id, warnings
           FROM meetings WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1`
      : `SELECT id, media_state, transcript_state, diarization_state, active_transcript_id, warnings
           FROM meetings WHERE tenant_id = $1 AND id = $2`,
    meetingId === null ? [tenantId] : [tenantId, meetingId],
  );
  const meeting = meetings.rows[0];
  if (!meeting) {
    // 'n/a', no 'FAIL': ejecutar esto entre el seed y la primera subida es
    // normal, y marcarlo en rojo haría que el script diera falsos negativos
    // durante media hora de W-3.
    record(
      '0',
      'hay una reunión que verificar',
      meetingId === null ? 'n/a' : 'FAIL',
      meetingId === null ? 'ninguna todavía; sube el audio y repite' : 'el uuid dado no existe',
    );
    return;
  }
  record('0', 'reunión bajo verificación', 'PASS', meeting.id);

  // ── §6.2 · ninguna URL firmada persistida ─────────────────────────────────
  const signed = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM meeting_media
      WHERE meeting_id = $1 AND (storage_key LIKE '%X-Amz%' OR storage_key LIKE '%?%')`,
    [meeting.id],
  );
  record(
    '6.2',
    'ninguna clave de objeto contiene una firma',
    signed.rows[0].n === '0' ? 'PASS' : 'FAIL',
    `${signed.rows[0].n} clave(s) sospechosa(s)`,
  );

  // ── §6.3 · el original ───────────────────────────────────────────────────
  const original = await query<{
    run_id: string | null;
    probe_ok: boolean | null;
    bytes: string;
    checksum_sha256: string;
  }>(
    `SELECT run_id, probe_ok, bytes, checksum_sha256 FROM meeting_media
      WHERE meeting_id = $1 AND role = 'original' AND deleted_at IS NULL`,
    [meeting.id],
  );
  if (original.rows.length !== 1) {
    record('6.3', 'un solo original vivo', 'FAIL', `${original.rows.length} filas`);
  } else {
    const row = original.rows[0];
    const ok = row.run_id === null && row.probe_ok === null;
    record(
      '6.3',
      'el original: sin run y sin sondeo',
      ok ? 'PASS' : 'FAIL',
      `run_id=${row.run_id ?? 'null'} probe_ok=${row.probe_ok ?? 'null'} bytes=${row.bytes}`,
    );
    record('6.3', 'checksum del original (compáralo con el sha256 local)', 'PASS', row.checksum_sha256);
  }
  record(
    '6.3',
    "media_state = 'ready'",
    meeting.media_state === 'ready' ? 'PASS' : 'FAIL',
    meeting.media_state,
  );

  // ── §6.3 · creación secuencial de jobs ───────────────────────────────────
  const jobs = await query<{
    id: string;
    stage: string;
    status: string;
    attempts: number;
    max_attempts: number;
    requires: string[];
    failure_code: string | null;
    failure_detail: string | null;
    last_heartbeat_at: Date | null;
    progress_pct: number | null;
    lease_alive: boolean | null;
    backoff_pending: boolean | null;
    credential_label: string | null;
  }>(
    `SELECT id, stage, status, attempts, max_attempts, requires, failure_code, failure_detail,
            last_heartbeat_at, progress_pct,
            lease_expires_at > now() AS lease_alive,
            next_attempt_at > now() AS backoff_pending,
            leased_credential_label AS credential_label
       FROM meeting_processing_jobs WHERE meeting_id = $1 ORDER BY created_at`,
    [meeting.id],
  );
  const byStage = new Map<string, typeof jobs.rows>();
  for (const job of jobs.rows) {
    byStage.set(job.stage, [...(byStage.get(job.stage) ?? []), job]);
  }
  const duplicated = [...byStage.entries()].filter(([, rows]) => rows.length > 1);
  record(
    '6.3',
    'un job por etapa (creación secuencial, no en lote)',
    duplicated.length === 0 ? 'PASS' : 'FAIL',
    duplicated.length === 0
      ? jobs.rows.map((job) => `${job.stage}=${job.status}`).join(' ')
      : `duplicadas: ${duplicated.map(([stage]) => stage).join(', ')}`,
  );
  const wrongRequires = jobs.rows.filter(
    (job) =>
      job.requires.length !== 1 ||
      job.requires[0] !== (job.stage === 'analyze' ? 'meetings.analyze' : 'meetings.transcribe'),
  );
  record(
    '6.3',
    'requires generado desde la etapa',
    wrongRequires.length === 0 ? 'PASS' : 'FAIL',
    wrongRequires.map((job) => `${job.stage}→${job.requires.join(',')}`).join(' ') || 'coherente',
  );

  // ── §6.4 · lease y heartbeat ─────────────────────────────────────────────
  const inFlight = jobs.rows.filter(
    (job) => job.status === 'leased' || job.status === 'uploading_result',
  );
  if (inFlight.length === 0) {
    record('6.4', 'lease vivo y latido reciente', 'n/a', 'ningún job en vuelo ahora mismo');
  } else {
    for (const job of inFlight) {
      record(
        '6.4',
        `lease de ${job.stage}`,
        job.lease_alive === true && job.credential_label !== null ? 'PASS' : 'FAIL',
        `vivo=${job.lease_alive} credencial=${job.credential_label ?? 'null'}`,
      );
      const age =
        job.last_heartbeat_at === null
          ? null
          : Math.round((Date.now() - new Date(job.last_heartbeat_at).getTime()) / 1000);
      record(
        '6.4',
        `latido de ${job.stage}`,
        age !== null && age < 120 ? 'PASS' : 'FAIL',
        age === null ? 'sin latido' : `hace ${age}s, progreso=${job.progress_pct ?? '—'}`,
      );
    }
  }

  // ── §6.5 · el sondeo del normalizado ─────────────────────────────────────
  const normalized = await query<{
    run_id: string | null;
    duration_seconds: string | null;
    sample_rate: number | null;
    channels: number | null;
    codec: string | null;
    probe_ok: boolean | null;
  }>(
    `SELECT run_id, duration_seconds, sample_rate, channels, codec, probe_ok
       FROM meeting_media
      WHERE meeting_id = $1 AND role = 'normalized' AND deleted_at IS NULL`,
    [meeting.id],
  );
  if (normalized.rows.length === 0) {
    record('6.5', 'medio normalizado con el formato pactado', 'n/a', 'normalize aún no cerró');
  } else if (normalized.rows.length > 1) {
    record('6.5', 'un solo normalizado VIVO por run', 'FAIL', `${normalized.rows.length} vivos`);
  } else {
    const row = normalized.rows[0];
    const ok =
      row.sample_rate === 16000 &&
      row.channels === 1 &&
      row.codec === 'pcm_s16le' &&
      row.probe_ok === true &&
      row.run_id !== null;
    record(
      '6.5',
      'normalizado: 16 kHz mono pcm_s16le, sondeado, con run',
      ok ? 'PASS' : 'FAIL',
      `${row.sample_rate ?? '—'}Hz ${row.channels ?? '—'}ch ${row.codec ?? '—'} ` +
        `probe_ok=${row.probe_ok ?? 'null'} dur=${row.duration_seconds ?? '—'} ` +
        `run=${row.run_id === null ? 'NULO' : 'sí'}`,
    );
  }

  // ── §6.6 · checksums de los artefactos ───────────────────────────────────
  const uploads = await query<{
    kind: string;
    state: string;
    checksum_matches: boolean | null;
    bytes_match: boolean | null;
  }>(
    `SELECT kind, state,
            declared_checksum_sha256 = observed_checksum_sha256 AS checksum_matches,
            declared_bytes = observed_bytes AS bytes_match
       FROM meeting_result_uploads WHERE meeting_id = $1 ORDER BY created_at`,
    [meeting.id],
  );
  if (uploads.rows.length === 0) {
    record('6.6', 'artefactos verificados', 'n/a', 'ninguna subida todavía');
  } else {
    for (const upload of uploads.rows) {
      const terminal = upload.state === 'verified' || upload.state === 'ingested';
      record(
        '6.6',
        `artefacto ${upload.kind}`,
        terminal && upload.checksum_matches === true && upload.bytes_match === true
          ? 'PASS'
          : terminal
            ? 'FAIL'
            : 'n/a',
        `state=${upload.state} checksum=${upload.checksum_matches ?? '—'} ` +
          `bytes=${upload.bytes_match ?? '—'}`,
      );
    }
  }

  // ── §6.9 · la ingesta ────────────────────────────────────────────────────
  const versions = await query<{
    id: string;
    whisper_model: string;
    diarization_backend: string | null;
    language: string | null;
    duration_seconds: string;
    segment_count: number;
    schema_version: number;
    segments: string;
    speakers: string;
    share_sum: string | null;
  }>(
    `SELECT v.id, v.whisper_model, v.diarization_backend, v.language, v.duration_seconds,
            v.segment_count, v.schema_version,
            (SELECT count(*)::text FROM meeting_segments s WHERE s.transcript_id = v.id) AS segments,
            (SELECT count(*)::text FROM meeting_transcript_speakers ts WHERE ts.transcript_id = v.id) AS speakers,
            (SELECT sum(ts.talk_share_pct)::text FROM meeting_transcript_speakers ts
              WHERE ts.transcript_id = v.id) AS share_sum
       FROM meeting_transcript_versions v WHERE v.meeting_id = $1`,
    [meeting.id],
  );
  if (versions.rows.length === 0) {
    record('6.9', 'versión de transcript ingerida', 'n/a', 'la ingesta aún no ocurrió');
  } else {
    record(
      '6.9',
      'UNA sola versión de transcript',
      versions.rows.length === 1 ? 'PASS' : 'FAIL',
      `${versions.rows.length} versiones`,
    );
    const version = versions.rows[0];
    record(
      '6.9',
      'la versión es la activa de la reunión',
      meeting.active_transcript_id === version.id ? 'PASS' : 'FAIL',
      `activa=${meeting.active_transcript_id ?? 'null'}`,
    );
    record(
      '6.9',
      'segmentos = segment_count',
      version.segments === String(version.segment_count) ? 'PASS' : 'FAIL',
      `${version.segments} vs ${version.segment_count}`,
    );
    // talk_share_pct es numeric(5,2) con CHECK 0..100: suma ≈ 100, NO ≈ 1.
    const sum = version.share_sum === null ? null : Number(version.share_sum);
    const speakers = Number(version.speakers);
    record(
      '6.9',
      '≥ 2 hablantes y talk_share_pct suma ≈ 100',
      speakers >= 2 && sum !== null && Math.abs(sum - 100) < 1 ? 'PASS' : 'FAIL',
      `${speakers} hablantes, suma=${version.share_sum ?? '—'}`,
    );
    record(
      '6.9',
      'modelo y backend reportados por el worker',
      version.whisper_model !== '' ? 'PASS' : 'FAIL',
      `whisper=${version.whisper_model} diarizador=${version.diarization_backend ?? '—'} ` +
        `idioma=${version.language ?? '—'} schema=${version.schema_version}`,
    );
  }
  record(
    '6.9',
    'estados finales de la reunión',
    meeting.transcript_state === 'ready' || meeting.transcript_state === 'failed' ? 'PASS' : 'n/a',
    `transcript=${meeting.transcript_state} diarización=${meeting.diarization_state}`,
  );

  // ── §6 · fallo controlado ────────────────────────────────────────────────
  const failed = jobs.rows.filter((job) => job.failure_code !== null);
  if (failed.length === 0) {
    record('6.f', 'fallo controlado', 'n/a', 'ningún job con failure_code');
  } else {
    for (const job of failed) {
      const requeued = job.status === 'queued';
      record(
        '6.f',
        `fallo de ${job.stage}`,
        (requeued && job.backoff_pending === true) || job.status === 'failed' ? 'PASS' : 'FAIL',
        `status=${job.status} intentos=${job.attempts}/${job.max_attempts} ` +
          `código=${job.failure_code} backoff=${job.backoff_pending ?? '—'}`,
      );
    }
    const orphanMedia = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM meeting_media
        WHERE meeting_id = $1 AND role = 'normalized' AND probe_ok IS NOT TRUE`,
      [meeting.id],
    );
    record(
      '6.f',
      'un sondeo fallido no dejó fila de medio',
      orphanMedia.rows[0].n === '0' ? 'PASS' : 'FAIL',
      `${orphanMedia.rows[0].n} medios sin sondeo válido`,
    );
  }

  void tenantId;
}

async function verifyTenantScope(tenantId: string): Promise<void> {
  // ── §4 · la credencial del worker ────────────────────────────────────────
  const credentials = await query<{
    slug: string;
    scope: string;
    capabilities: string[];
    token_prefix: string;
    live: boolean;
  }>(
    `SELECT p.slug, p.scope, p.capabilities, c.token_prefix, c.revoked_at IS NULL AS live
       FROM worker_credentials c JOIN worker_pools p ON p.id = c.pool_id
      WHERE p.tenant_id = $1`,
    [tenantId],
  );
  if (credentials.rows.length === 0) {
    record('4', 'credencial del worker', 'FAIL', 'ninguna credencial del tenant');
  } else {
    for (const credential of credentials.rows) {
      const ok =
        credential.scope === 'single_tenant' &&
        credential.capabilities.length === 1 &&
        credential.capabilities[0] === 'meetings.transcribe';
      record(
        '4',
        `credencial ${credential.token_prefix}`,
        ok ? 'PASS' : 'FAIL',
        `pool=${credential.slug} scope=${credential.scope} ` +
          `caps={${credential.capabilities.join(',')}} viva=${credential.live}`,
      );
    }
    const maintenance = credentials.rows.filter((c) =>
      c.capabilities.includes('meetings.maintenance'),
    );
    record(
      '4',
      'ninguna credencial del tenant tiene mantenimiento',
      maintenance.length === 0 ? 'PASS' : 'FAIL',
      maintenance.length === 0 ? 'correcto' : `${maintenance.length} la tienen`,
    );
  }

  // ── §7.4 · el entitlement ────────────────────────────────────────────────
  const modules = await query<{ enabled: boolean; client_id: string }>(
    `SELECT enabled, client_id FROM client_modules
      WHERE tenant_id = $1 AND module_key = 'meetings'`,
    [tenantId],
  );
  record(
    '7.4',
    'módulo meetings habilitado',
    modules.rows.some((row) => row.enabled) ? 'PASS' : 'FAIL',
    modules.rows.map((row) => `${row.client_id.slice(0, 8)}=${row.enabled}`).join(' ') || 'sin filas',
  );
}

async function main(): Promise<number> {
  let tenantId: string;
  let meetingId: string | null;
  let database: ReturnType<typeof requireStagingEnvironment>;
  try {
    database = requireStagingEnvironment();
    const { values } = parseArgs(process.argv.slice(2));
    tenantId = requireUuid(values['tenant-id'], '--tenant-id');
    meetingId =
      values['meeting-id'] === undefined
        ? null
        : requireUuid(values['meeting-id'], '--meeting-id');
  } catch (error) {
    if (error instanceof StagingGuardError) {
      process.stderr.write(`✗ ${error.message}\n`);
      return 2;
    }
    throw error;
  }

  try {
    process.stdout.write(`base: ${database.database} @ ${database.host}\n`);
    process.stdout.write(`tenant: ${tenantId}\n\n`);
    await run(tenantId, meetingId);
  } catch (error) {
    process.stderr.write(`✗ fallo al verificar: ${(error as Error).message}\n`);
    return 1;
  } finally {
    await closePool();
  }

  const width = Math.max(...checks.map((check) => check.label.length));
  for (const check of checks) {
    const mark = check.verdict === 'PASS' ? '✓' : check.verdict === 'FAIL' ? '✗' : '·';
    process.stdout.write(
      `${mark} ${check.id.padEnd(4)} ${check.label.padEnd(width)}  ${check.detail}\n`,
    );
  }
  const failures = checks.filter((check) => check.verdict === 'FAIL');
  const pending = checks.filter((check) => check.verdict === 'n/a');
  process.stdout.write(
    `\n${failures.length === 0 ? 'VERIFICACIÓN VERDE' : 'HAY FALLOS'} — ` +
      `${checks.length - failures.length - pending.length} pasan, ${failures.length} fallan, ` +
      `${pending.length} todavía no aplican\n`,
  );
  return failures.length === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`✗ ${(error as Error).message}\n`);
    process.exit(1);
  },
);

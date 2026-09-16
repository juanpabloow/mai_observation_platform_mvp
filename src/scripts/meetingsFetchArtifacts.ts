import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { closePool, query } from '../db/client.js';
import { resolveMeetingsStorage } from '../storage/meetingsStorage.js';
import { StagingGuardError, parseArgs, requireUuid } from './stagingGuard.js';

/**
 * Baja los INSUMOS de una reunión para investigarla fuera de la aplicación: el audio
 * normalizado y los artefactos crudos (turnos de diarización, transcripción).
 *
 *   MEETINGS_STORAGE_* … DATABASE_URL=… npx tsx src/scripts/meetingsFetchArtifacts.ts \
 *     --tenant-id <uuid> --client-id <uuid> --meeting-id <uuid> --out ./w3
 *
 * ── Tres decisiones, y las tres son el punto ────────────────────────────────
 *
 * 1 · LAS CLAVES SE LEEN DE LA BASE, NO SE CONSTRUYEN. `storageKeys.ts` sabe formar
 *     `turns.ndjson.gz`, pero adivinar el nombre desde aquí sería una segunda fuente
 *     de verdad que se desincroniza en silencio en cuanto cambie el layout. El audio
 *     normalizado sale de `meeting_media` (role='normalized'), y los artefactos de
 *     `meeting_result_uploads` (kind IN ('diarization','transcript')), que es su
 *     registro auditable — con su `state`, su `job_id` y su `attempt`.
 *
 * 2 · NO SE FIRMA NINGUNA URL. `store.getBytes(key)` hace GetObject del lado del
 *     servidor, así que no existe ninguna URL que pueda acabar en una consola, en un
 *     log ni en un portapapeles. `signGet` habría sido más corto y habría creado
 *     exactamente el objeto que no queremos que exista.
 *
 * 3 · SÓLO LEE. Ni un UPDATE, ni un INSERT, ni un DELETE — ni en la base ni en R2. Se
 *     puede correr con la reunión en cualquier estado y mientras el worker trabaja,
 *     sin conservar nada más que ficheros locales.
 *
 * El `.gz` se guarda tal cual Y descomprimido: el primero es lo que hay en R2 y su
 * SHA-256 se puede comparar con lo que la base declaró; el segundo es lo que se lee.
 */

interface Target {
  readonly tenantId: string;
  readonly clientId: string;
  readonly meetingId: string;
  readonly out: string;
}

interface Item {
  readonly kind: string;
  readonly storageKey: string;
  readonly contentEncoding: string | null;
  readonly note: string;
}

/** El audio normalizado: el MISMO insumo que recibió el worker, no el original. */
async function normalizedMedia(target: Target): Promise<Item[]> {
  const result = await query<{
    storage_key: string;
    duration_seconds: string | null;
    sample_rate: number | null;
    codec: string | null;
  }>(
    `SELECT storage_key, duration_seconds, sample_rate, codec
       FROM meeting_media
      WHERE meeting_id = $1 AND tenant_id = $2 AND client_id = $3
        AND role = 'normalized' AND deleted_at IS NULL
      ORDER BY created_at DESC`,
    [target.meetingId, target.tenantId, target.clientId],
  );
  return result.rows.map((row) => ({
    kind: 'normalized_media',
    storageKey: row.storage_key,
    contentEncoding: null,
    note: `${row.duration_seconds ?? '?'} s · ${row.sample_rate ?? '?'} Hz · ${row.codec ?? '?'}`,
  }));
}

/**
 * Los artefactos. Se piden TODOS los intentos, no sólo el ingerido: comparar dos
 * ejecuciones necesita ver las dos, y un `rejected` explica más que su ausencia.
 */
async function artifacts(target: Target): Promise<Item[]> {
  const result = await query<{
    kind: string;
    storage_key: string;
    content_encoding: string | null;
    state: string;
    attempt: number;
    job_id: string;
    observed_bytes: string | null;
  }>(
    `SELECT kind, storage_key, content_encoding, state, attempt, job_id, observed_bytes
       FROM meeting_result_uploads
      WHERE meeting_id = $1 AND tenant_id = $2 AND client_id = $3
        AND kind IN ('diarization', 'transcript')
      ORDER BY kind, attempt`,
    [target.meetingId, target.tenantId, target.clientId],
  );
  return result.rows.map((row) => ({
    kind: row.kind,
    storageKey: row.storage_key,
    contentEncoding: row.content_encoding,
    note: `state=${row.state} attempt=${row.attempt} job=${row.job_id.slice(0, 8)} bytes=${row.observed_bytes ?? '?'}`,
  }));
}

export async function run(
  argv: readonly string[],
  out: (line: string) => void,
): Promise<number> {
  const { values } = parseArgs(argv);
  const target: Target = {
    tenantId: requireUuid(values['tenant-id'], '--tenant-id'),
    clientId: requireUuid(values['client-id'], '--client-id'),
    meetingId: requireUuid(values['meeting-id'], '--meeting-id'),
    out: values.out ?? './w3-artifacts',
  };

  const storage = resolveMeetingsStorage(process.env);
  if (storage.store === null) {
    throw new StagingGuardError(
      `El almacenamiento no está configurado: ${storage.problems.join(' · ')}`,
    );
  }

  const items = [...(await normalizedMedia(target)), ...(await artifacts(target))];
  if (items.length === 0) {
    out(`Esa reunión no tiene ni audio normalizado ni artefactos registrados.`);
    return 1;
  }

  mkdirSync(target.out, { recursive: true });
  out(`reunión ${target.meetingId} → ${target.out}`);

  for (const item of items) {
    // Las claves NO se construyen aquí: vienen de la fila. Se imprime el basename para
    // poder cotejarlo, no la clave completa, que lleva el layout del bucket.
    const name = `${item.kind}.${basename(item.storageKey)}`;
    let bytes: Buffer;
    try {
      bytes = await storage.store.getBytes(item.storageKey);
    } catch (cause) {
      out(`  ✗ ${item.kind.padEnd(17)} ${(cause as Error).message}`);
      continue;
    }
    const sha = createHash('sha256').update(bytes).digest('hex');
    writeFileSync(join(target.out, name), bytes);
    out(`  ✓ ${item.kind.padEnd(17)} ${String(bytes.length).padStart(10)} B  sha256=${sha.slice(0, 16)}…  ${item.note}`);

    // Descomprimido además, cuando la base dice que está comprimido. Se guarda el
    // original igualmente: es lo que hay en R2 y su hash es comparable.
    if (item.contentEncoding === 'gzip' || item.storageKey.endsWith('.gz')) {
      try {
        const plain = gunzipSync(bytes);
        const plainName = name.replace(/\.gz$/, '');
        writeFileSync(join(target.out, plainName), plain);
        const lines = plain.toString('utf8').trimEnd().split('\n').length;
        out(`    → ${plainName}  ${lines} líneas NDJSON`);
      } catch (cause) {
        out(`    ! no se pudo descomprimir: ${(cause as Error).message}`);
      }
    }
  }
  out('Sólo lectura: no se ha escrito nada en la base ni en R2.');
  await closePool();
  return 0;
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  run(process.argv.slice(2), (line) => console.log(line))
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}

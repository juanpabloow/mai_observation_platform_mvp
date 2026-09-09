import { closePool, query, withTransaction } from '../db/client.js';
import type { Queryable } from '../db/repositories/meetings/types.js';
import {
  StagingGuardError,
  assertConnectedDatabase,
  parseArgs,
  requireStagingEnvironment,
  requireUuid,
} from './stagingGuard.js';

/**
 * Retira todo lo que W-3 dejó en la base. **Destructivo.**
 *
 *   # inventario, sin borrar nada (el defecto)
 *   MEETINGS_ENV_KIND=staging DATABASE_URL=… \
 *     npx tsx src/scripts/meetingsStagingCleanup.ts --tenant-id <uuid>
 *
 *   # borrado de verdad
 *   MEETINGS_ENV_KIND=staging DATABASE_URL=… \
 *     npx tsx src/scripts/meetingsStagingCleanup.ts --tenant-id <uuid> \
 *       --execute --confirm "BORRAR <uuid>"
 *
 * ── Tres cerrojos, y ninguno se activa por accidente ────────────────────────
 *
 * 1. `MEETINGS_ENV_KIND=staging` — la puerta común. Sin ella no arranca.
 * 2. `--tenant-id <uuid>` explícito. No hay defecto, no hay «el último», no hay
 *    `--all`. Un script de borrado que pueda ejecutarse sin decir qué borra es
 *    un accidente esperando su turno.
 * 3. `--execute` **y** `--confirm "BORRAR <el mismo uuid>"`. La frase incluye el
 *    uuid, así que copiarla de un runbook o del historial no sirve para otro
 *    tenant: hay que escribirla para ESTE. Es la diferencia entre una
 *    confirmación y un trámite.
 *
 * Sin los tres, el script hace un inventario y sale con 0. `--dry-run` es el
 * comportamiento por defecto, no una opción que haya que recordar.
 *
 * ── El orden importa, y no se delega al cascade ─────────────────────────────
 *
 * `DELETE FROM tenants` funciona hoy —lo comprobé contra una base desechable— y
 * el motivo es que el cascade retira jobs y eventos antes de llegar a las
 * credenciales, que están protegidas con `ON DELETE RESTRICT`. Pero ese orden
 * depende de en qué secuencia se crearon las constraints, no de nada que
 * hayamos declarado. Así que aquí se borra paso a paso, en el orden que se
 * sostiene por sí mismo:
 *
 *   revocar credenciales → reuniones (cascada) → credenciales → pools →
 *   client_modules → clients → tenant_members → tenant
 *
 * ── Lo que este script NO hace ──────────────────────────────────────────────
 *
 * · No borra objetos de R2. La base guarda claves, no puede borrar en
 *   Cloudflare, y pretender lo contrario dejaría audio real creyendo que se
 *   limpió. Imprime el prefijo para que lo borres tú.
 * · No borra el usuario. Es de Better Auth y probablemente sea tu cuenta.
 * · No toca pools con `scope='internal'`: tienen `tenant_id NULL` y no
 *   pertenecen a ningún tenant. W-3 no crea ninguno; si existe, sale en el
 *   inventario como aviso.
 */

interface Inventory {
  readonly label: string;
  readonly count: number;
}

async function takeInventory(tenantId: string, executor?: Queryable): Promise<Inventory[]> {
  const q = executor ?? { query };
  const counts = await q.query<Record<string, string>>(
    `SELECT
       (SELECT count(*) FROM meetings WHERE tenant_id = $1)::text AS reuniones,
       (SELECT count(*) FROM meeting_media WHERE tenant_id = $1)::text AS medios,
       (SELECT count(*) FROM meeting_processing_runs WHERE tenant_id = $1)::text AS runs,
       (SELECT count(*) FROM meeting_processing_jobs WHERE tenant_id = $1)::text AS jobs,
       (SELECT count(*) FROM meeting_job_events WHERE tenant_id = $1)::text AS eventos,
       (SELECT count(*) FROM meeting_result_uploads WHERE tenant_id = $1)::text AS subidas,
       (SELECT count(*) FROM meeting_transcript_versions WHERE tenant_id = $1)::text AS transcripts,
       (SELECT count(*) FROM meeting_segments WHERE tenant_id = $1)::text AS segmentos,
       (SELECT count(*) FROM meeting_speakers WHERE tenant_id = $1)::text AS hablantes,
       (SELECT count(*) FROM worker_credentials c JOIN worker_pools p ON p.id = c.pool_id
         WHERE p.tenant_id = $1)::text AS credenciales,
       (SELECT count(*) FROM worker_pools WHERE tenant_id = $1)::text AS pools,
       (SELECT count(*) FROM client_modules WHERE tenant_id = $1)::text AS modulos,
       (SELECT count(*) FROM clients WHERE tenant_id = $1)::text AS clientes,
       (SELECT count(*) FROM tenant_members WHERE tenant_id = $1)::text AS miembros,
       (SELECT count(*) FROM tenants WHERE id = $1)::text AS tenants`,
    [tenantId],
  );
  const row = counts.rows[0];
  return Object.entries(row).map(([label, value]) => ({ label, count: Number(value) }));
}

async function purge(tenantId: string): Promise<void> {
  await withTransaction(async (client) => {
    const executor = client as unknown as Queryable;
    // Dentro de la transacción y antes del primer DELETE. La comprobación de
    // `requireStagingEnvironment` compara CADENAS; ésta pregunta al servidor, y
    // es la única que un pooler no puede engañar.
    await assertConnectedDatabase(executor);

    // 1 · Revocar antes de borrar. No es ceremonia: si algo falla a mitad, lo
    //     que queda es una credencial revocada, no una viva cuyo pool ya no
    //     existe.
    await executor.query(
      `UPDATE worker_credentials c
          SET revoked_at = now(), revoked_actor = 'system',
              revoked_actor_label = 'meetingsStagingCleanup',
              revoked_reason = 'limpieza de W-3'
        WHERE c.revoked_at IS NULL
          AND c.pool_id IN (SELECT id FROM worker_pools WHERE tenant_id = $1)`,
      [tenantId],
    );

    // 2 · Las reuniones. Cascada a runs, jobs, eventos, medios, subidas,
    //     versiones de transcript, segmentos y hablantes.
    await executor.query(`DELETE FROM meetings WHERE tenant_id = $1`, [tenantId]);

    // 3 · Ya no hay jobs ni eventos apuntando a las credenciales, así que el
    //     RESTRICT no bloquea.
    await executor.query(
      `DELETE FROM worker_credentials
        WHERE pool_id IN (SELECT id FROM worker_pools WHERE tenant_id = $1)`,
      [tenantId],
    );
    await executor.query(`DELETE FROM worker_pools WHERE tenant_id = $1`, [tenantId]);

    // 4 · El resto del andamiaje del tenant.
    await executor.query(`DELETE FROM client_modules WHERE tenant_id = $1`, [tenantId]);
    await executor.query(`DELETE FROM clients WHERE tenant_id = $1`, [tenantId]);
    await executor.query(`DELETE FROM tenant_members WHERE tenant_id = $1`, [tenantId]);
    await executor.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
  });
}

function confirmationPhrase(tenantId: string): string {
  return `BORRAR ${tenantId}`;
}

async function main(): Promise<number> {
  let tenantId: string;
  let execute: boolean;
  let confirm: string;
  let database: ReturnType<typeof requireStagingEnvironment>;
  try {
    database = requireStagingEnvironment();
    const { flags, values } = parseArgs(process.argv.slice(2));
    tenantId = requireUuid(values['tenant-id'], '--tenant-id');
    execute = flags.has('execute');
    confirm = (values['confirm'] ?? '').trim();
    if (flags.has('dry-run') && execute) {
      throw new StagingGuardError('--dry-run y --execute son incompatibles.');
    }
    // La frase se valida AQUÍ, en el bloque de argumentos, antes de abrir la
    // conexión. Estaba después del inventario, así que una frase equivocada
    // salía con el error de conexión en vez de con el de confirmación — y en
    // una base alcanzable habría leído catorce tablas para nada. Un script que
    // se va a negar no debe haber tocado la base ni para contar.
    if (execute && confirm !== confirmationPhrase(tenantId)) {
      throw new StagingGuardError(
        `--execute exige --confirm con la frase EXACTA de este tenant:\n` +
          `    --confirm "${confirmationPhrase(tenantId)}"\n` +
          `  Recibido: ${confirm === '' ? '(nada)' : `'${confirm}'`}\n` +
          `  No se ha borrado nada.`,
      );
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
    out(`base:   ${database.database} @ ${database.host}`);
    out(`tenant: ${tenantId}`);
    out('');

    await assertConnectedDatabase({ query });
    const before = await takeInventory(tenantId);
    const total = before.reduce((sum, item) => sum + item.count, 0);
    out('── inventario ──────────────────────────────────────────────');
    for (const item of before) {
      out(`  ${item.label.padEnd(14)} ${String(item.count).padStart(6)}`);
    }
    out('');

    if (total === 0) {
      out('No hay nada de este tenant. Nada que borrar.');
      return 0;
    }

    // El pool interno, si existe, no cuelga de ningún tenant y este script no
    // lo alcanza. Se avisa en vez de borrarlo: podría ser de otra cosa.
    const internal = await query<{ slug: string }>(
      `SELECT slug FROM worker_pools WHERE scope = 'internal'`,
    );
    if (internal.rows.length > 0) {
      out(
        `AVISO: existen ${internal.rows.length} pool(es) con scope='internal' ` +
          `(${internal.rows.map((row) => row.slug).join(', ')}). Tienen tenant_id NULL, ` +
          `así que este script NO los toca. W-3 no crea ninguno; si sobra, bórralo por slug.`,
      );
      out('');
    }

    if (!execute) {
      out('── DRY-RUN (el defecto) ────────────────────────────────────');
      out('No se ha borrado nada. Para borrar de verdad hacen falta LAS DOS cosas:');
      out('');
      out(`  --execute --confirm "${confirmationPhrase(tenantId)}"`);
      out('');
      out('La frase lleva el uuid dentro a propósito: copiarla del runbook o del');
      out('historial no sirve para otro tenant.');
      return 0;
    }

    out('── BORRANDO ────────────────────────────────────────────────');
    await purge(tenantId);

    const after = await takeInventory(tenantId);
    for (const item of after) {
      const mark = item.count === 0 ? '✓' : '✗';
      out(`  ${mark} ${item.label.padEnd(14)} ${String(item.count).padStart(6)}`);
    }
    const remaining = after.reduce((sum, item) => sum + item.count, 0);
    out('');
    if (remaining !== 0) {
      process.stderr.write(`✗ quedan ${remaining} filas del tenant. La limpieza NO está completa.\n`);
      return 1;
    }
    out('Base limpia: los quince conteos dan 0.');
    out('');
    out('── LO QUE SIGUE SIN LIMPIAR ────────────────────────────────');
    out(`Los objetos de R2 bajo el prefijo  t/${tenantId}/`);
    out('Este script no puede borrarlos: la base guarda claves, no tiene acceso a');
    out('Cloudflare. Bórralos tú y comprueba que el listado del prefijo sale vacío.');
    out('El usuario de Better Auth tampoco se toca: probablemente sea tu cuenta.');
    return 0;
  } catch (error) {
    process.stderr.write(`✗ fallo al limpiar: ${(error as Error).message}\n`);
    return 1;
  } finally {
    await closePool();
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`✗ ${(error as Error).message}\n`);
    process.exit(1);
  },
);

import { closePool, query } from '../db/client.js';
import { logger } from '../logger.js';

/**
 * Preflight de la base ANTES de aplicar las migraciones de Reuniones.
 *
 *   npm run meetings:preflight
 *
 * Se ejecuta contra `DATABASE_URL`. No modifica nada: sólo lee el catálogo y
 * hace una prueba en una transacción que revierte.
 *
 * ── Por qué existe ─────────────────────────────────────────────────────────
 *
 * El esquema de Reuniones usa `ON DELETE SET NULL (columna)` en tres claves
 * ajenas compuestas. Esa sintaxis —anular SÓLO las columnas nombradas en vez de
 * todas las de la clave— **es de PostgreSQL 15**. En 14 o anterior, la
 * migración falla con un error de sintaxis en mitad del `CREATE TABLE`.
 *
 * Y ese fallo es de los peores que puede haber en un despliegue: no es que el
 * esquema quede mal, es que la migración se para donde se pare y hay que
 * averiguar en qué estado quedó. Un preflight que compara un número y aborta
 * cuesta un segundo.
 *
 * La validación se hizo en 18.4. Lo que este script fija es el **mínimo**, no
 * la versión probada: cualquier 15+ sirve, y decirlo así evita que alguien
 * concluya que hace falta 18 para desplegar.
 *
 * Comprueba tres cosas, en orden de coste:
 *
 *   1. La versión del servidor, contra `MINIMUM_SERVER_VERSION_NUM`.
 *   2. Que las extensiones que el esquema base ya usa siguen ahí (`pgcrypto`
 *      para `gen_random_uuid()`, que todas las tablas nuevas usan como
 *      DEFAULT). En PostgreSQL 13+ `gen_random_uuid()` es nativa, así que esto
 *      es informativo salvo en instalaciones que la esperen de la extensión.
 *   3. Que `ON DELETE SET NULL (columna)` funciona DE VERDAD en este servidor,
 *      creando dos tablas temporales, borrando una fila y comprobando que sólo
 *      se anuló la columna nombrada. Comparar un número de versión demuestra
 *      que la sintaxis debería existir; esto demuestra que existe.
 */

// 15.0. `server_version_num` es 150000 para 15.0, 180004 para 18.4.
const MINIMUM_SERVER_VERSION_NUM = 150_000;
const MINIMUM_LABEL = '15';

type Check = { name: string; ok: boolean; detail: string };

async function checkServerVersion(): Promise<Check> {
  const { rows } = await query<{ num: string; full: string }>(
    "SELECT current_setting('server_version_num') AS num, version() AS full",
  );
  const num = Number(rows[0].num);
  // version() trae compilador y plataforma; sobra para un log de preflight.
  const short = rows[0].full.split(' ').slice(0, 2).join(' ');
  return {
    name: `server_version >= ${MINIMUM_LABEL}`,
    ok: num >= MINIMUM_SERVER_VERSION_NUM,
    detail:
      num >= MINIMUM_SERVER_VERSION_NUM
        ? `${short} (server_version_num=${num})`
        : `${short} es anterior a ${MINIMUM_LABEL}: 'ON DELETE SET NULL (columna)' no existe y las migraciones de Reuniones fallarán a mitad`,
  };
}

async function checkGenRandomUuid(): Promise<Check> {
  const { rows } = await query<{ ok: boolean }>(
    "SELECT to_regprocedure('gen_random_uuid()') IS NOT NULL AS ok",
  );
  return {
    name: 'gen_random_uuid() disponible',
    ok: rows[0].ok,
    detail: rows[0].ok
      ? 'resuelve (nativa en 13+ o vía pgcrypto)'
      : "no resuelve: instala pgcrypto o revisa el search_path, porque toda tabla nueva la usa como DEFAULT",
  };
}

/**
 * La prueba real. Se hace en una transacción que siempre revierte, sobre tablas
 * temporales, así que no deja rastro ni en el esquema ni en los datos.
 */
async function checkSetNullOnColumn(): Promise<Check> {
  try {
    await query('BEGIN');
    await query(`
      CREATE TEMP TABLE _pf_parent (
        id int NOT NULL,
        scope int NOT NULL,
        CONSTRAINT _pf_parent_key UNIQUE (id, scope)
      ) ON COMMIT DROP;
      CREATE TEMP TABLE _pf_child (
        scope     int NOT NULL,
        parent_id int,
        CONSTRAINT _pf_child_fkey FOREIGN KEY (parent_id, scope)
          REFERENCES _pf_parent (id, scope) ON DELETE SET NULL (parent_id)
      ) ON COMMIT DROP;
      INSERT INTO _pf_parent VALUES (1, 9);
      INSERT INTO _pf_child  VALUES (9, 1);
      DELETE FROM _pf_parent WHERE id = 1;
    `);
    // La fila hija tiene que seguir ahí, con parent_id anulado y scope intacto.
    // Si el servidor hubiera intentado anular las dos columnas, el NOT NULL de
    // scope habría abortado el DELETE.
    const { rows } = await query<{ ok: boolean }>(
      'SELECT (parent_id IS NULL AND scope = 9) AS ok FROM _pf_child',
    );
    await query('ROLLBACK');
    const ok = rows.length === 1 && rows[0].ok;
    return {
      name: 'ON DELETE SET NULL (columna)',
      ok,
      detail: ok
        ? 'anula sólo la columna nombrada y conserva el resto de la clave'
        : 'la constraint existe pero no se comportó como se espera; no apliques las migraciones',
    };
  } catch (err) {
    await query('ROLLBACK').catch(() => undefined);
    return {
      name: 'ON DELETE SET NULL (columna)',
      ok: false,
      detail: `no soportado: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function main(): Promise<void> {
  const checks: Check[] = [
    await checkServerVersion(),
    await checkGenRandomUuid(),
    await checkSetNullOnColumn(),
  ];

  for (const check of checks) {
    logger.info(`${check.ok ? 'OK  ' : 'FALLO'} ${check.name} — ${check.detail}`);
  }

  const failed = checks.filter((check) => !check.ok);
  if (failed.length > 0) {
    logger.error(
      `Preflight FALLIDO (${failed.length} de ${checks.length}). No apliques las migraciones de Reuniones contra esta base.`,
    );
    process.exitCode = 1;
    return;
  }
  logger.info(`Preflight OK (${checks.length}/${checks.length}).`);
}

main()
  .catch((err) => {
    logger.error({ err }, 'meetings:preflight falló de forma inesperada');
    process.exitCode = 1;
  })
  .finally(() => closePool());

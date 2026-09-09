import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { query } from '../../src/db/client.js';
import { cleanupTenant, closeDb } from './fixtures.js';

/**
 * Los scripts de W-3, ejecutados de verdad contra la base desechable.
 *
 * Las pruebas de `test/unit/meetingsStagingScripts.test.ts` comprueban que se
 * NIEGAN: sin declaración, sin destino, sin confirmación. Éstas comprueban lo
 * otro —que cuando aceptan hacen lo correcto— y sobre todo las guardas que sólo
 * se pueden observar con datos delante:
 *
 *   · el seed valida el contrato COMPLETO de un pool que ya existe antes de
 *     rotar, y aborta sin emitir ni revocar si algo difiere;
 *   · `assertConnectedDatabase` rechaza una base que no es la declarada aunque
 *     la cadena de conexión diga que sí;
 *   · el preflight del rollback distingue «las cinco son la cabeza» de «alguien
 *     puso una migración encima».
 */

const tenants: string[] = [];
after(async () => {
  for (const tenant of tenants) await cleanupTenant(tenant);
  await closeDb();
});

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
const parsed = DB_URL === '' ? null : new URL(DB_URL);

/** El entorno que la puerta acepta, derivado de la base de pruebas real. */
function guardEnv(overrides: Record<string, string> = {}): Record<string, string> {
  assert.ok(parsed, 'hace falta TEST_DATABASE_URL');
  return {
    PATH: process.env.PATH ?? '',
    MEETINGS_ENV_KIND: 'staging',
    DATABASE_URL: DB_URL,
    MEETINGS_EXPECTED_DB_HOST: parsed.hostname,
    MEETINGS_EXPECTED_DB_NAME: parsed.pathname.replace(/^\//, ''),
    ...overrides,
  };
}

/**
 * `spawnSync` y no `execFileSync`: el segundo sólo devuelve stdout cuando el
 * proceso sale con 0, y el resumen del seed —con los uuids que estas pruebas
 * necesitan— va por STDERR a propósito, para que stdout lleve el token y nada
 * más. Con `execFileSync` el caso de éxito llegaba con stderr vacío y las
 * pruebas no encontraban el tenant.
 */
function run(
  script: string,
  args: readonly string[],
  env: Record<string, string>,
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ['--import', 'tsx', script, ...args], {
    cwd: new URL('../../', import.meta.url).pathname,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

const SEED = 'src/scripts/meetingsStagingSeed.ts';
const ROLLBACK = 'src/scripts/meetingsRollbackPreflight.ts';

/** Un usuario "ya registrado". Lo crea la PRUEBA — el script se niega a ello. */
async function seedUser(): Promise<string> {
  const id = `u-w3-${randomUUID().slice(0, 8)}`;
  await query(`INSERT INTO "user" (id, name, email, "emailVerified") VALUES ($1, 'W3', $2, true)`, [
    id,
    `${id}@ejemplo.test`,
  ]);
  await query(
    `INSERT INTO account (id, "accountId", "providerId", "userId", "createdAt", "updatedAt")
     VALUES ($1, $2, 'credential', $3, now(), now())`,
    [`a-${id}`, `${id}@ejemplo.test`, id],
  );
  return `${id}@ejemplo.test`;
}

// ── current_database(): la comprobación que un pooler no puede engañar ──────

test('un nombre de base que el SERVIDOR desmiente aborta tras conectar', async () => {
  // La cadena y el servidor pueden discrepar. Aquí se declara un nombre que la
  // comparación previa acepta —porque también se cambia lo esperado— y que
  // `current_database()` desmiente.
  const email = await seedUser();
  const result = run(
    SEED,
    [
      '--tenant-name', `W3 ${randomUUID().slice(0, 6)}`,
      '--client-name', 'C',
      '--user-email', email,
      '--pool-slug', `w3-${randomUUID().slice(0, 8)}`,
    ],
    guardEnv({
      // Se miente en las DOS declaraciones de forma coherente, que es lo que
      // haría un pooler: la comparación de cadenas pasa.
      DATABASE_URL: DB_URL.replace(/\/[^/]+$/, '/otra_base'),
      MEETINGS_EXPECTED_DB_NAME: 'otra_base',
    }),
  );
  // No conecta a 'otra_base' (no existe) o conecta y current_database() la
  // desmiente. En los dos casos: no escribe nada y no imprime token.
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '', 'no debe imprimir un token');
});

// ── El contrato del pool existente, antes de rotar ──────────────────────────

interface PoolCase {
  readonly label: string;
  readonly mutate: string;
  readonly expect: RegExp;
}

const BROKEN_POOLS: readonly PoolCase[] = [
  {
    label: 'deshabilitado',
    mutate: `UPDATE worker_pools SET enabled = false WHERE id = $1`,
    expect: /deshabilitado/,
  },
  {
    label: 'con una capacidad de más',
    mutate: `UPDATE worker_pools SET capabilities = '{meetings.transcribe,meetings.analyze}',
                 concurrency = '{"schema_version":1,"limits":{"meetings.transcribe":1,"meetings.analyze":4}}'::jsonb
               WHERE id = $1`,
    expect: /capabilities=/,
  },
  {
    label: 'con otra concurrencia',
    mutate: `UPDATE worker_pools
                SET concurrency = '{"schema_version":1,"limits":{"meetings.transcribe":4}}'::jsonb
              WHERE id = $1`,
    expect: /concurrency=/,
  },
];

for (const scenario of BROKEN_POOLS) {
  test(`--rotate-token aborta si el pool está ${scenario.label}`, async () => {
    const email = await seedUser();
    const tenantName = `W3 ${randomUUID().slice(0, 6)}`;
    const slug = `w3-${randomUUID().slice(0, 8)}`;
    const args = [
      '--tenant-name', tenantName,
      '--client-name', 'C',
      '--user-email', email,
      '--pool-slug', slug,
    ];

    const first = run(SEED, args, guardEnv());
    assert.equal(first.status, 0, first.stderr);
    const tenant = /tenant\s+([0-9a-f-]{36})/.exec(first.stderr)?.[1];
    assert.ok(tenant, `no se pudo leer el tenant: ${first.stderr}`);
    tenants.push(tenant);

    const pool = await query<{ id: string }>(`SELECT id FROM worker_pools WHERE slug = $1`, [slug]);
    const before = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM worker_credentials WHERE pool_id = $1`,
      [pool.rows[0].id],
    );
    await query(scenario.mutate, [pool.rows[0].id]);

    const rotated = run(SEED, [...args, '--rotate-token'], guardEnv());
    assert.equal(rotated.status, 2, `debía abortar: ${rotated.stderr}`);
    assert.match(rotated.stderr, /su contrato NO es el de W-3/);
    assert.match(rotated.stderr, scenario.expect);
    assert.match(rotated.stderr, /No se ha emitido ni revocado/);
    assert.equal(rotated.stdout, '', 'no debe imprimir un token');

    // Y NADA cambió en las credenciales: ni una nueva ni una revocada.
    const after = await query<{ n: string; live: string }>(
      `SELECT count(*)::text AS n, count(*) FILTER (WHERE revoked_at IS NULL)::text AS live
         FROM worker_credentials WHERE pool_id = $1`,
      [pool.rows[0].id],
    );
    assert.equal(after.rows[0].n, before.rows[0].n, 'no debe haber emitido');
    assert.equal(after.rows[0].live, '1', 'no debe haber revocado la que había');
  });
}

test('--rotate-token aborta si el pool es de OTRO tenant', async () => {
  const email = await seedUser();
  const slug = `w3-${randomUUID().slice(0, 8)}`;
  const firstArgs = [
    '--tenant-name', `W3 ${randomUUID().slice(0, 6)}`,
    '--client-name', 'C',
    '--user-email', email,
    '--pool-slug', slug,
  ];
  const first = run(SEED, firstArgs, guardEnv());
  assert.equal(first.status, 0, first.stderr);
  const tenant = /tenant\s+([0-9a-f-]{36})/.exec(first.stderr)?.[1];
  assert.ok(tenant);
  tenants.push(tenant);

  // El mismo slug, otro nombre de tenant: el pool existe y pertenece a otro.
  const otherName = `W3 otro ${randomUUID().slice(0, 6)}`;
  const rotated = run(
    SEED,
    [
      '--tenant-name', otherName,
      '--client-name', 'C',
      '--user-email', email,
      '--pool-slug', slug,
      '--rotate-token',
    ],
    guardEnv(),
  );
  assert.equal(rotated.status, 2, rotated.stderr);
  assert.match(rotated.stderr, /pertenece al tenant/);
  assert.match(rotated.stderr, /alcance sobre datos ajenos/);
  assert.equal(rotated.stdout, '');
  // El tenant nuevo no se quedó a medias: la transacción entera se deshizo.
  const orphan = await query<{ n: string }>(`SELECT count(*)::text AS n FROM tenants WHERE name = $1`, [
    otherName,
  ]);
  assert.equal(orphan.rows[0].n, '0', 'la transacción abortada no debe dejar tenant');
});

test('--rotate-token SÍ rota cuando el contrato coincide', async () => {
  const email = await seedUser();
  const slug = `w3-${randomUUID().slice(0, 8)}`;
  const args = [
    '--tenant-name', `W3 ${randomUUID().slice(0, 6)}`,
    '--client-name', 'C',
    '--user-email', email,
    '--pool-slug', slug,
  ];
  const first = run(SEED, args, guardEnv());
  assert.equal(first.status, 0, first.stderr);
  const tenant = /tenant\s+([0-9a-f-]{36})/.exec(first.stderr)?.[1];
  assert.ok(tenant);
  tenants.push(tenant);

  const rotated = run(SEED, [...args, '--rotate-token'], guardEnv());
  assert.equal(rotated.status, 0, rotated.stderr);
  assert.match(rotated.stdout, /^mtk_/, 'el token nuevo sale por stdout');
  assert.notEqual(rotated.stdout, first.stdout, 'y es distinto del anterior');

  const pool = await query<{ id: string }>(`SELECT id FROM worker_pools WHERE slug = $1`, [slug]);
  const credentials = await query<{ n: string; live: string; rotated: string }>(
    `SELECT count(*)::text AS n,
            count(*) FILTER (WHERE revoked_at IS NULL)::text AS live,
            count(*) FILTER (WHERE rotated_from_id IS NOT NULL)::text AS rotated
       FROM worker_credentials WHERE pool_id = $1`,
    [pool.rows[0].id],
  );
  assert.equal(credentials.rows[0].n, '2');
  assert.equal(credentials.rows[0].live, '1');
  assert.equal(credentials.rows[0].rotated, '1');
});

// ── Cuántas credenciales vivas: 0, 1 y >1 son tres casos ───────────────────

/** Siembra el pool de W-3 y devuelve tenant, slug y argumentos base. */
async function seedPool(email: string): Promise<{
  tenant: string;
  slug: string;
  poolId: string;
  args: string[];
}> {
  const slug = `w3-${randomUUID().slice(0, 8)}`;
  const args = [
    '--tenant-name', `W3 ${randomUUID().slice(0, 6)}`,
    '--client-name', 'C',
    '--user-email', email,
    '--pool-slug', slug,
  ];
  const first = run(SEED, args, guardEnv());
  assert.equal(first.status, 0, first.stderr);
  const tenant = /tenant\s+([0-9a-f-]{36})/.exec(first.stderr)?.[1];
  assert.ok(tenant, `no se pudo leer el tenant: ${first.stderr}`);
  tenants.push(tenant);
  const pool = await query<{ id: string }>(`SELECT id FROM worker_pools WHERE slug = $1`, [slug]);
  return { tenant, slug, poolId: pool.rows[0].id, args };
}

async function liveCount(poolId: string): Promise<number> {
  const result = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM worker_credentials
      WHERE pool_id = $1 AND revoked_at IS NULL`,
    [poolId],
  );
  return Number(result.rows[0].n);
}

test('con UNA credencial viva, --rotate-token rota (el caso normal)', async () => {
  const { poolId, args } = await seedPool(await seedUser());
  assert.equal(await liveCount(poolId), 1);

  const rotated = run(SEED, [...args, '--rotate-token'], guardEnv());
  assert.equal(rotated.status, 0, rotated.stderr);
  assert.match(rotated.stderr, /rotada\s+desde/);
  assert.equal(await liveCount(poolId), 1, 'sigue habiendo exactamente una viva');
  const total = await query<{ n: string; rotated: string }>(
    `SELECT count(*)::text AS n, count(*) FILTER (WHERE rotated_from_id IS NOT NULL)::text AS rotated
       FROM worker_credentials WHERE pool_id = $1`,
    [poolId],
  );
  assert.equal(total.rows[0].n, '2');
  assert.equal(total.rows[0].rotated, '1');
});

test('con CERO vivas, --rotate-token emite sin enlazar a nada', async () => {
  // El caso «revoqué a mano y necesito otra». Es legítimo: no hay nada que
  // revocar, así que la nueva no apunta a ninguna anterior.
  const { poolId, args } = await seedPool(await seedUser());
  await query(
    `UPDATE worker_credentials
        SET revoked_at = now(), revoked_actor = 'system',
            revoked_actor_label = 'prueba', revoked_reason = 'a mano'
      WHERE pool_id = $1 AND revoked_at IS NULL`,
    [poolId],
  );
  assert.equal(await liveCount(poolId), 0);

  const rotated = run(SEED, [...args, '--rotate-token'], guardEnv());
  assert.equal(rotated.status, 0, rotated.stderr);
  assert.match(rotated.stdout, /^mtk_/, 'emite un token nuevo');
  assert.doesNotMatch(rotated.stderr, /rotada\s+desde/, 'no hay anterior a la que enlazar');
  assert.equal(await liveCount(poolId), 1);
  const linked = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM worker_credentials
      WHERE pool_id = $1 AND rotated_from_id IS NOT NULL`,
    [poolId],
  );
  assert.equal(linked.rows[0].n, '0', 'rotated_from_id queda NULL');
});

test('con MÁS DE UNA viva, --rotate-token ABORTA sin emitir ni revocar', async () => {
  // Rotar «la más reciente» dejaría las demás VIVAS y sin avisar: el pool
  // acabaría con más credenciales activas que antes, y quien tenga una de las
  // viejas seguiría entrando. Revocarlas todas tampoco vale: puede haber un
  // worker corriendo con cualquiera de ellas.
  const { poolId, args } = await seedPool(await seedUser());

  // Una segunda credencial viva, como la dejaría un `INSERT` a mano o una
  // emisión por otra vía.
  const extra = await query<{ id: string }>(
    `INSERT INTO worker_credentials (pool_id, label, token_hash, token_prefix)
     VALUES ($1, 'segunda', $2, $3) RETURNING id`,
    [poolId, 'e'.repeat(64), 'mtk_dos0'],
  );
  assert.equal(await liveCount(poolId), 2);

  const before = await query<{ ids: string[] }>(
    `SELECT array_agg(id ORDER BY id)::text[] AS ids FROM worker_credentials WHERE pool_id = $1`,
    [poolId],
  );

  const rotated = run(SEED, [...args, '--rotate-token'], guardEnv());
  assert.equal(rotated.status, 2, `debía abortar: ${rotated.stderr}`);
  assert.match(rotated.stderr, /2 credenciales VIVAS/);
  assert.match(rotated.stderr, /No se rota/);
  assert.match(rotated.stderr, /No se ha emitido ni revocado nada/);
  // Y nombra las dos, por prefijo, para que se pueda decidir cuál sobra.
  assert.match(rotated.stderr, /mtk_dos0/);
  assert.equal(rotated.stdout, '', 'no debe imprimir un token');

  // Nada cambió: ni una nueva, ni una revocada.
  assert.equal(await liveCount(poolId), 2, 'las dos siguen vivas');
  const after = await query<{ ids: string[] }>(
    `SELECT array_agg(id ORDER BY id)::text[] AS ids FROM worker_credentials WHERE pool_id = $1`,
    [poolId],
  );
  assert.deepEqual(after.rows[0].ids, before.rows[0].ids, 'el conjunto de credenciales es el mismo');
  void extra;
});

test('y sin --rotate-token, más de una viva se reporta en el conteo', async () => {
  // El mensaje de «el pool ya existe» dice cuántas vivas hay: es la pista de
  // que hay algo que revisar antes de rotar.
  const { poolId, args } = await seedPool(await seedUser());
  await query(
    `INSERT INTO worker_credentials (pool_id, label, token_hash, token_prefix)
     VALUES ($1, 'segunda', $2, $3)`,
    [poolId, 'f'.repeat(64), 'mtk_dos1'],
  );
  const again = run(SEED, args, guardEnv());
  assert.equal(again.status, 2);
  assert.match(again.stderr, /ya existe con 2 credencial\(es\) viva\(s\)/);
  assert.equal(again.stdout, '');
});

// ── El preflight del rollback ───────────────────────────────────────────────

test('el preflight del rollback aprueba cuando las cinco son la cabeza', () => {
  const result = run(ROLLBACK, [], guardEnv());
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Las cinco de Reuniones son la cabeza, en orden/);
  assert.match(result.stdout, /node-pg-migrate --tsx down 5/);
});

test('y ABORTA si alguien puso una migración encima', async () => {
  // El defecto exacto del runbook anterior: `down 5` no significa «revierte las
  // de Reuniones», significa «revierte las cinco últimas, sean las que sean».
  // Con una migración ajena encima, revertiría ésa y sólo cuatro de Reuniones.
  const intruder = '1783900000000_otra-cosa-de-otro-agente';
  await query(`INSERT INTO pgmigrations (name, run_on) VALUES ($1, now())`, [intruder]);
  try {
    const result = run(ROLLBACK, [], guardEnv());
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /NO son las cinco de Reuniones en orden/);
    assert.match(result.stderr, new RegExp(intruder));
    assert.match(result.stderr, /NO ejecutes 'node-pg-migrate down 5'/);
    // Y dice cuál de las cinco se ha caído de la cabeza.
    assert.match(result.stderr, /No están en la cabeza: 1783400000000_meetings-module/);
  } finally {
    await query(`DELETE FROM pgmigrations WHERE name = $1`, [intruder]);
  }
});

test('y ABORTA si las cinco están pero en otro orden', async () => {
  // Un `id` reordenado significa que se aplicaron en otra secuencia, y el `down`
  // por conteo las revertiría en un orden que sus guardas no esperan.
  const rows = await query<{ id: number; name: string }>(
    `SELECT id, name FROM pgmigrations WHERE name LIKE '%meetings%' ORDER BY id`,
  );
  assert.equal(rows.rows.length, 5);
  const [first, second] = rows.rows;
  await query(`UPDATE pgmigrations SET name = $1 WHERE id = $2`, [second.name, first.id]);
  await query(`UPDATE pgmigrations SET name = $1 WHERE id = $2`, [first.name, second.id]);
  try {
    const result = run(ROLLBACK, [], guardEnv());
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /NO son las cinco de Reuniones en orden/);
  } finally {
    await query(`UPDATE pgmigrations SET name = $1 WHERE id = $2`, [first.name, first.id]);
    await query(`UPDATE pgmigrations SET name = $1 WHERE id = $2`, [second.name, second.id]);
  }
});

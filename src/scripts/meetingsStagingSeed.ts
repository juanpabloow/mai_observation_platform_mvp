import { closePool, withTransaction } from '../db/client.js';
import type { Queryable } from '../db/repositories/meetings/types.js';
import { mintWorkerToken } from '../db/repositories/meetings/credentials.js';
import {
  ENV_KIND_VAR,
  StagingGuardError,
  assertConnectedDatabase,
  assertNoSecrets,
  parseArgs,
  requireStagingEnvironment,
} from './stagingGuard.js';

/**
 * Siembra el tenant, el cliente, el módulo y la credencial de worker para W-3.
 *
 *   MEETINGS_ENV_KIND=staging DATABASE_URL=… \
 *     npx tsx src/scripts/meetingsStagingSeed.ts \
 *       --tenant-name "W3" --client-name "Cliente W3" \
 *       --user-email persona@ejemplo.test --pool-slug w3-gpu --environment staging
 *
 * ── El contrato de idempotencia, y por qué NO reimprime el token ────────────
 *
 * De la credencial la base guarda `sha256(token)` y los ocho caracteres del
 * prefijo. **El token en claro no existe en ningún sitio después de esta
 * ejecución.** Así que «idempotente» aquí no puede significar «relanzarlo
 * devuelve lo mismo»: para devolver el mismo token habría que haberlo guardado,
 * y guardarlo sería el peor de los dos males posibles.
 *
 * Por eso:
 *
 *   · primera ejecución → crea todo e imprime el token UNA vez;
 *   · el pool o la credencial ya existen → **se detiene** con un mensaje que
 *     dice qué hacer. No inventa, no recupera, no reimprime;
 *   · `--rotate-token` → depende de cuántas credenciales VIVAS tenga el pool:
 *
 *       **0** — nada que revocar. Emite una nueva con `rotated_from_id = NULL`.
 *              Es el caso de «revoqué a mano y necesito otra».
 *       **1** — la rotación normal: emite, enlaza por `rotated_from_id` y
 *              revoca la anterior **en la misma transacción**. Ése es el ciclo
 *              que el esquema ya modela; el script lo usa en vez de inventar
 *              otro.
 *      **>1** — **aborta.** Rotar «la más reciente» dejaría las demás vivas y
 *              sin avisar: el pool acabaría con MÁS credenciales activas que
 *              antes, y quien tenga una de las viejas seguiría entrando.
 *              Revocarlas todas tampoco: puede haber un worker corriendo con
 *              cualquiera de ellas, y cuál sobra no lo decide un script.
 *
 * Un script que reimprimiera el token tendría que guardarlo; uno que lo
 * regenerara en silencio dejaría al worker en producción con una credencial
 * revocada sin que nadie lo hubiera pedido. Detenerse es la única opción que no
 * es una de esas dos.
 *
 * ── El usuario NO se crea aquí ──────────────────────────────────────────────
 *
 * `user`, `account` y `session` son tablas de Better Auth. Insertar un usuario a
 * mano produce una fila que parece válida y con la que nadie puede entrar: sin
 * `account` no hay credencial de acceso, y los formatos de hash y de
 * verificación los define la librería, no nosotros. Peor: una fila así
 * enmascara el problema hasta que alguien intenta iniciar sesión.
 *
 * Así que el usuario se registra ANTES por el flujo real (`/signup`), y este
 * script sólo **comprueba que existe**. Si no existe, aborta sin escribir nada.
 */

interface Args {
  readonly tenantName: string;
  readonly clientName: string;
  readonly userEmail: string;
  readonly poolSlug: string;
  /**
   * Sólo `staging`. Este script existe para W-3 y nada más: `worker_pools`
   * admite tres entornos, pero permitir `production` aquí convertiría una
   * herramienta de validación en una de aprovisionamiento — con su token
   * impreso en una terminal y su idempotencia pensada para una prueba.
   */
  readonly environment: 'staging';
  readonly rotateToken: boolean;
}

function readArgs(argv: readonly string[]): Args {
  const { flags, values } = parseArgs(argv);
  const required = (name: string): string => {
    const value = (values[name] ?? '').trim();
    if (value === '') throw new StagingGuardError(`Falta --${name}.`);
    return value;
  };
  const environment = (values['environment'] ?? 'staging').trim();
  if (environment !== 'staging') {
    throw new StagingGuardError(
      `--environment sólo admite 'staging' (recibido '${environment}'). Este script es ` +
        `de W-3: imprime un token en una terminal y su idempotencia está pensada para ` +
        `una prueba. Aprovisionar un pool de producción es otra tarea, con otras ` +
        `garantías, y no debe compartir herramienta con ésta.`,
    );
  }
  const userEmail = required('user-email').toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(userEmail)) {
    throw new StagingGuardError('--user-email no parece un correo.');
  }
  const poolSlug = required('pool-slug');
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(poolSlug)) {
    // El mismo patrón que el CHECK de `worker_pools.slug`. Validarlo aquí
    // convierte una violación de constraint a mitad de transacción en un
    // mensaje que dice qué corregir.
    throw new StagingGuardError('--pool-slug debe casar con ^[a-z0-9][a-z0-9-]{1,62}$.');
  }
  return {
    tenantName: required('tenant-name'),
    clientName: required('client-name'),
    userEmail,
    poolSlug,
    environment: 'staging',
    rotateToken: flags.has('rotate-token'),
  };
}

interface ExistingUser {
  readonly id: string;
  readonly email: string;
}

/**
 * ¿Existe ya el usuario, registrado por el flujo real?
 *
 * Se comprueba también que tenga una fila en `account`: un `user` sin `account`
 * es exactamente la fila a medias que un `INSERT` manual habría dejado, y con
 * ella no se puede iniciar sesión. Distinguir los dos casos importa, porque el
 * arreglo es distinto.
 */
async function findUser(executor: Queryable, email: string): Promise<ExistingUser> {
  const found = await executor.query<{ id: string; email: string; accounts: string }>(
    `SELECT u.id, u.email,
            (SELECT count(*) FROM account a WHERE a."userId" = u.id)::text AS accounts
       FROM "user" u WHERE lower(u.email) = lower($1)`,
    [email],
  );
  const row = found.rows[0];
  if (!row) {
    throw new StagingGuardError(
      `No existe ningún usuario con ese correo. Regístralo PRIMERO por el flujo real ` +
        `(/signup en el mai de staging) y vuelve a ejecutar esto. Este script no crea ` +
        `usuarios: 'user' y 'account' son de Better Auth, y una fila insertada a mano ` +
        `parece válida y no permite entrar.`,
    );
  }
  if (Number(row.accounts) === 0) {
    throw new StagingGuardError(
      `El usuario existe pero no tiene ninguna fila en 'account', así que no puede ` +
        `iniciar sesión. Es la fila a medias que deja un INSERT manual. Complétalo por ` +
        `el flujo real antes de sembrar.`,
    );
  }
  return { id: row.id, email: row.email };
}

interface SeedResult {
  readonly tenantId: string;
  readonly clientId: string;
  readonly poolId: string;
  readonly credentialId: string;
  readonly tokenPrefix: string;
  readonly token: string;
  readonly rotatedFrom: string | null;
  readonly reusedTenant: boolean;
  readonly reusedClient: boolean;
}

async function seed(args: Args): Promise<SeedResult> {
  return withTransaction(async (client) => {
    const executor = client as unknown as Queryable;
    // Lo primero dentro de la transacción, antes de leer o escribir nada: la
    // cadena de conexión y el servidor pueden discrepar.
    await assertConnectedDatabase(executor);
    const user = await findUser(executor, args.userEmail);

    // ── Pool: la clave de idempotencia ────────────────────────────────────
    // `pools_slug_env_key UNIQUE (slug, environment)`. Si ya existe, este
    // script no puede continuar sin decidir por ti qué hacer con su credencial.
    const existingPool = await executor.query<{
      id: string;
      tenant_id: string | null;
      scope: string;
      enabled: boolean;
      capabilities: string[];
      concurrency: { schema_version?: number; limits?: Record<string, number> } | null;
    }>(
      `SELECT id, tenant_id, scope, enabled, capabilities, concurrency
         FROM worker_pools WHERE slug = $1 AND environment = $2`,
      [args.poolSlug, args.environment],
    );
    const poolExists = existingPool.rows.length > 0;

    if (poolExists && !args.rotateToken) {
      const live = await executor.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM worker_credentials
          WHERE pool_id = $1 AND revoked_at IS NULL`,
        [existingPool.rows[0].id],
      );
      throw new StagingGuardError(
        `El pool '${args.poolSlug}' (${args.environment}) ya existe con ` +
          `${live.rows[0].n} credencial(es) viva(s). NO se puede recuperar su token: la ` +
          `base sólo guarda el sha256 y el prefijo, y reimprimirlo exigiría haberlo ` +
          `almacenado.\n` +
          `  · Si perdiste el token → vuelve a ejecutar con --rotate-token. Emite uno ` +
          `nuevo, lo enlaza al anterior por rotated_from_id y revoca el anterior en la ` +
          `misma transacción.\n` +
          `  · Si el worker ya está corriendo con él → no hace falta nada.`,
      );
    }

    // ── Tenant y cliente: reusables por nombre ────────────────────────────
    const tenantRow = await executor.query<{ id: string }>(
      `SELECT id FROM tenants WHERE name = $1`,
      [args.tenantName],
    );
    const reusedTenant = tenantRow.rows.length > 0;
    const tenantId =
      tenantRow.rows[0]?.id ??
      (
        await executor.query<{ id: string }>(
          `INSERT INTO tenants (name) VALUES ($1) RETURNING id`,
          [args.tenantName],
        )
      ).rows[0].id;

    // `is_default = false` obligatorio: `resolveAppScope` rechaza el cliente por
    // defecto del tenant, así que sembrar uno por defecto daría 404 en todas las
    // rutas de sesión y parecería un problema de permisos.
    const clientRow = await executor.query<{ id: string; is_default: boolean }>(
      `SELECT id, is_default FROM clients WHERE tenant_id = $1 AND name = $2`,
      [tenantId, args.clientName],
    );
    if (clientRow.rows[0]?.is_default) {
      throw new StagingGuardError(
        `El cliente '${args.clientName}' es el cliente POR DEFECTO del tenant. ` +
          `resolveAppScope lo rechaza a propósito; usa otro nombre.`,
      );
    }
    const reusedClient = clientRow.rows.length > 0;
    const clientId =
      clientRow.rows[0]?.id ??
      (
        await executor.query<{ id: string }>(
          `INSERT INTO clients (tenant_id, name, is_default) VALUES ($1, $2, false) RETURNING id`,
          [tenantId, args.clientName],
        )
      ).rows[0].id;

    // ── Membresía del usuario, para que pueda entrar por el navegador ─────
    // La tabla es `tenant_members`. Rol 'owner' porque
    // `tenant_members_role_client_check` exige `member_client_id` sólo para el
    // rol 'member', y un owner alcanza todos los clientes del tenant — que es
    // lo que hace falta para probar la UI y las rutas de sesión.
    await executor.query(
      `INSERT INTO tenant_members (tenant_id, user_id, role)
       VALUES ($1, $2, 'owner')
       ON CONFLICT (tenant_id, user_id) DO NOTHING`,
      [tenantId, user.id],
    );

    // ── El entitlement del módulo ─────────────────────────────────────────
    await executor.query(
      `INSERT INTO client_modules (tenant_id, client_id, module_key, enabled)
       VALUES ($1, $2, 'meetings', true)
       ON CONFLICT (tenant_id, client_id, module_key) DO UPDATE SET enabled = true`,
      [tenantId, clientId],
    );

    // ── Si el pool ya existía, su contrato COMPLETO antes de rotar ────────
    //
    // `--rotate-token` emite y revoca. Hacerlo sobre un pool cuyo contrato no
    // es el que este script crea sería peor que no hacer nada: se revocaría una
    // credencial en uso y se emitiría otra con un alcance que nadie revisó. Así
    // que se comprueban las cinco cosas, y cualquier diferencia aborta ANTES de
    // emitir o revocar.
    if (poolExists) {
      const pool = existingPool.rows[0];
      const problems: string[] = [];
      if (pool.scope !== 'single_tenant') {
        problems.push(`scope='${pool.scope}' (se esperaba 'single_tenant')`);
      }
      if (pool.tenant_id !== tenantId) {
        problems.push(
          `pertenece al tenant ${pool.tenant_id ?? 'NULO'} y no a ${tenantId}` +
            ` — rotar hacia otro tenant sería darle alcance sobre datos ajenos`,
        );
      }
      if (!pool.enabled) problems.push('está deshabilitado (enabled = false)');
      const caps = [...(pool.capabilities ?? [])].sort();
      if (caps.length !== 1 || caps[0] !== 'meetings.transcribe') {
        problems.push(`capabilities={${caps.join(',')}} (se esperaba {meetings.transcribe})`);
      }
      const limits = pool.concurrency?.limits ?? {};
      const limitKeys = Object.keys(limits).sort();
      if (
        pool.concurrency?.schema_version !== 1 ||
        limitKeys.length !== 1 ||
        limitKeys[0] !== 'meetings.transcribe' ||
        limits['meetings.transcribe'] !== 1
      ) {
        problems.push(
          `concurrency=${JSON.stringify(pool.concurrency)} ` +
            `(se esperaba schema_version 1 y limits {"meetings.transcribe":1})`,
        );
      }
      if (problems.length > 0) {
        throw new StagingGuardError(
          `El pool '${args.poolSlug}' (${args.environment}) existe pero su contrato NO es ` +
            `el de W-3:\n` +
            problems.map((problem) => `  · ${problem}`).join('\n') +
            `\nNo se ha emitido ni revocado ninguna credencial. Revísalo a mano: rotar ` +
            `sobre un pool que no reconozco revocaría una credencial en uso y emitiría ` +
            `otra con un alcance que nadie ha revisado.`,
        );
      }
    }

    // ── El pool: single_tenant, sólo transcribe ───────────────────────────
    // NUNCA 'internal' y NUNCA con meetings.maintenance: un worker normal no
    // debe poder reencolar trabajo de otros tenants.
    // `pools_scope_allows_capabilities` lo impediría igual, pero no escribirlo
    // es mejor que confiar en que la base lo pare.
    const poolId = poolExists
      ? existingPool.rows[0].id
      : (
          await executor.query<{ id: string }>(
            `INSERT INTO worker_pools
               (slug, environment, scope, tenant_id, capabilities, concurrency, created_by_user_id)
             VALUES ($1, $2, 'single_tenant', $3, '{meetings.transcribe}',
                     '{"schema_version":1,"limits":{"meetings.transcribe":1}}'::jsonb, $4)
             RETURNING id`,
            [args.poolSlug, args.environment, tenantId, user.id],
          )
        ).rows[0].id;


    // ── La credencial ─────────────────────────────────────────────────────
    const minted = mintWorkerToken();
    let rotatedFrom: string | null = null;

    if (args.rotateToken) {
      // ── 0, 1 y >1 credenciales vivas son TRES casos distintos ───────────
      //
      //   0 → no hay nada que revocar. Se emite una nueva con
      //       `rotated_from_id = NULL`. Es el caso de «revoqué a mano y ahora
      //       necesito otra», y es legítimo.
      //   1 → la rotación normal: se emite, se enlaza y se revoca la anterior
      //       en esta misma transacción.
      //  >1 → SE ABORTA. Rotar «la más reciente» dejaría las otras VIVAS y sin
      //       avisar, que es lo contrario de lo que uno cree que hace al
      //       rotar: el pool acabaría con más credenciales activas que antes,
      //       y quien las tenga seguiría entrando. Revocar todas por
      //       iniciativa propia tampoco vale: puede haber un worker corriendo
      //       con una de ellas y no me toca decidir cuál sobra.
      const live = await executor.query<{ id: string; token_prefix: string; created_at: Date }>(
        `SELECT id, token_prefix, created_at FROM worker_credentials
          WHERE pool_id = $1 AND revoked_at IS NULL
          ORDER BY created_at DESC`,
        [poolId],
      );
      if (live.rows.length > 1) {
        throw new StagingGuardError(
          `El pool '${args.poolSlug}' tiene ${live.rows.length} credenciales VIVAS:\n` +
            live.rows
              .map(
                (row) =>
                  `  · ${row.token_prefix}  (${row.id}, emitida ${row.created_at.toISOString()})`,
              )
              .join('\n') +
            `\nNo se rota. Rotar la más reciente dejaría las demás activas sin avisar, y el ` +
            `pool acabaría con más credenciales vivas que antes. Revócalas tú, dejando como ` +
            `mucho una, y vuelve a intentarlo: cuál sobra no lo puedo decidir yo — puede ` +
            `haber un worker corriendo con cualquiera de ellas.\n` +
            `No se ha emitido ni revocado nada.`,
        );
      }
      rotatedFrom = live.rows[0]?.id ?? null;
    }

    const credential = await executor.query<{ id: string }>(
      `INSERT INTO worker_credentials
         (pool_id, label, token_hash, token_prefix, rotated_from_id, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [
        poolId,
        `w3-${new Date().toISOString().slice(0, 10)}`,
        minted.tokenHash,
        minted.tokenPrefix,
        rotatedFrom,
        user.id,
      ],
    );

    if (rotatedFrom !== null) {
      // La revocación de la anterior va en la MISMA transacción que la emisión
      // de la nueva. Si fueran dos pasos, un fallo entre ellos dejaría dos
      // credenciales vivas o ninguna.
      await executor.query(
        `UPDATE worker_credentials
            SET revoked_at = now(), revoked_actor = 'system',
                revoked_actor_label = 'meetingsStagingSeed --rotate-token',
                revoked_reason = 'rotación de la credencial de W-3'
          WHERE id = $1 AND revoked_at IS NULL`,
        [rotatedFrom],
      );
    }

    return {
      tenantId,
      clientId,
      poolId,
      credentialId: credential.rows[0].id,
      tokenPrefix: minted.tokenPrefix,
      token: minted.token,
      rotatedFrom,
      reusedTenant,
      reusedClient,
    };
  });
}

async function main(): Promise<number> {
  let args: Args;
  let database: ReturnType<typeof requireStagingEnvironment>;
  try {
    // La puerta va PRIMERO, antes de leer argumentos y antes de conectar.
    database = requireStagingEnvironment();
    args = readArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof StagingGuardError) {
      process.stderr.write(`✗ ${error.message}\n`);
      return 2;
    }
    throw error;
  }

  // Todo el resumen va por STDERR. Sólo el token sale por stdout, así que
  // `... > token.txt` captura el token y nada más, y un `2>/dev/null` deja la
  // salida útil sin ruido.
  const say = (line: string): void => {
    assertNoSecrets(line);
    process.stderr.write(`${line}\n`);
  };

  say(`base: ${database.database} @ ${database.host}${database.local ? ' (local)' : ''}`);
  say(`entorno declarado: ${ENV_KIND_VAR}=staging`);

  try {
    const result = await seed(args);
    say('');
    say('── sembrado ────────────────────────────────────────────────');
    say(`tenant   ${result.tenantId}${result.reusedTenant ? '  (reutilizado)' : '  (nuevo)'}`);
    say(`client   ${result.clientId}${result.reusedClient ? '  (reutilizado)' : '  (nuevo)'}`);
    say(`pool     ${result.poolId}  ${args.poolSlug} / ${args.environment}`);
    say(`         scope=single_tenant  capabilities={meetings.transcribe}`);
    say(`cred     ${result.credentialId}  prefijo=${result.tokenPrefix}`);
    if (result.rotatedFrom !== null) {
      say(`rotada   desde ${result.rotatedFrom}, revocada en la misma transacción`);
    }
    say(`módulo   meetings habilitado para el cliente`);
    say('');
    say('El TOKEN sale por stdout y NO se guarda en ninguna parte. Cópialo ahora al');
    say('.env.w3 de la PC Linux (MAI_WORKER_TOKEN). Si lo pierdes, la única salida es');
    say('--rotate-token: la base sólo tiene su sha256.');
    say('');

    // La única escritura en stdout de todo el script.
    process.stdout.write(`${result.token}\n`);
    return 0;
  } catch (error) {
    if (error instanceof StagingGuardError) {
      process.stderr.write(`\n✗ ${error.message}\n`);
      return 2;
    }
    // Nunca se imprime el error crudo de PostgreSQL: puede llevar el valor de
    // un parámetro. Sólo el mensaje, que es texto del servidor.
    process.stderr.write(`\n✗ fallo al sembrar: ${(error as Error).message}\n`);
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

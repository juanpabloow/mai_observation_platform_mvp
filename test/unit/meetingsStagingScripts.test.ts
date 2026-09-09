import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  ENV_KIND_VAR,
  EXPECTED_HOST_VAR,
  EXPECTED_NAME_VAR,
  REQUIRED_ENV_KIND,
  StagingGuardError,
  assertConnectedDatabase,
  assertNoSecrets,
  describeDatabase,
  parseArgs,
  requireStagingEnvironment,
  requireUuid,
} from '../../src/scripts/stagingGuard.js';

/** El entorno mínimo que la puerta acepta. */
const STAGING = {
  [ENV_KIND_VAR]: REQUIRED_ENV_KIND,
  DATABASE_URL: 'postgresql://u:p@db.staging.example:5432/mai_staging',
  [EXPECTED_HOST_VAR]: 'db.staging.example',
  [EXPECTED_NAME_VAR]: 'mai_staging',
} as const;

/**
 * Las protecciones de los scripts de W-3.
 *
 * Lo que se prueba aquí no es que los scripts funcionen —eso lo demuestra
 * ejecutarlos contra la base desechable— sino que **se nieguen**: sin
 * declaración de entorno, sin tenant explícito, sin la frase de confirmación, y
 * sin reimprimir un token que no pueden recuperar.
 *
 * Una protección sin prueba es una intención. Y la protección de un script
 * destructivo es lo único que separa «limpiar staging» de «borrar el tenant
 * equivocado», así que es exactamente lo que no puede quedarse sin cubrir.
 */

const REPO = new URL('../../', import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, REPO), 'utf8');

// ── La puerta de entorno ────────────────────────────────────────────────────

test('sin declaración de entorno, la puerta se cierra', () => {
  const { [ENV_KIND_VAR]: _omitted, ...rest } = STAGING;
  assert.throws(
    () => requireStagingEnvironment(rest),
    (error: unknown) =>
      error instanceof StagingGuardError && error.message.includes(ENV_KIND_VAR),
  );
});

test('con una declaración que no es staging, tampoco', () => {
  for (const kind of ['production', 'prod', 'development', 'dev', 'x']) {
    assert.throws(
      () => requireStagingEnvironment({ ...STAGING, [ENV_KIND_VAR]: kind }),
      StagingGuardError,
      `'${kind}' no debe pasar`,
    );
  }
});

test('NODE_ENV no sustituye a la declaración', () => {
  // Staging corre con NODE_ENV=production, que es el punto de que se parezca a
  // producción. Si la puerta mirara NODE_ENV, o bloquearía staging o abriría
  // producción.
  const { [ENV_KIND_VAR]: _omitted, ...rest } = STAGING;
  assert.throws(
    () => requireStagingEnvironment({ ...rest, NODE_ENV: 'staging' }),
    StagingGuardError,
  );
});

test('con las TRES declaraciones coherentes pasa, y devuelve host y base', () => {
  const description = requireStagingEnvironment({
    ...STAGING,
    DATABASE_URL: 'postgresql://usuario:contrasena@db.staging.example:5432/mai_staging',
  });
  assert.equal(description.host, 'db.staging.example:5432');
  assert.equal(description.database, 'mai_staging');
  assert.equal(description.local, false);
});

test('la declaración no basta sin DATABASE_URL', () => {
  const { DATABASE_URL: _omitted, ...rest } = STAGING;
  assert.throws(() => requireStagingEnvironment(rest), StagingGuardError);
});

// ── La SEGUNDA afirmación: el destino esperado ──────────────────────────────

test('declarar staging NO basta: hacen falta host y nombre esperados', () => {
  // El accidente que esto impide: MEETINGS_ENV_KIND=staging con la
  // DATABASE_URL de producción pegada del portapapeles. Una variable dice qué
  // crees; la otra, a dónde apuntas.
  for (const missing of [EXPECTED_HOST_VAR, EXPECTED_NAME_VAR]) {
    const env: Record<string, string> = { ...STAGING };
    delete env[missing];
    assert.throws(
      () => requireStagingEnvironment(env),
      (error: unknown) => error instanceof StagingGuardError && error.message.includes(missing),
      `sin ${missing} no debe pasar`,
    );
  }
});

test('un host distinto del declarado aborta antes de conectar', () => {
  assert.throws(
    () =>
      requireStagingEnvironment({
        ...STAGING,
        DATABASE_URL: 'postgresql://u:p@db.PRODUCCION.example:5432/mai_staging',
      }),
    (error: unknown) =>
      error instanceof StagingGuardError &&
      error.message.includes('No se ha conectado') &&
      // Y el mensaje NO lleva la contraseña.
      !error.message.includes(':p@'),
  );
});

test('un nombre de base distinto del declarado también aborta', () => {
  assert.throws(
    () =>
      requireStagingEnvironment({
        ...STAGING,
        DATABASE_URL: 'postgresql://u:p@db.staging.example:5432/mai_produccion',
      }),
    (error: unknown) =>
      error instanceof StagingGuardError && error.message.includes(EXPECTED_NAME_VAR),
  );
});

test('el host se compara sin puerto, en los dos sentidos', () => {
  // Obligar a declarar el puerto idéntico convertiría la protección en una
  // molestia que alguien acabaría rodeando.
  assert.doesNotThrow(() =>
    requireStagingEnvironment({ ...STAGING, [EXPECTED_HOST_VAR]: 'db.staging.example:5432' }),
  );
  assert.doesNotThrow(() =>
    requireStagingEnvironment({
      ...STAGING,
      DATABASE_URL: 'postgresql://u:p@db.staging.example/mai_staging',
    }),
  );
});

test('la comparación de host y base no distingue mayúsculas', () => {
  assert.doesNotThrow(() =>
    requireStagingEnvironment({
      ...STAGING,
      [EXPECTED_HOST_VAR]: 'DB.Staging.Example',
      [EXPECTED_NAME_VAR]: 'MAI_STAGING',
    }),
  );
});

// ── La comprobación POST-conexión ───────────────────────────────────────────

test('assertConnectedDatabase acepta la base que el servidor confirma', async () => {
  const executor = { query: async () => ({ rows: [{ name: 'mai_staging' }] }) };
  assert.equal(await assertConnectedDatabase(executor, STAGING), 'mai_staging');
});

test('assertConnectedDatabase rechaza una base distinta de la declarada', async () => {
  // El caso que la comparación de cadenas no puede ver: un pooler que redirige.
  const executor = { query: async () => ({ rows: [{ name: 'mai_produccion' }] }) };
  await assert.rejects(
    () => assertConnectedDatabase(executor, STAGING),
    (error: unknown) =>
      error instanceof StagingGuardError &&
      error.message.includes('current_database()') &&
      error.message.includes('No se ha escrito nada'),
  );
});

test('assertConnectedDatabase no acepta una respuesta vacía', async () => {
  const executor = { query: async () => ({ rows: [] }) };
  await assert.rejects(() => assertConnectedDatabase(executor, STAGING), StagingGuardError);
});

// ── Nada de secretos por ningún flujo ───────────────────────────────────────

test('describeDatabase NUNCA devuelve usuario, contraseña ni query', () => {
  const url = 'postgresql://elusuario:lacontrasena@host.example:5432/base?sslmode=require';
  const description = describeDatabase({ DATABASE_URL: url });
  const printed = JSON.stringify(description);
  for (const secret of ['elusuario', 'lacontrasena', 'sslmode']) {
    assert.ok(!printed.includes(secret), `${secret} no debe salir: ${printed}`);
  }
  assert.equal(description.host, 'host.example:5432');
  assert.equal(description.database, 'base');
});

test('una DATABASE_URL ilegible no se filtra en el mensaje', () => {
  // El caso desagradable: si el parseo fallara lanzando con el texto dentro,
  // el manejador de errores imprimiría la URL entera.
  const description = describeDatabase({ DATABASE_URL: 'esto-no-es-una-url-con-secreto-dentro' });
  assert.equal(description.host, '(ilegible)');
  assert.ok(!JSON.stringify(description).includes('secreto'));
});

test('assertNoSecrets ataja un texto que contenga un secreto del entorno', () => {
  const env = { DATABASE_URL: 'postgresql://u:contrasena-larguisima@h/db' };
  assert.throws(
    () => assertNoSecrets(`conectando a postgresql://u:contrasena-larguisima@h/db`, env),
    StagingGuardError,
  );
  // Y no salta con texto inocente.
  assert.doesNotThrow(() => assertNoSecrets('conectando a db @ h', env));
});

test('assertNoSecrets ignora valores demasiado cortos para ser secretos', () => {
  // Un ENCRYPTION_KEY de prueba puesto a '0' haría saltar el aserto sobre
  // cualquier texto con un cero, y entonces el script no podría imprimir nada.
  assert.doesNotThrow(() => assertNoSecrets('tenant 0 de 10', { ENCRYPTION_KEY: '0' }));
});

// ── Argumentos ──────────────────────────────────────────────────────────────

test('parseArgs distingue banderas de valores', () => {
  const parsed = parseArgs(['--tenant-id', 'abc', '--execute', '--confirm', 'BORRAR abc']);
  assert.equal(parsed.values['tenant-id'], 'abc');
  assert.equal(parsed.values['confirm'], 'BORRAR abc');
  assert.ok(parsed.flags.has('execute'));
  assert.ok(!parsed.flags.has('tenant-id'));
});

test('requireUuid rechaza lo que no es un uuid', () => {
  for (const value of [undefined, '', 'abc', '11111111-1111-1111-1111-11111111111', 'zzzzzzzz-1111-1111-1111-111111111111']) {
    assert.throws(() => requireUuid(value, '--tenant-id'), StagingGuardError, `'${value}'`);
  }
  assert.equal(
    requireUuid('11111111-2222-3333-4444-555555555555', '--tenant-id'),
    '11111111-2222-3333-4444-555555555555',
  );
});

// ── El script de verificación es SÓLO LECTURA ───────────────────────────────

test('meetingsStagingVerify no contiene ninguna escritura', () => {
  const source = read('src/scripts/meetingsStagingVerify.ts');
  // Se buscan las palabras SQL dentro de literales de plantilla. Un
  // `INSERT`/`UPDATE`/`DELETE` en este fichero significaría que la
  // verificación causa el estado que mide.
  for (const verb of ['INSERT INTO', 'UPDATE ', 'DELETE FROM', 'TRUNCATE', 'ALTER ']) {
    assert.ok(
      !source.includes(verb),
      `meetingsStagingVerify contiene '${verb}': dejaría de ser una verificación`,
    );
  }
  assert.ok(!source.includes('withTransaction'), 'no necesita transacción: no escribe');
});

test('los tres scripts exigen la puerta de staging', () => {
  for (const script of [
    'src/scripts/meetingsStagingSeed.ts',
    'src/scripts/meetingsStagingVerify.ts',
    'src/scripts/meetingsStagingCleanup.ts',
  ]) {
    assert.match(read(script), /requireStagingEnvironment\(\)/, `${script} debe exigir la puerta`);
  }
  assert.match(read('test/e2e/w3HttpChecks.sh'), /MEETINGS_ENV_KIND/, 'el script HTTP también');
});

test('ningún script imprime DATABASE_URL', () => {
  for (const script of [
    'src/scripts/meetingsStagingSeed.ts',
    'src/scripts/meetingsStagingVerify.ts',
    'src/scripts/meetingsStagingCleanup.ts',
  ]) {
    const source = read(script);
    // Ni interpolada ni leída para imprimir: la única vía permitida es
    // `describeDatabase`, que devuelve host y nombre.
    assert.ok(
      !/process\.env\.DATABASE_URL/.test(source),
      `${script} no debe leer DATABASE_URL directamente`,
    );
  }
});

// ── El seed: idempotencia sin reimprimir el token ───────────────────────────

test('el seed sólo escribe el token en stdout, una vez', () => {
  const source = read('src/scripts/meetingsStagingSeed.ts');
  const stdoutWrites = [...source.matchAll(/process\.stdout\.write\(/g)];
  assert.equal(
    stdoutWrites.length,
    1,
    'una sola escritura en stdout: así `> token.txt` captura el token y nada más',
  );
  assert.match(source, /process\.stdout\.write\(`\$\{result\.token\}\\n`\)/);
});

test('el seed no guarda ni relee el token en claro', () => {
  const source = read('src/scripts/meetingsStagingSeed.ts');
  // Lo que se inserta es el hash y el prefijo, nunca `minted.token`.
  assert.match(source, /minted\.tokenHash/);
  assert.match(source, /minted\.tokenPrefix/);
  assert.ok(
    !/INSERT[\s\S]{0,400}minted\.token[^HP]/.test(source),
    'el token en claro no puede acabar en un INSERT',
  );
  assert.ok(!/writeFile|appendFile/.test(source), 'el token no se escribe a ningún fichero');
});

test('el seed exige --rotate-token para volver a emitir', () => {
  const source = read('src/scripts/meetingsStagingSeed.ts');
  assert.match(source, /rotate-token/);
  // Y la rotación usa el ciclo del esquema: enlaza y revoca.
  assert.match(source, /rotated_from_id/);
  assert.match(source, /revoked_at = now\(\)/);
});

test('el seed no crea usuarios de autenticación', () => {
  const source = read('src/scripts/meetingsStagingSeed.ts');
  assert.ok(
    !/INSERT INTO "user"|INSERT INTO account|INSERT INTO session/.test(source),
    'user/account/session son de Better Auth: una fila a mano parece válida y no permite entrar',
  );
  // En su lugar, comprueba que existe Y que tiene cuenta.
  assert.match(source, /FROM "user"/);
  assert.match(source, /FROM account/);
});

// ── El cleanup: tres cerrojos ───────────────────────────────────────────────

test('el cleanup es dry-run por defecto', () => {
  const source = read('src/scripts/meetingsStagingCleanup.ts');
  assert.match(source, /flags\.has\('execute'\)/);
  // La rama de borrado está detrás de `if (!execute) { … return 0; }`.
  const executeIndex = source.indexOf('if (!execute)');
  const purgeIndex = source.indexOf('await purge(tenantId)');
  assert.ok(executeIndex > 0 && purgeIndex > executeIndex, 'purge va DESPUÉS del corte de dry-run');
});

test('el cleanup exige la frase de confirmación con el uuid dentro', () => {
  const source = read('src/scripts/meetingsStagingCleanup.ts');
  assert.match(source, /confirmationPhrase/);
  assert.match(source, /BORRAR \$\{tenantId\}/);
  // Y el purge va detrás de la comparación de la frase.
  const confirmIndex = source.indexOf('confirm !== confirmationPhrase(tenantId)');
  const purgeIndex = source.indexOf('await purge(tenantId)');
  assert.ok(confirmIndex > 0 && purgeIndex > confirmIndex, 'purge va DESPUÉS de la confirmación');
});

test('el cleanup no tiene --all ni ningún borrado sin tenant', () => {
  const source = read('src/scripts/meetingsStagingCleanup.ts');
  // Se busca en el CÓDIGO, no en los comentarios: la propia documentación del
  // script dice «no hay --all», y buscar el texto plano se encontraba a sí
  // misma.
  const code = source
    .split('\n')
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .join('\n');
  assert.ok(
    !/flags\.has\('all'\)|values\['all'\]/.test(code),
    'no debe existir una opción que borre todo',
  );
  // Toda sentencia de borrado lleva el filtro por tenant.
  // Sobre el CÓDIGO, por lo mismo: el comentario del script explica que
  // `DELETE FROM tenants` funciona hoy, y el escaneo se encontraba a sí mismo.
  const deletes = [...code.matchAll(/DELETE FROM [a-z_]+[^`]*/g)].map((m) => m[0]);
  assert.ok(deletes.length >= 6, `se esperaban varios DELETE, hay ${deletes.length}`);
  for (const statement of deletes) {
    assert.match(
      statement,
      /WHERE .*(tenant_id = \$1|id = \$1|pool_id IN \(SELECT id FROM worker_pools WHERE tenant_id = \$1\))/,
      `un DELETE sin filtro por tenant: ${statement}`,
    );
  }
});

test('el cleanup no pretende borrar objetos de R2', () => {
  const source = read('src/scripts/meetingsStagingCleanup.ts');
  // Decir que limpió lo que no puede limpiar dejaría audio real creyendo lo
  // contrario. Sólo imprime el prefijo.
  assert.ok(!/S3Client|DeleteObject|rclone/.test(source));
  assert.match(source, /prefijo/);
});

// ── El script HTTP: mutante y no mutante, separados ────────────────────────

test('el script HTTP NO hace un claim con token válido', () => {
  const source = read('test/e2e/w3HttpChecks.sh');
  // Es el defecto que motivó esta pasada. Un claim válido no es una consulta:
  // es `FOR UPDATE SKIP LOCKED` + `UPDATE`, le pone un lease de cinco minutos
  // al job y consume un intento. Y este script no manda latidos, así que el job
  // se quedaba colgado. Si el worker estaba corriendo, le robaba el trabajo.
  //
  // La única llamada a /claim con token que queda manda un cuerpo INVÁLIDO, así
  // que `readValidated` la corta antes de llegar a `claim()`.
  const withToken = [
    ...source.matchAll(/probe POST (\/api\/meetings\/v1\/jobs\/claim)[\s\S]{0,400}?\n\n/g),
  ].map((match) => match[0]);
  for (const call of withToken) {
    if (!call.includes('MAI_WORKER_TOKEN')) continue;
    assert.match(
      call,
      /tenantId/,
      'la única llamada a /claim con token debe llevar un cuerpo inválido, ' +
        'para que se rechace antes de reclamar',
    );
  }
});

test('el script HTTP separa el bloque no mutante del mutante', () => {
  const source = read('test/e2e/w3HttpChecks.sh');
  const a = source.indexOf('BLOQUE A · smoke de enrutado — NO MUTANTE');
  const b = source.indexOf('BLOQUE B · sesión — MUTANTE');
  assert.ok(a > 0, 'debe existir el bloque A');
  assert.ok(b > a, 'el bloque B va después del A');
  // La creación de reuniones vive DESPUÉS de la separación.
  const create = source.indexOf('crear reunión con sesión');
  assert.ok(create > b, 'crear reuniones pertenece al bloque mutante');
});

test('el script HTTP exige W3_ALLOW_WRITES para crear reuniones', () => {
  const source = read('test/e2e/w3HttpChecks.sh');
  assert.match(source, /W3_ALLOW_WRITES/);
  // Y el bloque mutante está detrás del corte.
  const gate = source.indexOf('if [[ "$ALLOW_WRITES" != "1" ]]');
  const create = source.indexOf('crear reunión con sesión');
  assert.ok(gate > 0 && create > gate, 'la creación va detrás de la autorización');
});

test('el script HTTP registra las reuniones creadas y nombra la limpieza', () => {
  const source = read('test/e2e/w3HttpChecks.sh');
  assert.match(source, /CREATED_MEETINGS\+=\(/, 'debe acumular los meetingId');
  assert.match(source, /REUNIONES CREADAS/, 'debe listarlas al terminar');
  assert.match(source, /w3:cleanup/, 'debe decir qué las retira');
});

test('el script HTTP no usa ficheros fijos en /tmp', () => {
  const source = read('test/e2e/w3HttpChecks.sh');
  // Los /tmp/w3* de antes eran predecibles y compartidos, y ahí se escriben
  // cuerpos de respuesta que en este endpoint incluyen URLs firmadas.
  assert.ok(!/\/tmp\/w3[a-z]/.test(source), 'ningún fichero fijo en /tmp');
  assert.match(source, /mktemp -d/);
  assert.match(source, /chmod 700 "\$WORK"/);
  assert.match(source, /trap cleanup EXIT INT TERM/, 'la limpieza corre incluso si muere');
  assert.match(source, /rm -rf "\$WORK"/);
});

test('el script HTTP no afirma que no escribe en la base', () => {
  const source = read('test/e2e/w3HttpChecks.sh');
  // La afirmación literal que era falsa. Que no vuelva.
  assert.ok(
    !/NO escribe en la base/.test(source) || /era FALSO/.test(source),
    'sólo puede aparecer describiendo el defecto corregido',
  );
});

test('el script HTTP no sigue redirecciones', () => {
  const source = read('test/e2e/w3HttpChecks.sh');
  // Con `-L`, el 307 del middleware se convertiría en el 200 de /login y el
  // fallo de B-1 se vería como un éxito raro.
  assert.ok(!/curl[^\n]*\s-L\b/.test(source), 'ningún curl con -L');
});

// ── El preflight del rollback ──────────────────────────────────────────────

test('el preflight del rollback nombra las cinco migraciones esperadas', () => {
  const source = read('src/scripts/meetingsRollbackPreflight.ts');
  for (const name of [
    '1783400000000_meetings-module',
    '1783500000000_meetings-core',
    '1783600000000_meetings-transcript',
    '1783700000000_meetings-worker-pools',
    '1783800000000_meetings-result-uploads',
  ]) {
    assert.ok(source.includes(name), `falta ${name}`);
  }
});

test('las cinco esperadas existen como ficheros de migración', () => {
  // Una lista escrita a mano que no case con el directorio haría que el
  // preflight abortara siempre, o peor, que aprobara un rollback equivocado.
  const source = read('src/scripts/meetingsRollbackPreflight.ts');
  const names = [...source.matchAll(/'(\d{13}_meetings-[a-z-]+)'/g)].map((match) => match[1]);
  assert.equal(names.length, 5);
  for (const name of names) {
    assert.doesNotThrow(
      () => readFileSync(new URL(`migrations/${name}.ts`, REPO)),
      `migrations/${name}.ts no existe`,
    );
  }
});

test('el preflight del rollback es sólo lectura', () => {
  const source = read('src/scripts/meetingsRollbackPreflight.ts');
  for (const verb of ['INSERT INTO', 'DELETE FROM', 'UPDATE ', 'DROP ', 'node-pg-migrate --tsx down']) {
    if (verb === 'node-pg-migrate --tsx down') {
      // El comando SÓLO puede aparecer dentro de un texto que se imprime, no
      // ejecutado: este script no revierte, dice cuándo es seguro revertir.
      assert.ok(!/execFile|spawn|exec\(/.test(source), 'no debe ejecutar nada');
      continue;
    }
    assert.ok(!source.includes(verb), `contiene '${verb}'`);
  }
});

// ── Las tres puertas, ejecutando los scripts de verdad ──────────────────────
//
// Los chequeos de arriba leen el fuente; estos EJECUTAN. Un `assert` sobre el
// texto no demuestra que el proceso salga con error, y es el proceso el que
// va a correr contra staging.

function runScript(
  script: string,
  args: readonly string[],
  env: Record<string, string>,
): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(
      process.execPath,
      ['--import', 'tsx', script, ...args],
      {
        cwd: new URL('.', REPO).pathname,
        env: { PATH: process.env.PATH ?? '', ...env },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: failure.status ?? 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    };
  }
}

/**
 * El entorno de proceso que la puerta acepta, apuntando a un host
 * INALCANZABLE a propósito. Si un script llegara a conectar, el error sería de
 * red; que salga con 2 hablando de argumentos demuestra que se detuvo antes.
 */
const PROC_ENV = {
  MEETINGS_ENV_KIND: 'staging',
  DATABASE_URL: 'postgresql://u:p@127.0.0.1:1/nada',
  MEETINGS_EXPECTED_DB_HOST: '127.0.0.1',
  MEETINGS_EXPECTED_DB_NAME: 'nada',
} as const;

const SCRIPTS = [
  'src/scripts/meetingsStagingSeed.ts',
  'src/scripts/meetingsStagingVerify.ts',
  'src/scripts/meetingsStagingCleanup.ts',
  'src/scripts/meetingsRollbackPreflight.ts',
] as const;

test('los cuatro scripts SALEN con error sin la declaración de entorno', () => {
  for (const script of SCRIPTS) {
    const result = runScript(script, [], {});
    assert.equal(result.status, 2, `${script} debe salir con 2: ${result.stderr}`);
    assert.match(result.stderr, /MEETINGS_ENV_KIND/, script);
    assert.equal(result.stdout, '', `${script} no debe imprimir nada en stdout al negarse`);
  }
});

test('y con una declaración que no es staging tampoco arrancan', () => {
  for (const script of SCRIPTS) {
    const result = runScript(script, [], { ...PROC_ENV, MEETINGS_ENV_KIND: 'production' });
    assert.equal(result.status, 2, `${script}: ${result.stderr}`);
  }
});

test('y sin el destino esperado declarado, tampoco', () => {
  // La segunda afirmación es obligatoria en los cuatro: declarar 'staging' no
  // dice a dónde apunta DATABASE_URL.
  for (const script of SCRIPTS) {
    for (const missing of ['MEETINGS_EXPECTED_DB_HOST', 'MEETINGS_EXPECTED_DB_NAME']) {
      const env: Record<string, string> = { ...PROC_ENV };
      delete env[missing];
      const result = runScript(script, [], env);
      assert.equal(result.status, 2, `${script} sin ${missing}: ${result.stderr}`);
      assert.match(result.stderr, new RegExp(missing), script);
    }
  }
});

test('y si DATABASE_URL no es el destino declarado, abortan sin conectar', () => {
  for (const script of SCRIPTS) {
    const result = runScript(script, ['--tenant-id', '11111111-2222-3333-4444-555555555555'], {
      ...PROC_ENV,
      MEETINGS_EXPECTED_DB_HOST: 'db.staging.example',
    });
    assert.equal(result.status, 2, `${script}: ${result.stderr}`);
    assert.match(result.stderr, /No se ha conectado/, script);
    // Y el mensaje no lleva la contraseña de la URL.
    assert.ok(!result.stderr.includes(':p@'), `${script} filtró la URL`);
  }
});

test('el cleanup se niega sin --tenant-id, incluso declarando staging', () => {
  const result = runScript('src/scripts/meetingsStagingCleanup.ts', [], {
    ...PROC_ENV,
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--tenant-id/);
});

test('el cleanup se niega con --execute y la frase equivocada, SIN tocar la base', () => {
  // La conexión apunta a un host que no existe. Si el script llegara a
  // conectar, el error sería de red; que salga con 2 y hable de --confirm
  // demuestra que se detuvo ANTES.
  const tenant = '11111111-2222-3333-4444-555555555555';
  for (const wrong of ['', 'BORRAR', 'borrar ' + tenant, 'BORRAR 99999999-2222-3333-4444-555555555555']) {
    const result = runScript(
      'src/scripts/meetingsStagingCleanup.ts',
      ['--tenant-id', tenant, '--execute', '--confirm', wrong],
      { ...PROC_ENV },
    );
    assert.equal(result.status, 2, `'${wrong}' no debe pasar: ${result.stderr}`);
    assert.match(result.stderr, /--confirm/, `'${wrong}'`);
    assert.match(result.stderr, /No se ha borrado nada/, `'${wrong}'`);
  }
});

test('--dry-run y --execute juntos se rechazan', () => {
  const result = runScript(
    'src/scripts/meetingsStagingCleanup.ts',
    ['--tenant-id', '11111111-2222-3333-4444-555555555555', '--dry-run', '--execute'],
    { ...PROC_ENV },
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /incompatibles/);
});

test('el seed se niega sin sus argumentos, antes de conectar', () => {
  const result = runScript('src/scripts/meetingsStagingSeed.ts', ['--tenant-name', 'X'], {
    ...PROC_ENV,
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Falta --/);
  assert.equal(result.stdout, '', 'no debe imprimir un token ni nada más');
});

test('el seed valida el slug del pool con el patrón de la base', () => {
  for (const slug of ['-empieza-con-guion', 'CON-MAYUSCULAS', 'a', 'con espacio']) {
    const result = runScript(
      'src/scripts/meetingsStagingSeed.ts',
      [
        '--tenant-name', 'X', '--client-name', 'Y',
        '--user-email', 'a@b.test', '--pool-slug', slug,
      ],
      { ...PROC_ENV },
    );
    assert.equal(result.status, 2, `'${slug}': ${result.stderr}`);
    assert.match(result.stderr, /pool-slug/, `'${slug}'`);
  }
});

test('el verify se niega sin --tenant-id', () => {
  const result = runScript('src/scripts/meetingsStagingVerify.ts', [], { ...PROC_ENV });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--tenant-id/);
});

test('el seed sólo admite --environment staging', () => {
  for (const environment of ['production', 'development', 'prod', 'w3']) {
    const result = runScript(
      'src/scripts/meetingsStagingSeed.ts',
      [
        '--tenant-name', 'X', '--client-name', 'Y',
        '--user-email', 'a@b.test', '--pool-slug', 'w3-gpu',
        '--environment', environment,
      ],
      { ...PROC_ENV },
    );
    assert.equal(result.status, 2, `'${environment}': ${result.stderr}`);
    assert.match(result.stderr, /sólo admite 'staging'/, `'${environment}'`);
    assert.equal(result.stdout, '', 'no debe imprimir token');
  }
});

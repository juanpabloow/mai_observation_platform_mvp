import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
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

/**
 * La lista es la lista: cada script nuevo de W-3 entra aquí. Antes decía «los
 * tres» y enumeraba tres; al añadir `meetingsStagingReprocess` la prueba
 * seguía verde sin haberlo mirado nunca, que es la forma más silenciosa de
 * perder una garantía.
 */
const W3_SCRIPTS = [
  'src/scripts/meetingsStagingSeed.ts',
  'src/scripts/meetingsStagingVerify.ts',
  'src/scripts/meetingsStagingCleanup.ts',
  'src/scripts/meetingsStagingReprocess.ts',
  'src/scripts/meetingsRollbackPreflight.ts',
];

test('la lista de scripts de W-3 está completa', () => {
  const declared = [...read('package.json').matchAll(/"w3:[a-z-]+": "tsx (src\/scripts\/[A-Za-z]+\.ts)"/g)]
    .map((match) => match[1]);
  for (const script of declared) {
    assert.ok(W3_SCRIPTS.includes(script), `${script} está en package.json y no en W3_SCRIPTS`);
  }
});

test('todos los scripts de W-3 exigen la puerta de staging', () => {
  for (const script of W3_SCRIPTS) {
    assert.match(read(script), /requireStagingEnvironment\(\)/, `${script} debe exigir la puerta`);
  }
  assert.match(read('test/e2e/w3HttpChecks.sh'), /MEETINGS_ENV_KIND/, 'el script HTTP también');
});

test('ningún script imprime DATABASE_URL', () => {
  for (const script of W3_SCRIPTS) {
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

test('el script HTTP separa el bloque sin cambios de dominio del mutante', () => {
  const source = read('test/e2e/w3HttpChecks.sh');
  const a = source.indexOf('BLOQUE A · enrutado — SIN CAMBIOS DE DOMINIO');
  const b = source.indexOf('BLOQUE B · sesión — MUTANTE DE DOMINIO');
  assert.ok(a > 0, 'debe existir el bloque A');
  assert.ok(b > a, 'el bloque B va después del A');
  // La creación de reuniones vive DESPUÉS de la separación.
  const create = source.indexOf('crear reunión con sesión');
  assert.ok(create > b, 'crear reuniones pertenece al bloque mutante');
});

test('el script HTTP exige W3_ALLOW_WRITES para crear reuniones', () => {
  const source = read('test/e2e/w3HttpChecks.sh');
  assert.match(source, /W3_ALLOW_WRITES/);
  // Y el bloque mutante está detrás del corte de las tres condiciones.
  const gate = source.indexOf('if [[ "$MUTATING_OK" != "1" ]]');
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

test('el bloque A NO se llama «no mutante»: touchLastUsed escribe', () => {
  const source = read('test/e2e/w3HttpChecks.sh');
  // `authenticateWorkerToken` dispara `UPDATE worker_credentials SET
  // last_used_at = now()`, así que «NO MUTANTE» era literalmente falso — y
  // falso en la dirección peligrosa: una afirmación de seguridad que no se
  // cumple es peor que no hacerla.
  const header = source.slice(0, source.indexOf('set -uo pipefail'));
  assert.ok(
    !/BLOQUE A[^\n]*NO MUTANTE/.test(header),
    'el bloque A no puede anunciarse como NO MUTANTE',
  );
  assert.match(header, /BLOQUE A[^\n]*SIN CAMBIOS DE DOMINIO/);
  // Y la telemetría se documenta con su nombre y su sentencia.
  assert.match(header, /touchLastUsed/);
  assert.match(header, /last_used_at/);
  assert.match(header, /no crea reuniones|No crea reuniones/);
});

test('y la telemetría NO se desactiva ni se rodea', () => {
  const source = read('test/e2e/w3HttpChecks.sh');
  // Un camino de autenticación distinto al de producción haría que el smoke
  // dejara de probar el camino real, que es su único motivo de existir.
  assert.ok(!/last_used_at\s*=/.test(source.replace(/#.*/g, '')), 'no debe escribir la columna');
  assert.ok(!/touchLastUsed\s*\(/.test(source.replace(/#.*/g, '')), 'no debe invocarla ni evitarla');
  // Y `authenticateWorkerToken` sigue disparándola: si alguien la quitara del
  // repositorio, este comentario del script quedaría obsoleto.
  assert.match(
    read('src/db/repositories/meetings/credentials.ts'),
    /void touchLastUsed\(matched\.id\)/,
    'la telemetría debe seguir en el camino real de autenticación',
  );
});

// ── El destino del token: MAI_BASE_URL, antes del primer curl ──────────────

test('el script HTTP exige W3_EXPECTED_MAI_HOST', () => {
  const source = read('test/e2e/w3HttpChecks.sh');
  assert.match(source, /W3_EXPECTED_MAI_HOST/);
  // Y va en la lista de obligatorias, no como opcional.
  assert.match(source, /for var in MAI_BASE_URL W3_CLIENT_ID W3_EXPECTED_MAI_HOST/);
});

test('la validación de MAI_BASE_URL corre ANTES del primer curl', () => {
  const source = read('test/e2e/w3HttpChecks.sh');
  const validation = source.indexOf('if ! MAI_HOST="$(url_check');
  const firstCurl = source.indexOf('curl -sS');
  assert.ok(validation > 0, 'debe existir la validación');
  assert.ok(firstCurl > validation, 'ningún curl antes de validar el destino');
});

test('la validación cubre host, https, userinfo y esquema', () => {
  const source = read('test/e2e/w3HttpChecks.sh');
  const check = source.slice(source.indexOf('url_check()'), source.indexOf('BASE="${MAI_BASE_URL%/}"'));
  assert.match(check, /parts\.username or parts\.password/, 'userinfo');
  assert.match(check, /scheme not in \{"http", "https"\}/, 'esquema');
  assert.match(check, /scheme != "https" and not local/, 'https salvo local');
  assert.match(check, /host != expected/, 'host declarado');
  // Y NUNCA imprime la URL completa: sólo el host y el problema.
  assert.ok(!/print\(f?"[^"]*\{raw\}/.test(check), 'no debe interpolar la URL cruda');
  assert.ok(!check.includes('{parts.netloc}'), 'netloc lleva el userinfo dentro');
});

test('el bloque mutante exige las TRES condiciones juntas', () => {
  const source = read('test/e2e/w3HttpChecks.sh');
  const gate = source.slice(source.indexOf('MUTATING_OK=1'), source.indexOf('crear reunión con sesión'));
  assert.match(gate, /MEETINGS_ENV_KIND.*staging/, 'entorno');
  assert.match(gate, /W3_EXPECTED_MAI_HOST/, 'host declarado');
  assert.match(gate, /W3_ALLOW_WRITES/, 'autorización de escritura');
  // Reafirmadas aquí aunque dos ya hayan cortado arriba: la precondición del
  // único bloque que escribe en el dominio no debe depender de que nadie mueva
  // un `exit` de las primeras treinta líneas.
  assert.match(gate, /if \[\[ "\$MUTATING_OK" != "1" \]\]/);
});

test('el script HTTP no sigue redirecciones', () => {
  const source = read('test/e2e/w3HttpChecks.sh');
  // Con `-L`, el 307 del middleware se convertiría en el 200 de /login y el
  // fallo de B-1 se vería como un éxito raro.
  assert.ok(!/curl[^\n]*\s-L\b/.test(source), 'ningún curl con -L');
});

// ── El preflight del rollback ──────────────────────────────────────────────

/** Las migraciones de Reuniones que hay EN EL DIRECTORIO, en orden de aplicación. */
function meetingsMigrationFiles(): string[] {
  return readdirSync(new URL('migrations/', REPO))
    .filter((name) => name.includes('meetings') && name.endsWith('.ts'))
    .map((name) => name.replace(/\.ts$/, ''))
    .sort();
}

test('la lista del preflight es EXACTAMENTE las migraciones de Reuniones del directorio', () => {
  // Antes esto comprobaba una lista escrita a mano contra otra lista escrita a mano, y
  // se cayó al añadir `speaker_uncertain` — sin haber detectado nada real. Lo que
  // importa es que la lista del script case con el directorio: si le falta una, el
  // `down` por conteo revierte de menos y deja el esquema a medias; si le sobra,
  // revierte una ajena. Se compara con el directorio, que es la fuente.
  const source = read('src/scripts/meetingsRollbackPreflight.ts');
  const listed = [...source.matchAll(/'(\d{13}_meetings-[a-z-]+)'/g)].map((match) => match[1]);
  const onDisk = meetingsMigrationFiles();

  assert.deepEqual(listed, onDisk, 'la lista del preflight y el directorio tienen que coincidir');
  assert.ok(onDisk.length >= 5, 'y no puede quedarse vacía por un regex que dejó de casar');
});

test('cada migración que nombra el preflight existe como fichero', () => {
  const source = read('src/scripts/meetingsRollbackPreflight.ts');
  const names = [...source.matchAll(/'(\d{13}_meetings-[a-z-]+)'/g)].map((match) => match[1]);
  for (const name of names) {
    assert.doesNotThrow(
      () => readFileSync(new URL(`migrations/${name}.ts`, REPO)),
      `migrations/${name}.ts no existe`,
    );
  }
});

test('el `down` del preflight se calcula, no se escribe a mano', () => {
  // La otra mitad del defecto original: un 5 literal en el mensaje seguiría diciendo
  // «down 5» después de añadir una sexta migración.
  const source = read('src/scripts/meetingsRollbackPreflight.ts');
  assert.ok(
    /down \$\{EXPECTED_STACK\.length\}/.test(source),
    'el comando impreso tiene que derivar del tamaño de la pila',
  );
  assert.ok(!/down \d+'/.test(source), 'y no llevar un número literal');
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

// ── El reproceso: lo que su código NO puede contener ────────────────────────

test('el reproceso nunca escribe attempts ni status de un job existente', () => {
  const source = read('src/scripts/meetingsStagingReprocess.ts');
  // El punto entero del mecanismo. Un `UPDATE ... SET attempts` o `SET status`
  // sobre `meeting_processing_jobs` borraría el registro del fallo, que es la
  // única prueba de que ocurrió.
  assert.ok(
    !/UPDATE\s+meeting_processing_(jobs|runs)/i.test(source),
    'ningún UPDATE sobre jobs ni sobre runs',
  );
  // Se busca la ASIGNACIÓN, no la mención: `attempts = 0` aparece en la
  // consulta de verificación posterior, donde es una comparación de lectura.
  // El primer intento de esta prueba buscaba la subcadena y fallaba por eso.
  assert.ok(
    !/\bSET\b[^;'`]*\b(attempts|status|failure_code|max_attempts)\s*=/i.test(source),
    'ninguna cláusula SET toca attempts, status, failure_code ni max_attempts',
  );
  // Y tampoco por la puerta de atrás del repositorio.
  for (const forbidden of ['markFailed', 'markSucceeded', 'requeueExpiredLeases', 'finishRun']) {
    assert.ok(!source.includes(forbidden), `no debe llamar a ${forbidden}`);
  }
  // Ni borrar nada: un reproceso añade.
  for (const verb of ['DELETE FROM', 'TRUNCATE']) {
    assert.ok(!source.includes(verb), `no debe contener '${verb}'`);
  }
});

test('el reproceso escribe siempre dentro de una transacción', () => {
  const source = read('src/scripts/meetingsStagingReprocess.ts');
  assert.match(source, /withTransaction\(/, 'la escritura va en transacción');
  // Y la comprobación que sólo el servidor puede responder, dentro de ella.
  const tx = source.slice(source.indexOf('withTransaction('));
  assert.match(tx, /assertConnectedDatabase\(executor\)/);
  // `applyReprocess` recibe el executor: si abriera su propia conexión, sus
  // escrituras quedarían fuera de la transacción del que la llama.
  assert.match(source, /export async function applyReprocess\([\s\S]*?executor: Queryable,\n\): Promise/);
});

test('el reproceso es dry-run por defecto', () => {
  const source = read('src/scripts/meetingsStagingReprocess.ts');
  assert.match(source, /execute = flags\.has\('execute'\)/);
  assert.match(source, /if \(!execute\) \{/, 'la rama sin escribir es la primera');
  assert.match(source, /--dry-run y --execute son incompatibles/);
});

test('el reproceso exige los tres uuids de identidad', () => {
  const source = read('src/scripts/meetingsStagingReprocess.ts');
  for (const flag of ['--tenant-id', '--client-id', '--meeting-id']) {
    assert.ok(
      source.includes(`requireUuid(values['${flag.slice(2)}'], '${flag}')`),
      `${flag} debe validarse como uuid`,
    );
  }
  // Y la reunión se lee acotada por los tres, no sólo por su id: leerla sólo
  // por `id` y comparar después dejaría una ventana en la que el script ya
  // tocó una fila de otro tenant.
  assert.match(source, /WHERE id = \$1 AND tenant_id = \$2 AND client_id = \$3/);
});

test('el reproceso conserva los avisos: concatena, no reemplaza', () => {
  const source = read('src/scripts/meetingsStagingReprocess.ts');
  // La única vía de escritura de `warnings` es `appendWarnings`, que en el
  // repositorio se traduce a `warnings || …::jsonb`.
  assert.match(source, /appendWarnings:/);
  assert.ok(!/warnings\s*=/.test(source), 'no debe asignar warnings directamente');
  assert.match(source, /hasWarningForRun\(plan\.warnings, run\.run_number\)/);
});

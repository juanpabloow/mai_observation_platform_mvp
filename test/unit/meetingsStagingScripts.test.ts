import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  ENV_KIND_VAR,
  REQUIRED_ENV_KIND,
  StagingGuardError,
  assertNoSecrets,
  describeDatabase,
  parseArgs,
  requireStagingEnvironment,
  requireUuid,
} from '../../src/scripts/stagingGuard.js';

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
  assert.throws(
    () => requireStagingEnvironment({ DATABASE_URL: 'postgres://u:p@h/db' }),
    (error: unknown) =>
      error instanceof StagingGuardError && error.message.includes(ENV_KIND_VAR),
  );
});

test('con una declaración que no es staging, tampoco', () => {
  for (const kind of ['production', 'prod', 'development', 'dev', 'x']) {
    assert.throws(
      () => requireStagingEnvironment({ [ENV_KIND_VAR]: kind, DATABASE_URL: 'postgres://u:p@h/db' }),
      StagingGuardError,
      `'${kind}' no debe pasar`,
    );
  }
});

test('NODE_ENV no sustituye a la declaración', () => {
  // Staging corre con NODE_ENV=production, que es el punto de que se parezca a
  // producción. Si la puerta mirara NODE_ENV, o bloquearía staging o abriría
  // producción.
  assert.throws(
    () =>
      requireStagingEnvironment({
        NODE_ENV: 'staging',
        DATABASE_URL: 'postgres://u:p@h/db',
      }),
    StagingGuardError,
  );
});

test('con la declaración correcta pasa, y devuelve host y base', () => {
  const description = requireStagingEnvironment({
    [ENV_KIND_VAR]: REQUIRED_ENV_KIND,
    DATABASE_URL: 'postgresql://usuario:contrasena@db.staging.example:5432/mai_staging',
  });
  assert.equal(description.host, 'db.staging.example:5432');
  assert.equal(description.database, 'mai_staging');
  assert.equal(description.local, false);
});

test('la declaración no basta sin DATABASE_URL', () => {
  assert.throws(
    () => requireStagingEnvironment({ [ENV_KIND_VAR]: REQUIRED_ENV_KIND }),
    StagingGuardError,
  );
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

const SCRIPTS = [
  'src/scripts/meetingsStagingSeed.ts',
  'src/scripts/meetingsStagingVerify.ts',
  'src/scripts/meetingsStagingCleanup.ts',
] as const;

test('los tres scripts SALEN con error sin la declaración de entorno', () => {
  for (const script of SCRIPTS) {
    const result = runScript(script, [], {});
    assert.equal(result.status, 2, `${script} debe salir con 2: ${result.stderr}`);
    assert.match(result.stderr, /MEETINGS_ENV_KIND/, script);
    assert.equal(result.stdout, '', `${script} no debe imprimir nada en stdout al negarse`);
  }
});

test('y con una declaración que no es staging tampoco arrancan', () => {
  for (const script of SCRIPTS) {
    const result = runScript(script, [], {
      MEETINGS_ENV_KIND: 'production',
      DATABASE_URL: 'postgresql://u:p@h/db',
    });
    assert.equal(result.status, 2, `${script}: ${result.stderr}`);
  }
});

test('el cleanup se niega sin --tenant-id, incluso declarando staging', () => {
  const result = runScript('src/scripts/meetingsStagingCleanup.ts', [], {
    MEETINGS_ENV_KIND: 'staging',
    DATABASE_URL: 'postgresql://u:p@h/db',
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
      {
        MEETINGS_ENV_KIND: 'staging',
        DATABASE_URL: 'postgresql://u:p@127.0.0.1:1/nada',
      },
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
    { MEETINGS_ENV_KIND: 'staging', DATABASE_URL: 'postgresql://u:p@127.0.0.1:1/nada' },
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /incompatibles/);
});

test('el seed se niega sin sus argumentos, antes de conectar', () => {
  const result = runScript('src/scripts/meetingsStagingSeed.ts', ['--tenant-name', 'X'], {
    MEETINGS_ENV_KIND: 'staging',
    DATABASE_URL: 'postgresql://u:p@127.0.0.1:1/nada',
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
      { MEETINGS_ENV_KIND: 'staging', DATABASE_URL: 'postgresql://u:p@127.0.0.1:1/nada' },
    );
    assert.equal(result.status, 2, `'${slug}': ${result.stderr}`);
    assert.match(result.stderr, /pool-slug/, `'${slug}'`);
  }
});

test('el verify se niega sin --tenant-id', () => {
  const result = runScript('src/scripts/meetingsStagingVerify.ts', [], {
    MEETINGS_ENV_KIND: 'staging',
    DATABASE_URL: 'postgresql://u:p@127.0.0.1:1/nada',
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--tenant-id/);
});

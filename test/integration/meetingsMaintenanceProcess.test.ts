import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { closeDb } from './fixtures.js';
import { FOREIGN_VARS, REQUIRED_VARS } from '../../src/meetings/maintenanceConfig.js';

/**
 * EL ARTEFACTO COMPILADO, ejecutado de verdad como proceso hijo.
 *
 * Lo que se prueba aquí no se puede probar leyendo el código: que
 * `node dist/maintenanceMain.js` arranca con SEIS variables y ninguna más.
 * El fallo que motivó esto era exactamente de esa clase — el proceso pedía
 * `ENCRYPTION_KEY` porque `db/client.ts` importaba la configuración de la
 * aplicación entera para leer un solo campo, y eso no se ve en ninguna prueba
 * unitaria: sólo al ejecutar el binario con el entorno del servicio.
 *
 * Se ejecuta el JS COMPILADO y no el TypeScript a propósito: Railway corre
 * `node dist/…`, y un `tsx` de por medio podría resolver imports de otra forma.
 *
 * ── Y se ejecuta desde un directorio SIN `.env` ───────────────────────────
 *
 * Esto no es un detalle. `runtimeEnv.ts` y `config.ts` llaman a `dotenv`, que
 * resuelve el fichero desde el directorio de trabajo. Con `cwd` en la raíz del
 * repositorio, dotenv inyectaba en el hijo TODO el `.env` local —incluido
 * `LOG_LEVEL=warn`, que silenciaba los `info` y dejaba la salida vacía, y
 * también `ENCRYPTION_KEY`—, así que la prueba afirmaba «arranca con seis
 * variables» mientras le pasaba treinta por la puerta de atrás.
 *
 * Con `cwd` en un directorio vacío, dotenv no encuentra nada y el entorno del
 * hijo es EXACTAMENTE el que se le pasa. Node resuelve `node_modules` desde la
 * ubicación del script, no desde `cwd`, así que los imports siguen funcionando.
 */

const raiz = fileURLToPath(new URL('../../', import.meta.url));
const ARTEFACTO = `${raiz}dist/maintenanceMain.js`;
/** Un directorio sin `.env`, para que dotenv no cuele nada en el hijo. */
let limpio = '';

before(() => {
  // El artefacto es el sujeto de la prueba: si no está, se compila.
  if (!existsSync(ARTEFACTO)) {
    const r = spawnSync('npm', ['run', 'build:worker'], { cwd: raiz, encoding: 'utf8' });
    assert.equal(r.status, 0, `no se pudo compilar:\n${r.stderr}`);
  }
  assert.ok(existsSync(ARTEFACTO), 'dist/maintenanceMain.js debe existir');
  limpio = mkdtempSync(`${tmpdir()}/mai-mant-`);
  assert.ok(!existsSync(`${limpio}/.env`), 'el directorio de ejecución no tiene .env');
});
after(async () => {
  if (limpio) rmSync(limpio, { recursive: true, force: true });
  await closeDb();
});

/** El entorno MÍNIMO del servicio: las seis y nada más. */
function entornoMinimo(): NodeJS.ProcessEnv {
  const db = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
  assert.ok(db, 'la prueba necesita una base local');
  return {
    PATH: process.env.PATH,
    NODE_ENV: 'production',
    DATABASE_URL: db,
    // La base real de la conexión de pruebas, para que la guarda la apruebe.
    MEETINGS_MAINTENANCE_EXPECTED_DB: new URL(db).pathname.replace(/^\//, ''),
    // El driver `fake` evita hablar con R2 de verdad, pero las cuatro variables
    // se declaran igual: lo que se prueba es que el proceso las EXIGE.
    MEETINGS_STORAGE_DRIVER: 'fake',
    MEETINGS_STORAGE_ENDPOINT: 'https://ejemplo.invalido',
    MEETINGS_STORAGE_BUCKET: 'bucket-de-prueba',
    MEETINGS_STORAGE_ACCESS_KEY_ID: 'id-de-prueba',
    MEETINGS_STORAGE_SECRET_ACCESS_KEY: 'secreto-de-prueba',
    MEETINGS_PURGE_INTERVAL_SECONDS: '3600',
  };
}

interface Ejecucion {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly out: string;
  /**
   * true = el proceso murió SIN que nadie le mandara una señal.
   *
   * Es el campo que faltaba, y su ausencia dejó pasar el defecto: la prueba
   * esperaba el log de arranque, mandaba SIGTERM y comprobaba `code === 0`.
   * El proceso ya había salido solo con 0 —el temporizador iba con `.unref()`
   * y nada retenía el bucle de eventos—, así que la aserción se cumplía
   * exactamente igual. Sin separar las dos cosas, «vive y se apaga limpio» y
   * «no vive» son indistinguibles.
   */
  readonly salioSolo: boolean;
  /** Si seguía vivo cuando se comprobó la permanencia. */
  readonly vivoAlComprobar: boolean | null;
}

/**
 * Arranca el artefacto y, si se le pide, comprueba que SIGUE VIVO antes de
 * mandarle la señal.
 *
 * `permanenciaMs` es lo que convierte esto en una prueba de vida: se espera a
 * los logs de arranque, se deja pasar ese tiempo y se mira si el proceso está
 * ahí. Sólo entonces se manda SIGTERM.
 */
async function ejecutar(
  env: NodeJS.ProcessEnv,
  opciones: { esperar?: RegExp; permanenciaMs?: number; timeoutMs?: number } = {},
): Promise<Ejecucion> {
  // `cwd` en el directorio limpio: ver la nota de arriba sobre dotenv.
  const hijo = spawn(process.execPath, [ARTEFACTO], { env, cwd: limpio });
  let out = '';
  hijo.stdout.on('data', (d) => { out += String(d); });
  hijo.stderr.on('data', (d) => { out += String(d); });

  let senalEnviada = false;
  let vivoAlComprobar: boolean | null = null;

  return await new Promise<Ejecucion>((resolve) => {
    const limite = setTimeout(() => { hijo.kill('SIGKILL'); }, opciones.timeoutMs ?? 40_000);
    let cerrado = false;
    const acabar = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (cerrado) return;
      cerrado = true;
      clearTimeout(limite);
      clearInterval(vigila);
      resolve({ code, signal, out, salioSolo: !senalEnviada, vivoAlComprobar });
    };

    const pedirApagado = (): void => {
      senalEnviada = true;
      hijo.kill('SIGTERM');
    };

    const vigila = setInterval(() => {
      if (senalEnviada || !opciones.esperar || !opciones.esperar.test(out)) return;
      clearInterval(vigila);
      if (opciones.permanenciaMs === undefined) { pedirApagado(); return; }
      // Los tres logs ya están. Se deja pasar el intervalo y se comprueba si el
      // proceso sobrevivió por su cuenta. Si murió, `exit` ya resolvió con
      // `salioSolo: true` y aquí no hay nada que matar.
      setTimeout(() => {
        vivoAlComprobar = hijo.exitCode === null && hijo.signalCode === null;
        if (vivoAlComprobar) pedirApagado();
      }, opciones.permanenciaMs);
    }, 100);

    hijo.on('exit', acabar);
  });
}

// ─────────────── El caso que arregla el defecto reportado ───────────────

test('arranca con SÓLO las seis variables, sin pedir ENCRYPTION_KEY', async () => {
  const r = await ejecutar(entornoMinimo(), { esperar: /barrido de eliminación en marcha/ });
  assert.equal(r.salioSolo, false, 'el proceso no debe terminar por su cuenta');

  // Lo que reportó Railway, palabra por palabra, no debe aparecer.
  assert.doesNotMatch(r.out, /ENCRYPTION_KEY/, 'no pide la clave de cifrado');
  assert.doesNotMatch(r.out, /Invalid environment configuration/, 'no pasa por config.ts');
  for (const ajena of FOREIGN_VARS) {
    assert.ok(!r.out.includes(ajena), `no debe mencionar ${ajena}`);
  }

  // Y arrancó de verdad: guarda superada y reloj en marcha.
  assert.match(r.out, /arrancando el servicio de mantenimiento/);
  assert.match(r.out, /base verificada contra lo declarado/);
  assert.match(r.out, /barrido de eliminación en marcha/);
  // Apagado limpio por SIGTERM.
  assert.match(r.out, /apagado completo/);
  assert.equal(r.code, 0, `debía salir con 0; salida:\n${r.out.slice(0, 600)}`);
});

test('no arranca la ingesta de n8n ni abre ningún puerto', async () => {
  const r = await ejecutar(entornoMinimo(), { esperar: /barrido de eliminación en marcha/ });
  assert.doesNotMatch(r.out, /polling worker started|ingestion/i, 'nada de n8n');
  assert.doesNotMatch(r.out, /listening|Listening|EADDRINUSE/, 'ningún servidor HTTP');
  assert.doesNotMatch(r.out, /loaded configuration/, 'ni el volcado de config del worker');
});

test('sólo registra el NOMBRE de la base, nunca la conexión', async () => {
  const env = entornoMinimo();
  const r = await ejecutar(env, { esperar: /barrido de eliminación en marcha/ });
  const url = new URL(env.DATABASE_URL!);
  assert.match(r.out, new RegExp(`"database":"${url.pathname.replace(/^\//, '')}"`));
  // Ni host, ni usuario, ni contraseña, ni la cadena entera.
  assert.ok(!r.out.includes(env.DATABASE_URL!), 'la cadena de conexión no sale');
  if (url.password) assert.ok(!r.out.includes(url.password), 'la contraseña no sale');
  if (url.username) assert.ok(!r.out.includes(`"${url.username}"`), 'el usuario no sale');
  assert.ok(!r.out.includes(url.hostname) || url.hostname === 'localhost', 'el host no sale');
  // Tampoco la clave del bucket.
  assert.ok(!r.out.includes('secreto-de-prueba'), 'la clave de R2 no sale');
});

// ─────────────────────── Pruebas NEGATIVAS ───────────────────────

test('sin DATABASE_URL aborta, y dice cuál falta', async () => {
  const env = entornoMinimo();
  delete env.DATABASE_URL;
  const r = await ejecutar(env, { timeoutMs: 20_000 });
  assert.equal(r.code, 1, 'debe salir con 1');
  assert.match(r.out, /DATABASE_URL/);
  assert.match(r.out, /NO arranca/);
  // Y no culpa a variables ajenas.
  assert.doesNotMatch(r.out, /ENCRYPTION_KEY/);
  assert.doesNotMatch(r.out, /barrido de eliminación en marcha/, 'no llegó a arrancar el reloj');
});

test('sin las credenciales de R2 aborta ANTES del primer ciclo', async () => {
  // Un servicio que arranca «sano» y a los cinco minutos avisa de que le falta
  // el bucket es un servicio que parece sano y no lo está.
  for (const falta of [
    'MEETINGS_STORAGE_ENDPOINT',
    'MEETINGS_STORAGE_BUCKET',
    'MEETINGS_STORAGE_ACCESS_KEY_ID',
    'MEETINGS_STORAGE_SECRET_ACCESS_KEY',
  ]) {
    const env = entornoMinimo();
    delete env[falta];
    const r = await ejecutar(env, { timeoutMs: 20_000 });
    assert.equal(r.code, 1, `sin ${falta} debe salir con 1`);
    assert.ok(r.out.includes(falta), `debe nombrar ${falta}`);
    assert.doesNotMatch(r.out, /barrido de eliminación en marcha/);
    assert.doesNotMatch(r.out, /ENCRYPTION_KEY/);
  }
});

test('sin declarar la base esperada aborta: es un proceso que borra', async () => {
  const env = entornoMinimo();
  delete env.MEETINGS_MAINTENANCE_EXPECTED_DB;
  const r = await ejecutar(env, { timeoutMs: 20_000 });
  assert.equal(r.code, 1);
  assert.match(r.out, /MEETINGS_MAINTENANCE_EXPECTED_DB/);
});

test('con la base EQUIVOCADA declarada, la guarda lo para', async () => {
  // El accidente concreto: la referencia por defecto de Railway apunta a
  // `railway`, no a la base de W-3.
  const env = entornoMinimo();
  env.MEETINGS_MAINTENANCE_EXPECTED_DB = 'railway';
  const r = await ejecutar(env, { timeoutMs: 20_000 });
  assert.equal(r.code, 1);
  assert.match(r.out, /NO arranca/);
  assert.match(r.out, /'railway'/);
  assert.doesNotMatch(r.out, /barrido de eliminación en marcha/, 'ni un ciclo contra la base ajena');
});

test('las seis obligatorias son exactamente las que el servicio declara', () => {
  assert.deepEqual([...REQUIRED_VARS], [
    'DATABASE_URL',
    'MEETINGS_MAINTENANCE_EXPECTED_DB',
    'MEETINGS_STORAGE_ENDPOINT',
    'MEETINGS_STORAGE_BUCKET',
    'MEETINGS_STORAGE_ACCESS_KEY_ID',
    'MEETINGS_STORAGE_SECRET_ACCESS_KEY',
  ]);
  assert.ok(FOREIGN_VARS.includes('ENCRYPTION_KEY'));
  assert.ok(FOREIGN_VARS.includes('OPENAI_API_KEY'));
});

// ─────────────── La vida del proceso, que es lo que faltaba ───────────────

test('SIGUE VIVO tras los tres logs de arranque, y muere limpio con SIGTERM', async () => {
  /*
    Éste es el defecto que se colaba. El temporizador del barrido lleva
    `.unref()`, así que tras resolverse `main()` no quedaba nada reteniendo el
    bucle de eventos: Node salía con código 0 y Railway marcaba el despliegue
    `Completed` justo después de escribir «barrido de eliminación en marcha».
    El servicio nunca llegaba al primer ciclo de cinco minutos.

    La prueba anterior no podía verlo: esperaba el log, mandaba SIGTERM y
    comprobaba `code === 0`. El proceso ya había salido solo con 0 y la
    aserción se cumplía igual. De ahí `salioSolo` y `vivoAlComprobar`.
  */
  const r = await ejecutar(entornoMinimo(), {
    esperar: /barrido de eliminación en marcha/,
    /*
      14 s, y el número importa: por encima del `idleTimeoutMillis` de `pg`,
      que por defecto son 10 000 ms.

      Con 4 s la prueba pasaba incluso quitando el pestillo, y lo comprobé
      quitándolo. El motivo es que el pool de PostgreSQL mantiene vivo el bucle
      de eventos mientras conserva un socket abierto: la guarda de arranque hace
      una consulta, el cliente queda ocioso, y hasta que `pg` lo cierra a los
      10 s el proceso parece sano sin que nada lo retenga de verdad. Por debajo
      de ese umbral, «vive» y «todavía no ha muerto» son indistinguibles.
    */
    permanenciaMs: 14_000,
    timeoutMs: 60_000,
  });

  // Los TRES logs de arranque, en orden.
  const iArranca = r.out.indexOf('arrancando el servicio de mantenimiento');
  const iBase = r.out.indexOf('base verificada contra lo declarado');
  const iReloj = r.out.indexOf('barrido de eliminación en marcha');
  assert.ok(iArranca >= 0, 'log 1: arranque');
  assert.ok(iBase > iArranca, 'log 2: base verificada, después del arranque');
  assert.ok(iReloj > iBase, 'log 3: reloj en marcha, después de la verificación');

  // LA ASERCIÓN QUE IMPORTA.
  assert.equal(r.vivoAlComprobar, true, 'seguía vivo 4 s después de arrancar');
  assert.equal(r.salioSolo, false, 'no terminó por su cuenta: lo terminó el SIGTERM');

  // Y el apagado fue limpio, en orden y con código 0.
  const iApaga = r.out.indexOf('apagando el mantenimiento');
  const iPool = r.out.indexOf('postgres pool closed');
  const iFin = r.out.indexOf('apagado completo');
  assert.ok(iApaga > iReloj, 'el apagado empieza tras la señal');
  assert.ok(iPool > iApaga, 'se cierra el pool de PostgreSQL');
  assert.ok(iFin > iPool, 'y se anuncia el final después');
  assert.equal(r.code, 0, 'salida 0 ante SIGTERM');
  assert.equal(r.signal, null, 'terminó por su cuenta tras la señal, no lo mató el kernel');
});

test('SIGINT también apaga limpio y sale 0', async () => {
  const hijo = spawn(process.execPath, [ARTEFACTO], { env: entornoMinimo(), cwd: limpio });
  let out = '';
  hijo.stdout.on('data', (d) => { out += String(d); });
  hijo.stderr.on('data', (d) => { out += String(d); });
  const fin = new Promise<{ code: number | null; señalado: boolean }>((resolve) => {
    let señalado = false;
    const t = setInterval(() => {
      if (!/barrido de eliminación en marcha/.test(out)) return;
      clearInterval(t);
      // Mismo umbral que la prueba de SIGTERM, y por el mismo motivo: el pool
      // de `pg` sostiene el proceso durante sus primeros 10 s de ocio.
      setTimeout(() => {
        señalado = hijo.exitCode === null;
        if (señalado) hijo.kill('SIGINT');
      }, 14_000);
    }, 100);
    hijo.on('exit', (code) => { clearInterval(t); resolve({ code, señalado }); });
    setTimeout(() => hijo.kill('SIGKILL'), 60_000);
  });
  const r = await fin;
  assert.equal(r.señalado, true, 'seguía vivo cuando se mandó SIGINT');
  assert.match(out, /"signal":"SIGINT"/);
  assert.match(out, /apagado completo/);
  assert.equal(r.code, 0);
});

test('un fallo fatal sale con código distinto de 0', async () => {
  // La otra mitad del requisito: apagado limpio = 0, fallo = no 0. Se provoca
  // con la guarda de base, que es un fallo fatal real y no un simulacro.
  const env = entornoMinimo();
  env.MEETINGS_MAINTENANCE_EXPECTED_DB = 'base_que_no_es';
  const r = await ejecutar(env, { timeoutMs: 25_000 });
  assert.notEqual(r.code, 0, 'un fallo fatal no puede salir con 0');
  assert.equal(r.code, 1);
  assert.doesNotMatch(r.out, /barrido de eliminación en marcha/);
});

test('el pestillo es del entrypoint: el planificador conserva su `.unref()`', () => {
  // Se arregla en el entrypoint y no quitando el `unref` del planificador,
  // porque ése es reutilizable: quien lo hospede decide si debe mantenerlo
  // vivo. Un servicio exclusivo no debe depender de esa decisión ajena.
  const plan = readFileSync(`${raiz}src/meetings/maintenance.ts`, 'utf8');
  assert.match(plan, /unref\?\.\(\)/, 'el planificador sigue sin retener el proceso');
  const main = readFileSync(`${raiz}src/maintenanceMain.ts`, 'utf8');
  assert.match(main, /const pestillo = setInterval/, 'la vida la sostiene el entrypoint');
  assert.match(main, /clearInterval\(pestillo\)/, 'y la suelta al apagar');
  // Sin puerto, sigue siendo cierto.
  assert.doesNotMatch(
    main.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''),
    /\blisten\(|createServer|express/i,
  );
});

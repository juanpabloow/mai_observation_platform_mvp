import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  checkDatabaseName,
  EXPECTED_DB_VAR,
  MaintenanceGuardError,
} from '../../src/meetings/maintenanceGuard.js';

/**
 * El servicio de mantenimiento: su entrypoint exclusivo y su guarda de base.
 *
 * Lo que se protege aquí es un fallo con consecuencias asimétricas. La
 * `DATABASE_URL` por defecto de un proyecto de Railway apunta a la base
 * `railway`, no a `mai_w3_staging`, y este proceso borra filas y objetos: un
 * ciclo contra la base equivocada ya habría vaciado prefijos de R2 antes de que
 * nadie se diera cuenta.
 */

// ─────────────────────────── La guarda de base ───────────────────────────

test('la base declarada y la real coinciden: arranca', () => {
  const r = checkDatabaseName('mai_w3_staging', 'mai_w3_staging');
  assert.equal(r.database, 'mai_w3_staging');
  assert.equal(r.verified, true);
});

test('la base por defecto de Railway NO cuela', () => {
  // Éste es el accidente concreto: la referencia por defecto apunta a `railway`.
  const e = (() => { try { checkDatabaseName('railway', 'mai_w3_staging'); return null; } catch (x) { return x; } })();
  assert.ok(e instanceof MaintenanceGuardError, 'debe abortar');
  assert.match(e.message, /NO arranca/);
  assert.match(e.message, /'railway'/, 'dice a qué base está conectado');
  assert.match(e.message, /'mai_w3_staging'/, 'y a cuál debería');
  // El mensaje no lleva host, usuario ni URL: sólo nombres de base.
  assert.doesNotMatch(e.message, /postgres:\/\/|@|:\d{4}/);
});

test('sin declaración se AVISA y se sigue: no se acopla a un entorno', () => {
  // Acoplar el binario a «staging» obligaría a cambiar código para desplegarlo
  // en producción. Y abortar sin la variable dejaría el servicio muerto en
  // cualquier entorno nuevo, que es peor que no comprobarlo.
  for (const sin of [undefined, '', '   ']) {
    const r = checkDatabaseName('otra_base', sin);
    assert.equal(r.verified, false);
    assert.equal(r.database, 'otra_base', 'el nombre real queda para el registro');
  }
});

test('la comparación no distingue mayúsculas, que es como las trata PostgreSQL', () => {
  assert.equal(checkDatabaseName('MAI_W3_STAGING', 'mai_w3_staging').verified, true);
  assert.equal(checkDatabaseName('mai_w3_staging', '  MAI_W3_Staging  ').verified, true);
});

test('el nombre de la variable es estable: lo escribe quien crea el servicio', () => {
  assert.equal(EXPECTED_DB_VAR, 'MEETINGS_MAINTENANCE_EXPECTED_DB');
});

// ───────────────────────── El entrypoint exclusivo ─────────────────────────

const raiz = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');
const sinComentarios = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('el entrypoint arranca SÓLO el mantenimiento', () => {
  const m = sinComentarios(raiz('src/maintenanceMain.ts'));
  assert.match(m, /startMeetingsMaintenance\(\)/);
  assert.doesNotMatch(m, /startWorker/, 'ni la ingesta de n8n');
  // Ni servidor HTTP: nada de listen, express, http o Next.
  assert.doesNotMatch(m, /\blisten\(|createServer|express|next\b/i);
});

test('la guarda corre ANTES del primer ciclo', () => {
  const m = sinComentarios(raiz('src/maintenanceMain.ts'));
  const iGuarda = m.indexOf('assertMaintenanceDatabase');
  const iArranque = m.indexOf('startMeetingsMaintenance()');
  assert.ok(iGuarda > 0 && iArranque > iGuarda,
    'un ciclo contra la base equivocada ya habría vaciado prefijos');
});

test('sólo se registra el NOMBRE de la base', () => {
  const m = raiz('src/maintenanceMain.ts');
  assert.match(m, /database: guard\.database/);
  assert.doesNotMatch(sinComentarios(m), /DATABASE_URL|connectionString|\bhost\b|\buser\b/);
});

test('la ingesta ya NO arranca el mantenimiento', () => {
  const i = sinComentarios(raiz('src/index.ts'));
  assert.match(i, /startWorker\(\)/, 'sigue siendo el proceso de la ingesta');
  assert.doesNotMatch(i, /startMeetingsMaintenance/, 'que ahora vive en su propio servicio');
  assert.doesNotMatch(i, /stopMeetingsMaintenance/);
});

test('el servicio está declarado: un script y una config propios', () => {
  const pkg = JSON.parse(raiz('package.json')) as { scripts: Record<string, string> };
  assert.equal(pkg.scripts['start:maintenance'], 'node dist/maintenanceMain.js');
  // Sin tsx ni watch en producción, igual que el resto.
  assert.doesNotMatch(pkg.scripts['start:maintenance'], /tsx|watch|ts-node/);

  const cfg = JSON.parse(raiz('railway.maintenance.json')) as {
    deploy: { startCommand: string; numReplicas: number; restartPolicyType: string };
  };
  assert.equal(cfg.deploy.startCommand, 'npm run start:maintenance');
  assert.equal(cfg.deploy.numReplicas, 1, 'UNA réplica');
  assert.equal(cfg.deploy.restartPolicyType, 'ON_FAILURE');

  // Y no se confunde con el worker de la ingesta.
  const worker = JSON.parse(raiz('railway.worker.json')) as { deploy: { startCommand: string } };
  assert.equal(worker.deploy.startCommand, 'npm run start:worker', 'intacto');
  assert.notEqual(cfg.deploy.startCommand, worker.deploy.startCommand);
});

// ──────────────── El registro de la limpieza (found/deleted/remaining) ────────────────

test('el barrido registra encontrados, eliminados y restantes', () => {
  const m = raiz('src/meetings/maintenance.ts');
  for (const campo of ['found: r.objectsFound', 'deleted: r.objectsDeleted', 'remaining: r.objectsRemaining']) {
    assert.ok(m.includes(campo), `falta ${campo}`);
  }
  // Nada de credenciales, claves ni contenido.
  assert.doesNotMatch(sinComentarios(m), /storageKey|storage_key|signedUrl|payload|title/);
});

test('el DELETE de PostgreSQL exige remaining === 0, explícitamente', () => {
  const d = sinComentarios(raiz('src/meetings/deletion.ts'));
  const iGuarda = d.indexOf('restantes !== 0');
  const iDelete = d.indexOf('deleteMeetingRow(row.id)');
  assert.ok(iGuarda > 0, 'la condición está escrita, no sólo implícita');
  assert.ok(iDelete > iGuarda, 'y va ANTES del borrado');
  assert.match(d, /verification_missing/, 'con su propio código de fallo');
});

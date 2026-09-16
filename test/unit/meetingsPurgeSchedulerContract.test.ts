import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Contrato del PROCESO PERIÓDICO que termina las eliminaciones.
 *
 * Existe porque el fallo que guarda no es un bug de lógica sino una ausencia:
 * un endpoint que nadie llama. `requeue-expired` lleva desde T-3 sin más
 * invocación que un `curl` del runbook, y nada en el repositorio lo delataba.
 * Estas aserciones fallan si alguien desengancha el barrido del proceso
 * permanente o lo mueve al servicio web.
 */

const raiz = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');
const sinComentarios = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('el barrido tiene su PROPIO proceso, ni el web ni el de la ingesta', () => {
  /*
    Esta aserción decía lo contrario: que el barrido colgaba de `src/index.ts`,
    el proceso de la ingesta de n8n. Era cierto cuando se escribió, y dejó de
    serlo a propósito — el proyecto donde esto se despliega no tiene servicio de
    ingesta, así que apuntar el mantenimiento a ese binario habría puesto a
    sondear n8n a un proceso cuyo único trabajo es vaciar prefijos de R2.
  */
  const main = sinComentarios(raiz('src/maintenanceMain.ts'));
  assert.match(main, /startMeetingsMaintenance\(\)/, 'arranca en su entrypoint');
  assert.match(main, /stopMeetingsMaintenance\(\)/, 'y se detiene con él');
  assert.doesNotMatch(main, /startWorker/, 'sin la ingesta de n8n');

  const index = sinComentarios(raiz('src/index.ts'));
  assert.doesNotMatch(index, /MeetingsMaintenance/, 'la ingesta ya no lo arranca');

  const pkg = JSON.parse(raiz('package.json')) as { scripts: Record<string, string> };
  assert.equal(pkg.scripts['start:maintenance'], 'node dist/maintenanceMain.js');
  const cfg = JSON.parse(raiz('railway.maintenance.json')) as {
    deploy: { startCommand: string; numReplicas: number };
  };
  assert.equal(cfg.deploy.startCommand, 'npm run start:maintenance');
  assert.equal(cfg.deploy.numReplicas, 1);

  // Y el worker de la ingesta queda INTACTO.
  const worker = JSON.parse(raiz('railway.worker.json')) as { deploy: { startCommand: string } };
  assert.equal(worker.deploy.startCommand, 'npm run start:worker');
  assert.equal(pkg.scripts['start:worker'], 'node dist/index.js');
});

test('el camino automático no usa HTTP, ni cookie, ni token', () => {
  const src = sinComentarios(raiz('src/meetings/maintenance.ts'));
  assert.doesNotMatch(src, /fetch\(|axios|Authorization|cookie/i,
    'en proceso se llama a la función: ninguna credencial viaja');
});

test('la ruta manual ejecuta EXACTAMENTE la misma función que el reloj', () => {
  const ruta = sinComentarios(
    readFileSync(
      fileURLToPath(new URL('../../web/app/api/meetings/v1/maintenance/purge-deleted/route.ts', import.meta.url)),
      'utf8',
    ),
  );
  assert.match(ruta, /runPurgeCycle\(\)/, 'la puerta manual y el reloj no pueden divergir');
  // Y sigue exigiendo identidad interna: nunca una sesión de navegador.
  assert.match(ruta, /authenticateWorker\(request\)/);
  assert.match(ruta, /identity\.scope !== 'internal'/);
  assert.match(ruta, /meetings\.maintenance/);
  assert.doesNotMatch(ruta, /resolveAppScope|cookie/i, 'nada de sesión de usuario');
});

test('una pasada nunca lanza: una excepción en un setInterval tumba el proceso', () => {
  const src = sinComentarios(raiz('src/meetings/maintenance.ts'));
  assert.match(src, /catch \(err\)/);
  assert.match(src, /finally \{\s*enCurso = false;/);
});

test('el intervalo y el tamaño de lote están definidos y son configurables', () => {
  const src = raiz('src/meetings/maintenance.ts');
  assert.match(src, /DEFAULT_PURGE_INTERVAL_SECONDS = 300/);
  assert.match(src, /MEETINGS_PURGE_INTERVAL_SECONDS/);
  assert.match(src, /MEETINGS_PURGE_BATCH/);
});

test('dos ejecuciones concurrentes no corrompen: el lease vive en SQL', () => {
  const repo = raiz('src/db/repositories/meetings/deletion.ts');
  assert.match(repo, /FOR UPDATE SKIP LOCKED/);
  assert.match(repo, /purge_lease_until/);
  // La guarda en memoria es una cortesía, y el comentario lo dice para que
  // nadie la confunda con la defensa.
  const src = raiz('src/meetings/maintenance.ts');
  assert.match(src, /Cortesía, no corrección/);
});

test('el automático se rinde tras un tope, pero deja la reunión reintentable', () => {
  const repo = raiz('src/db/repositories/meetings/deletion.ts');
  assert.match(repo, /MAX_PURGE_ATTEMPTS = 5/);
  assert.match(repo, /AND deletion_attempts < \$3/, 'el claim respeta el tope');
  assert.match(repo, /deletion_attempts = 0/, 'y un reintento humano lo devuelve a cero');
});

test('sin bucket configurado se abstiene en vez de borrar filas', () => {
  const src = raiz('src/meetings/maintenance.ts');
  assert.match(src, /storage_not_configured/);
  // Borrar la fila sin vaciar el prefijo es el único fallo irreversible de
  // todo esto: deja el audio huérfano y sin nada que lo mencione.
  assert.match(src, /huérfano/);
});

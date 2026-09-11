import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  errorDeRed,
  HANDOFF_KEY,
  leerRespuesta,
  TOAST_ELIMINADA,
  trasAceptar,
} from '../../web/lib/meetingsDeletionFlow.js';

/**
 * El cierre de «Eliminar reunión»: qué ve el usuario cuando el servidor acepta
 * el borrado, y qué ve cuando la petición no llega a ser aceptada.
 *
 * Las decisiones se PRUEBAN, no se afirman sobre el código: viven en
 * `web/lib/meetingsDeletionFlow.ts` como funciones puras precisamente para que
 * estas pruebas las ejecuten. Lo que queda en forma de contrato de fuente es
 * sólo el cableado —qué superficie declara cada página, dónde se filtra la
 * fila— que no se puede ejecutar sin renderizar React.
 */

const raiz = new URL('../../', import.meta.url);
const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, raiz)), 'utf8');
const sinComentarios = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const DELETION = 'web/components/reuniones/MeetingDeletion.tsx';
const TABLE = 'web/components/reuniones/MeetingsTable.tsx';
const LISTADO = 'web/app/clients/[clientId]/reuniones/page.tsx';
const FICHA = 'web/app/clients/[clientId]/reuniones/[meetingId]/page.tsx';
const REPO = 'src/db/repositories/meetings/meetings.ts';

const CLIENTE = '22222222-2222-4222-8222-222222222222';

// ───────────────────────── 1 · El listado ────────────────────────────────

test('listado: la fila se retira al instante y se queda donde está', () => {
  const plan = trasAceptar('list', CLIENTE);
  assert.equal(plan.retirarDelListado, true, 'la fila se va del estado visual ya');
  assert.equal(plan.redirigirA, null, 'y no se navega a ningún sitio');
  assert.equal(plan.toast, 'Reunión eliminada');
});

// ───────────────────────── 2 · La ficha ──────────────────────────────────

test('ficha: se redirige al listado del cliente, no a una ruta inventada', () => {
  const plan = trasAceptar('detail', CLIENTE);
  assert.equal(plan.redirigirA, `/clients/${CLIENTE}/reuniones`);
  // No hay fila que retirar: lo eliminado es lo que se está mirando.
  assert.equal(plan.retirarDelListado, false);
});

test('las dos superficies muestran EL MISMO toast', () => {
  assert.equal(trasAceptar('list', CLIENTE).toast, trasAceptar('detail', CLIENTE).toast);
  assert.equal(trasAceptar('detail', CLIENTE).toast, TOAST_ELIMINADA);
});

// ─────────────── 3 · La petición que no llega a ser aceptada ─────────────

test('ningún estado de error se considera aceptado', () => {
  for (const status of [400, 401, 403, 404, 409, 422, 429, 500, 502, 503]) {
    const r = leerRespuesta(status, null);
    assert.equal(r.aceptada, false, `${status} no es una aceptación`);
    assert.ok(r.error && r.error.trim().length > 0, `${status} explica qué pasó`);
    // Y no puede decir que se eliminó algo que no se eliminó.
    assert.doesNotMatch(r.error, /eliminada/i, `${status} no anuncia un borrado`);
  }
});

test('una petición que no vuelve tampoco retira nada', () => {
  const r = errorDeRed();
  assert.equal(r.aceptada, false);
  assert.match(r.error!, /Vuelve a intentarlo/, 'e invita a reintentar');
});

test('los errores invitan a reintentar, que es lo que el botón permite', () => {
  // 403 es la excepción razonable: reintentar no arregla un permiso, así que
  // el texto explica en vez de prometer.
  assert.match(leerRespuesta(500, null).error!, /Vuelve a intentarlo/);
  assert.match(leerRespuesta(404, null).error!, /Recarga/);
  assert.match(leerRespuesta(403, null).error!, /permisos/);
});

test('cuando el servidor tiene algo concreto que decir, se dice', () => {
  assert.equal(leerRespuesta(409, 'La reunión está siendo procesada.').error, 'La reunión está siendo procesada.');
  // Un cuerpo vacío o en blanco no deja al usuario sin mensaje.
  assert.match(leerRespuesta(409, '   ').error!, /No se pudo eliminar la reunión/);
  assert.match(leerRespuesta(409, null).error!, /No se pudo eliminar la reunión/);
});

test('202 es aceptación, y cualquier 2xx también', () => {
  for (const status of [200, 202, 204]) {
    const r = leerRespuesta(status, null);
    assert.equal(r.aceptada, true, `${status} acepta`);
    assert.equal(r.error, null);
  }
});

// ──────────────── El cableado: qué superficie es cada página ─────────────

test('la ficha declara detail y el listado declara list', () => {
  assert.match(sinComentarios(read(FICHA)), /surface="detail"/, 'la ficha redirige');
  assert.match(sinComentarios(read(LISTADO)), /surface="list"/, 'el listado retira la fila');
});

test('el diálogo sólo avisa de la aceptación DESPUÉS de comprobarla', () => {
  const src = sinComentarios(read(DELETION));
  const guardia = src.indexOf('if (!resultado.aceptada)');
  const aviso = src.indexOf('onAceptada?.(');
  assert.ok(guardia > 0, 'existe la guardia de aceptación');
  assert.ok(aviso > guardia, 'retirar la fila ocurre después de saber que se aceptó');
  // Y la rama de fallo sale sin tocar nada más.
  assert.match(src, /setEnVuelo\(false\);\s*\n\s*return;/);
});

test('el listado retira la fila del ESTADO VISUAL, no espera al servidor', () => {
  const src = sinComentarios(read(TABLE));
  assert.match(src, /estaRetirada/, 'la tabla consulta qué reuniones ya se fueron');
  assert.match(src, /meetings\.filter\(\(m\) => !estaRetirada\(m\.id\)\)/);
  assert.match(src, /visibles\.map\(/, 'y pinta las visibles, no la prop cruda');
});

test('el aviso de la ficha sobrevive a la redirección', () => {
  const src = sinComentarios(read(DELETION));
  const escribe = src.indexOf('sessionStorage.setItem(HANDOFF_KEY');
  const navega = src.indexOf('router.replace(');
  assert.ok(escribe > 0 && navega > escribe, 'se deja el relevo ANTES de navegar');
  // Y el listado lo consume una sola vez: una recarga no reanuncia un borrado
  // de hace media hora.
  assert.match(src, /sessionStorage\.getItem\(HANDOFF_KEY\)/);
  assert.match(src, /sessionStorage\.removeItem\(HANDOFF_KEY\)/);
  assert.ok(HANDOFF_KEY.length > 0);
});

test('«atrás» no devuelve a la ficha de una reunión eliminada', () => {
  const src = sinComentarios(read(DELETION));
  assert.match(src, /router\.replace\(plan\.redirigirA\)/);
  assert.doesNotMatch(src, /router\.push\(/, 'push dejaría un 404 en el historial');
});

// ──────────────── 4 · La recarga: sólo se leen las vivas ────────────────

test('las dos lecturas de la pantalla filtran deletion_state = live', () => {
  const src = sinComentarios(read(REPO));
  assert.match(src, /m\.deletion_state = 'live'/, 'el filtro existe');

  // En las DOS: el listado y la fila del detalle. Si sólo estuviera en una, la
  // reunión desaparecería del listado y seguiría abriéndose por URL.
  const listado = src.slice(src.indexOf('export async function listMeetingsForClient'));
  assert.match(listado.slice(0, 600), /\$\{SOLO_VIVAS\}/, 'listMeetingsForClient lo aplica');

  const fila = src.slice(src.indexOf('export async function getMeetingListRowScoped'));
  assert.match(fila.slice(0, 600), /\$\{SOLO_VIVAS\}/, 'getMeetingListRowScoped lo aplica');
});

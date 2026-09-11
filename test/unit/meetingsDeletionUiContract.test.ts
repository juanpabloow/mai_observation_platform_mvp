import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Contrato a nivel de fuente de «Eliminar reunión» en la interfaz.
 *
 * Misma técnica que el resto de contratos de pantalla de este repositorio (sin
 * HTTP, sin DB, sin render de React): son componentes de cliente y páginas
 * `server-only` que el runner de la raíz no puede invocar.
 *
 * Lo que guarda es lo que un rediseño puede romper en silencio: que la ficha y
 * el listado abran EL MISMO diálogo y llamen a LA MISMA operación, que el
 * nombre siga siendo «Eliminar reunión» —porque también se va el audio—, que un
 * `member` no vea la acción, y que el navegador no tenga dónde proponer una
 * clave de almacenamiento.
 */

const web = fileURLToPath(new URL('../../web/', import.meta.url));
const read = (rel: string): string => readFileSync(`${web}${rel}`, 'utf8');
const sinComentarios = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const DELETION = 'components/reuniones/MeetingDeletion.tsx';
const TABLE = 'components/reuniones/MeetingsTable.tsx';
const WORKSPACE = 'components/reuniones/MeetingWorkspace.tsx';
const LISTADO = 'app/clients/[clientId]/reuniones/page.tsx';
const FICHA = 'app/clients/[clientId]/reuniones/[meetingId]/page.tsx';
const RUTA = 'app/api/meetings/v1/meetings/[meetingId]/delete/route.ts';

// ───────────────── El mismo diálogo y la misma operación ─────────────────

test('el diálogo de eliminación está definido UNA sola vez en todo web/', () => {
  const definiciones = [DELETION, TABLE, WORKSPACE, LISTADO, FICHA]
    .map((f) => sinComentarios(read(f)))
    .filter((src) => /function DeleteMeetingDialog\b/.test(src));
  assert.equal(definiciones.length, 1, 'dos diálogos divergen a la primera corrección');
});

test('la ficha y el listado montan el MISMO proveedor, que renderiza el único diálogo', () => {
  for (const page of [LISTADO, FICHA]) {
    const src = sinComentarios(read(page));
    assert.match(src, /<MeetingDeletionProvider/, `${page} monta el proveedor`);
    assert.match(src, /from "@\/components\/reuniones\/MeetingDeletion"/, `${page} lo importa del mismo módulo`);
  }
  const prov = sinComentarios(read(DELETION));
  // Una sola instancia del diálogo, la del proveedor.
  assert.equal(
    (prov.match(/<DeleteMeetingDialog/g) ?? []).length, 1,
    'el proveedor renderiza exactamente una instancia',
  );
  assert.match(prov, /pendiente \?/, 'y sólo cuando hay una reunión pendiente');
});

test('los dos menús son el MISMO componente', () => {
  for (const f of [TABLE, WORKSPACE]) {
    const src = sinComentarios(read(f));
    assert.match(src, /<MeetingActionsMenu/, `${f} usa el menú compartido`);
    assert.match(src, /from "@\/components\/reuniones\/MeetingDeletion"/, `${f} lo importa del módulo común`);
    // Y ya NO tiene su propio botón de tres puntos suelto.
    assert.doesNotMatch(
      src, /aria-label=\{?`?Más acciones[^}]*`?\}?\s*\n\s*className/,
      `${f} no debe conservar un botón de tres puntos propio`,
    );
  }
});

test('sólo hay UNA llamada al endpoint de eliminación en toda la interfaz', () => {
  const src = sinComentarios(read(DELETION));
  const llamadas = (src.match(/\/delete`/g) ?? []).length;
  assert.equal(llamadas, 1, 'los dos menús no «hacen lo mismo»: hacen ESTO');
  assert.match(src, /method: "POST"/);
});

// ───────────────────────────── El nombre ─────────────────────────────────

test('la acción se llama «Eliminar reunión», nunca «Eliminar transcripción»', () => {
  const src = read(DELETION);
  assert.match(src, /Eliminar reunión/);
  assert.doesNotMatch(src, /Eliminar transcripci/i, 'el audio también desaparece');
  // Y el diálogo enumera lo que se va, para que el nombre no sea una promesa
  // vacía.
  for (const cosa of ['audio original', 'transcripciones', 'análisis', 'artefactos']) {
    assert.ok(src.includes(cosa), `el diálogo debe nombrar: ${cosa}`);
  }
  assert.match(src, /No se puede deshacer/);
});

// ──────────────────────────── Permisos ───────────────────────────────────

test('un member no ve la acción, y el permiso se decide en el servidor', () => {
  const menu = sinComentarios(read(DELETION));
  assert.match(menu, /canDelete \?/, 'la opción está condicionada al permiso');

  for (const page of [LISTADO, FICHA]) {
    const src = sinComentarios(read(page));
    assert.match(
      src, /scope\.role === "owner" \|\| scope\.role === "admin"/,
      `${page} calcula el permiso desde el ámbito del servidor, no del cliente`,
    );
  }
});

test('ocultar el botón es cortesía: la ruta vuelve a exigir el permiso', () => {
  // El servicio, no la ruta, es quien lo impone — así lo hereda cualquier otro
  // llamador futuro en vez de tener que acordarse.
  const servicio = readFileSync(
    fileURLToPath(new URL('../../src/meetings/deletion.ts', import.meta.url)), 'utf8',
  );
  assert.match(servicio, /role === 'member'/);
  assert.match(servicio, /'forbidden'/);
});

// ─────────────── El navegador no propone claves ni ámbitos ───────────────

test('el cuerpo que manda el navegador lleva clientId y nada más', () => {
  const src = sinComentarios(read(DELETION));
  assert.match(src, /JSON\.stringify\(\{ clientId \}\)/, 'sólo clientId');
  assert.doesNotMatch(src, /storageKey|tenantId|prefix/i, 'nada que el servidor deba derivar');

  const ruta = sinComentarios(read(RUTA));
  assert.match(ruta, /ClientScopedBody/, 'y el esquema no tiene dónde meterlo');
  assert.doesNotMatch(ruta, /storageKey/);
});

test('la respuesta es 202: reservar no es haber terminado', () => {
  assert.match(sinComentarios(read(RUTA)), /status: 202/);
});

// ─────────────────── Los estados intermedios se ven ──────────────────────

test('«Eliminando» y «Reintentar eliminación» son estados visibles, no invisibles', () => {
  const src = read(DELETION);
  assert.match(src, /Eliminando…/);
  assert.match(src, /Reintentar eliminación/);
  assert.match(src, /deletionState === "deleting"/);
  assert.match(src, /deletionState === "delete_failed"/);
  // Un delete_failed escondido es un delete_failed que nadie reintenta, así
  // que el dato tiene que llegar hasta la fila del listado.
  const data = readFileSync(fileURLToPath(new URL('../../web/lib/meetingsData.ts', import.meta.url)), 'utf8');
  assert.match(data, /deletionState: "live" \| "deleting" \| "delete_failed"/);
});

test('el foco arranca en Cancelar, no en el botón rojo', () => {
  const src = sinComentarios(read(DELETION));
  assert.match(src, /cancelar\.current\?\.focus\(\)/);
  assert.match(src, /role="alertdialog"/);
  assert.match(src, /aria-modal="true"/);
});

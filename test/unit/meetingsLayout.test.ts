import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DOCK_INSET_BOTTOM_PX,
  dockBounds,
  READING_MEASURE_CLS,
  READING_MEASURE_PX,
  READING_MEASURE_REM,
} from '../../web/lib/meetingsLayout.js';

/**
 * La geometría del dock, como aritmética probable.
 *
 * El fallo que arregla no se ve leyendo el código: el dock declaraba 864 px y
 * la columna del transcript 1100, centrados contra cosas distintas —la ventana
 * y el panel—, así que no compartían ni ancho ni límites. Aquí se fija la regla
 * y se guarda que las dos formas de expresar la medida no puedan divergir.
 */

const PANEL = { left: 292, width: 1100, bottom: 860 };
const VENTANA = { viewportHeight: 900, viewportWidth: 1440 };

test('las dos expresiones de la medida describen el MISMO ancho', () => {
  // Una es una clase (la usa el transcript, que se pinta en el servidor) y la
  // otra un número (lo usa el dock, que se posiciona midiendo). Si alguien
  // cambia una sin la otra, los dos anchos vuelven a divergir en silencio.
  assert.equal(READING_MEASURE_PX, READING_MEASURE_REM * 16);
  assert.equal(READING_MEASURE_CLS, `max-w-[${READING_MEASURE_REM}rem]`);
  assert.equal(READING_MEASURE_PX, 1100);
});

test('el dock se centra respecto al PANEL, no a la ventana', () => {
  // Panel desplazado 292 px por la barra lateral. Centrado en la ventana el
  // dock quedaría en 170; centrado en el panel, en 292.
  const b = dockBounds({ panel: PANEL, ...VENTANA, focusMode: true });
  assert.equal(b.width, 1100, 'el ancho de la columna');
  assert.equal(b.left, 292, 'mismo borde izquierdo que el panel');
  assert.equal(b.left + b.width, PANEL.left + PANEL.width, 'y mismo borde derecho');
});

test('comparte los límites exactos de la columna del transcript', () => {
  // Panel MÁS ancho que la medida: la columna se centra dentro de él y el dock
  // tiene que hacer exactamente lo mismo.
  const panel = { left: 300, width: 1600, bottom: 860 };
  const b = dockBounds({ panel, ...VENTANA, focusMode: true });
  assert.equal(b.width, READING_MEASURE_PX, 'capado a la medida, como el texto');
  const margen = (panel.width - READING_MEASURE_PX) / 2;
  assert.equal(b.left, panel.left + margen);
  assert.equal(panel.left + panel.width - (b.left + b.width), margen, 'simétrico');
});

test('con un panel lateral abierto sigue al transcript a todo el ancho', () => {
  // Fuera de `focusMode` el transcript usa `max-w-none`, así que el dock
  // también: la regla es UNA, y está aquí.
  const panel = { left: 300, width: 1600, bottom: 860 };
  const b = dockBounds({ panel, ...VENTANA, focusMode: false });
  assert.equal(b.width, 1600);
  assert.equal(b.left, 300);
});

test('el panel más estrecho que la medida manda: el dock no se desborda', () => {
  const panel = { left: 40, width: 700, bottom: 860 };
  const b = dockBounds({ panel, ...VENTANA, focusMode: true });
  assert.equal(b.width, 700);
  assert.equal(b.left, 40);
});

test('se apoya 2 px por dentro del borde inferior del panel', () => {
  const b = dockBounds({ panel: PANEL, ...VENTANA, focusMode: true });
  // `bottom` es distancia al borde de la VENTANA, que es lo que usa `fixed`.
  // El panel acaba en 860 de 900, así que hay 40 px por debajo; 2 px por dentro
  // del panel son 42 desde abajo.
  assert.equal(b.bottom, 900 - 860 + DOCK_INSET_BOTTOM_PX);
  assert.equal(DOCK_INSET_BOTTOM_PX, 2);
  // Y el borde superior del dock queda DENTRO del panel, no por debajo.
  const dockBottomY = 900 - b.bottom;
  assert.ok(dockBottomY < PANEL.bottom, 'el dock termina por encima del borde del panel');
  assert.equal(PANEL.bottom - dockBottomY, 2);
});

test('la geometría NO depende de la pestaña: sólo del panel', () => {
  // Las cuatro pestañas comparten panel, así que comparten dock. Se prueba
  // llamando con el mismo rectángulo y comprobando que el resultado es idéntico
  // — el cálculo no recibe nada de la pestaña, que es la garantía real.
  const a = dockBounds({ panel: PANEL, ...VENTANA, focusMode: true });
  const b = dockBounds({ panel: PANEL, ...VENTANA, focusMode: true });
  assert.deepEqual(a, b);
  assert.deepEqual(Object.keys(a).sort(), ['bottom', 'left', 'width']);
});

test('en móvil no hay panel que respetar: casi todo el ancho con margen', () => {
  const b = dockBounds({ panel: { left: 0, width: 375, bottom: 800 }, viewportHeight: 812, viewportWidth: 375, focusMode: true });
  assert.equal(b.left, 12);
  assert.equal(b.width, 351);
  assert.equal(b.bottom, 12);
  assert.equal(b.left + b.width, 375 - 12, 'simétrico');
});

// ─────────────────── Que no se vuelva a declarar a mano ───────────────────

const web = fileURLToPath(new URL('../../web/', import.meta.url));
const sinComentarios = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('el dock ya no declara un ancho propio', () => {
  const dock = sinComentarios(readFileSync(`${web}components/reuniones/AudioDock.tsx`, 'utf8'));
  assert.doesNotMatch(dock, /max-w-\[/, 'su ancho lo da la medición, no una clase');
  assert.match(dock, /dockBounds\(/);
  // Sigue siendo fijo y flotante: no ha vuelto a ser hijo del contenido.
  assert.match(dock, /\bfixed\b/);
  assert.match(dock, /ResizeObserver/, 'se reajusta al abrir un panel lateral');
});

test('el transcript usa el token y nadie repite la medida a mano', () => {
  const ws = sinComentarios(readFileSync(`${web}components/reuniones/MeetingWorkspace.tsx`, 'utf8'));
  assert.match(ws, /READING_MEASURE_CLS/);
  assert.doesNotMatch(ws, /max-w-\[68\.75rem\]/, 'la medida no se escribe suelta');
  assert.match(ws, /scrollbarGutter: "stable"/, 'el canal de la barra se reserva');
});

test('las acciones de la cabecera no dependen de la pestaña', () => {
  const ws = sinComentarios(readFileSync(`${web}components/reuniones/MeetingWorkspace.tsx`, 'utf8'));
  // El defecto era exactamente este condicional.
  assert.doesNotMatch(ws, /tab !== "transcript" \? "" : "ml-auto"/);
  assert.match(ws, /className="ml-auto flex shrink-0 items-center gap-1\.5"/);
  // Y el bloque izquierdo puede ceder espacio.
  assert.match(ws, /flex min-w-0 flex-1 flex-col gap-0\.5/);
});

test('el canal de la barra se descuenta: el dock no sobresale del texto', () => {
  // La columna vive DENTRO del scroller; el dock, fuera. Sin descontar el canal
  // el dock quedaba ~13 px más ancho por la derecha que el texto.
  const panel = { left: 284, width: 984, bottom: 708 };
  const sin = dockBounds({ panel, viewportHeight: 720, viewportWidth: 1280, focusMode: true });
  const con = dockBounds({ panel, viewportHeight: 720, viewportWidth: 1280, focusMode: true, scrollbarGutter: 13 });
  assert.equal(sin.width, 984);
  assert.equal(con.width, 971, 'el ancho útil del scroller');
  assert.equal(con.left, 284, 'el borde izquierdo no cambia: el canal va a la derecha');
  assert.equal(con.left + con.width, 1255);
});

test('con barras superpuestas (canal 0) el resultado es el mismo que sin canal', () => {
  // En macOS con barras flotantes el canal mide 0. Codificar 15 desalinearía.
  const panel = { left: 284, width: 984, bottom: 708 };
  const a = dockBounds({ panel, viewportHeight: 720, viewportWidth: 1280, focusMode: true, scrollbarGutter: 0 });
  const b = dockBounds({ panel, viewportHeight: 720, viewportWidth: 1280, focusMode: true });
  assert.deepEqual(a, b);
});

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  deriveFollowState,
  nextFollowPref,
  shouldSuspendFollow,
  suspendsFollow,
} from '../../web/lib/transcriptBlocks.js';

/**
 * El dock flotante y el seguimiento de la transcripción.
 *
 * Dos mitades, y la separación es deliberada. Lo que se puede decidir con
 * números y booleanos —los tres estados del seguimiento, qué hace el botón,
 * cuándo un scroll es humano— vive en funciones puras y se prueba aquí. Lo que
 * sólo existe en un navegador —que haya UN `<audio>`, que cambiar de pestaña no
 * lo pause, que el dock no se mueva al desplazar— se verifica en el arnés
 * (web/tools/dockHarness.tsx), porque los eventos de scroll de Chrome se
 * despachan en el ciclo de pintado y una prueba sin pintado no los ve.
 */

// ─────────────────── Los tres estados del seguimiento ───────────────────

test('fuera de Transcript el seguimiento no está disponible', () => {
  for (const followPref of [true, false]) {
    for (const suspended of [true, false]) {
      assert.equal(
        deriveFollowState({ inTranscript: false, followPref, suspended }),
        'unavailable',
        'no hay texto que seguir, así que el control no se pinta',
      );
    }
  }
});

test('con el seguimiento apagado, un desplazamiento del usuario NO ofrece «Volver a seguir»', () => {
  // Éste es el defecto que encontró la captura: `suspended` se leía antes que la
  // preferencia, así que apagar el seguimiento y desplazar el texto sacaba un
  // botón para reanudar algo que nadie había suspendido.
  assert.equal(deriveFollowState({ inTranscript: true, followPref: false, suspended: true }), 'off');
  assert.equal(deriveFollowState({ inTranscript: true, followPref: false, suspended: false }), 'off');
});

test('siguiendo y sin desplazar es «on»; siguiendo y desplazado es «suspended»', () => {
  assert.equal(deriveFollowState({ inTranscript: true, followPref: true, suspended: false }), 'on');
  assert.equal(deriveFollowState({ inTranscript: true, followPref: true, suspended: true }), 'suspended');
});

test('el botón alterna lo que SE VE: sólo «on» se ve pulsado', () => {
  // Escribí el comentario al revés («suspended → off») y esta prueba lo pilló.
  // Gana el código: en `suspended` la píldora se ve SIN pulsar, así que pulsarla
  // tiene que encender. Lo contrario sería un interruptor que apaga algo que no
  // aparece encendido.
  assert.equal(nextFollowPref({ followPref: true, suspended: false }), false, 'on → off');
  assert.equal(nextFollowPref({ followPref: true, suspended: true }), true, 'suspended → reanuda');
  assert.equal(nextFollowPref({ followPref: false, suspended: false }), true, 'off → on');
  assert.equal(nextFollowPref({ followPref: false, suspended: true }), true);
});

// ─────────────────── Cuándo un desplazamiento es humano ───────────────────

test('un desplazamiento sólo suspende si se estaba siguiendo', () => {
  const ahora = 1_000_000;
  assert.equal(suspendsFollow({ followPref: false, now: ahora, suppressUntil: 0 }), false);
  assert.equal(suspendsFollow({ followPref: true, now: ahora, suppressUntil: 0 }), true);
});

test('el desplazamiento que hace el propio seguimiento no se suspende a sí mismo', () => {
  const ahora = 1_000_000;
  // Dentro de la ventana de supresión: es el scroll automático.
  assert.equal(suspendsFollow({ followPref: true, now: ahora, suppressUntil: ahora + 400 }), false);
  // Justo al vencer, ya cuenta como humano.
  assert.equal(suspendsFollow({ followPref: true, now: ahora, suppressUntil: ahora }), true);
  assert.equal(shouldSuspendFollow(ahora, ahora + 1), false);
});

// ─────────────────── Contrato del dock, a nivel de fuente ───────────────────

const web = fileURLToPath(new URL('../../web/', import.meta.url));
const leer = (rel: string): string => readFileSync(`${web}${rel}`, 'utf8');
const sinComentarios = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const DOCK = 'components/reuniones/AudioDock.tsx';
const PLAYER = 'components/reuniones/AudioPlayer.tsx';
const WORKSPACE = 'components/reuniones/MeetingWorkspace.tsx';

test('existe UN solo `<audio>` en todo el módulo, y un solo reproductor', () => {
  const todos = ['AudioDock.tsx', 'AudioPlayer.tsx', 'MeetingWorkspace.tsx', 'MeetingBits.tsx']
    .map((f) => sinComentarios(leer(`components/reuniones/${f}`)))
    .join('\n');
  assert.equal((todos.match(/<audio\b/g) ?? []).length, 1, 'un solo elemento de audio');
  assert.equal((sinComentarios(leer(DOCK)).match(/<AudioPlayer\b/g) ?? []).length, 1);
  // Y el workspace ya NO monta el reproductor por su cuenta.
  assert.doesNotMatch(sinComentarios(leer(WORKSPACE)), /<AudioPlayer\b/);
  assert.match(sinComentarios(leer(WORKSPACE)), /<AudioDock\b/);
});

test('el `<audio>` vive FUERA de la rama de modo, o compactar lo remontaría', () => {
  const src = sinComentarios(leer(PLAYER));
  // Se declara una vez como variable y se usa una vez, después del condicional.
  assert.match(src, /const elementoAudio =/);
  assert.equal((src.match(/\{elementoAudio\}/g) ?? []).length, 1,
    'una sola inserción: si hubiera una por rama, cambiar de modo cambiaría el nodo');
  const iCond = src.indexOf('compacto ? controlesCompactos');
  const iAudio = src.indexOf('{elementoAudio}');
  assert.ok(iCond > 0 && iAudio > iCond, 'el audio va después del condicional, como hermano');
});

test('el dock es fijo, flotante, acotado y por encima del contenido', () => {
  const src = leer(DOCK);
  assert.match(src, /\bfixed\b/, 'position: fixed');
  // El ancho y la posición ya NO son clases: se miden contra el panel para
  // compartir los límites de la columna del transcript. `max-w-[54rem]` era
  // precisamente lo que no coincidía con los 1100 px del texto. La aritmética
  // está probada en meetingsLayout.test.ts; aquí sólo se comprueba que el dock
  // la usa y que no ha vuelto a declarar un ancho propio.
  assert.match(src, /dockBounds\(/, 'el ancho lo da la medición');
  assert.doesNotMatch(src, /max-w-\[/, 'ninguna clase de ancho propia');
  assert.match(src, /inset-x-0 bottom-0/, 'los bordes de la ventana como respaldo antes de medir');
  assert.match(src, /justify-center/, 'expandido, centrado en el panel');
  assert.match(src, /justify-end/, 'compacto, a la derecha del panel');
  assert.match(src, /rounded-xl/);
  assert.match(src, /border border-line/);
  assert.match(src, /bg-surface/, 'fondo sólido');
  assert.match(src, /shadow-\[var\(--shadow-float\)\]/);
  assert.match(src, /z-40/);
  // La capa que centra no debe robar clics al contenido de debajo.
  assert.match(src, /pointer-events-none/);
  assert.match(src, /pointer-events-auto/);
});

test('el dock se monta como HERMANO del área de trabajo, no dentro de las pestañas', () => {
  const src = sinComentarios(leer(WORKSPACE));
  const iCierre = src.indexOf('</section>', src.indexOf('role="tablist"'));
  const iDock = src.indexOf('<AudioDock');
  assert.ok(iDock > iCierre, 'va después de cerrar el panel de pestañas');
});

test('el modo compacto no pinta la onda y guarda la preferencia', () => {
  const dock = leer(DOCK);
  assert.match(dock, /localStorage\.getItem/);
  assert.match(dock, /localStorage\.setItem/);
  assert.match(dock, /mai\.reuniones\.dock/);
  // Leer localStorage puede lanzar con cookies de terceros bloqueadas: un
  // reproductor que no se pinta por eso sería peor que perder la preferencia.
  assert.match(dock, /catch/);
  const player = sinComentarios(leer(PLAYER));
  const iCompacto = player.indexOf('const controlesCompactos');
  const rama = player.slice(iCompacto, player.indexOf('return (', iCompacto));
  assert.doesNotMatch(rama, /role="slider"/, 'sin onda ni barra de búsqueda en compacto');
  assert.match(rama, /aria-label="Expandir el reproductor"/);
});

test('el control se llama «Seguir transcripción» y ya no está en el transcript', () => {
  const player = leer(PLAYER);
  assert.match(player, /Seguir transcripción/);
  assert.match(player, /Volver a seguir/);
  // Sin comentarios: la nota que EXPLICA el cambio nombra el rótulo viejo, y
  // una aserción que la cuenta como código prohíbe documentar la historia.
  const ws = sinComentarios(leer(WORKSPACE));
  assert.doesNotMatch(ws, /Seguir audio/, 'el nombre viejo no sobrevive');
  assert.doesNotMatch(ws, /Volver al audio/);
  // Y la barra pegada desapareció de la vista del transcript.
  assert.doesNotMatch(sinComentarios(ws), /sticky top-0 z-10 -mx-3\.5/);
});

test('los contenedores desplazables reservan el hueco del dock', () => {
  assert.match(leer(DOCK), /DOCK_GAP_CLS = "pb-28 sm:pb-24"/);
  const ws = sinComentarios(leer(WORKSPACE));
  // Transcript, las vistas de lectura y los dos paneles de Reportes.
  assert.ok((ws.match(/DOCK_GAP_CLS/g) ?? []).length >= 4,
    'el dock está fuera del flujo: el hueco lo reserva quien scrollea');
});

test('todos los controles del dock tienen aria-label y foco visible', () => {
  const player = leer(PLAYER);
  for (const etiqueta of [
    'aria-label="Expandir el reproductor"',
    'aria-label="Compactar el reproductor"',
    'aria-label={playing ? "Pausar" : "Reproducir"}',
    'aria-label="Posición del audio"',
  ]) {
    assert.ok(player.includes(etiqueta), `falta ${etiqueta}`);
  }
  assert.match(player, /aria-pressed=\{followState === "on"\}/);
  // `u-focus` es la clase de foco visible del sistema de diseño.
  // `elementoAudio` se declara ANTES que la rama compacta, así que el corte
  // tiene que ir hasta el `return`, no hasta él.
  const iC = player.indexOf('const controlesCompactos');
  const compacto = player.slice(iC, player.indexOf('return (', iC));
  assert.ok((compacto.match(/u-focus/g) ?? []).length >= 2, 'los dos controles compactos son enfocables');
});

test('sin texto diminuto en el dock', () => {
  const player = leer(PLAYER);
  const tamaños = [...player.matchAll(/text-\[(\d+\.?\d*)rem\]/g)].map((m) => Number(m[1]) * 16);
  assert.ok(tamaños.length > 0, 'hay tamaños declarados que revisar');
  const diminutos = tamaños.filter((px) => px < 12);
  assert.deepEqual(diminutos, [], `hay texto por debajo de 12 px: ${diminutos.join(', ')}`);
});

// ─────────────────── Resumen: ni «null» ni tareas falsas ───────────────────

test('no se muestran valores técnicos como si fueran datos', () => {
  const ws = sinComentarios(leer(WORKSPACE));
  assert.match(ws, /textoODefecto\(t\.owner\)/);
  assert.match(ws, /fechaODefecto\(t\.due\)/);
  assert.match(ws, /"Sin responsable"/);
  assert.match(ws, /"Sin fecha"/);
  // Las iniciales sólo si hay responsable de verdad: con `owner: "null"` la
  // inicial calculada era una «N».
  assert.match(ws, /owner && t\.ownerInitials/);
});

test('no hay botones de tareas activos sin implementación', () => {
  const ws = sinComentarios(leer(WORKSPACE));
  const i = ws.indexOf('Crear tareas pendientes');
  assert.ok(i > 0, 'el botón sigue visible');
  const alrededor = ws.slice(Math.max(0, i - 700), i);
  assert.match(alrededor, /disabled/, 'y está deshabilitado');
  assert.match(alrededor, /aria-disabled="true"/);
  // «Crear tarea» por fila ya no es un botón.
  assert.doesNotMatch(ws, />\s*Crear tarea\s*</);
  assert.ok((ws.match(/Próximamente/g) ?? []).length >= 2, 'se dice lo que hay, en los dos sitios');
});

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  durationLabel,
  serializeTranscript,
  transcriptFileName,
  transcriptStamp,
} from '../../web/lib/meetingsTranscriptExport.js';
import {
  copyText,
  downloadTextFile,
  type ClipboardDeps,
  type DownloadDeps,
} from '../../web/lib/meetingsTranscriptActions.js';

/**
 * Copiar y descargar el transcript.
 *
 * El formato y los dos efectos del navegador se EJECUTAN aquí: el serializador
 * es puro y las dependencias del portapapeles y de la descarga se inyectan. Un
 * `assert.match` sobre el código de un botón no distingue «revoca el Object
 * URL» de «la palabra revoke aparece en el fichero».
 */

const raiz = new URL('../../', import.meta.url);
const leer = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, raiz)), 'utf8');
const sinComentarios = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const META = {
  title: 'Revisión del índice',
  clientName: 'Cliente W3',
  date: '11 de septiembre de 2026, 18:07',
  durationSeconds: 423,
};

const LINEAS = [
  { at: 0, speaker: 'Ana Ruiz', text: 'Empecemos por el estado del índice.' },
  { at: 12, speaker: 'Hablante 2', text: 'La reindexación tarda cuarenta minutos.' },
  { at: 37, speaker: 'Ana Ruiz', text: 'Entonces lo movemos al viernes.' },
];

// ───────────────────────────── El formato ────────────────────────────────

test('serializa varios hablantes con cabecera, marcas y líneas en blanco', () => {
  const txt = serializeTranscript(META, LINEAS)!;
  assert.equal(
    txt,
    'Revisión del índice\n' +
      'Cliente: Cliente W3\n' +
      'Fecha: 11 de septiembre de 2026, 18:07\n' +
      'Duración: 00:07:03\n' +
      '\n' +
      '[00:00] Ana Ruiz\n' +
      'Empecemos por el estado del índice.\n' +
      '\n' +
      '[00:12] Hablante 2\n' +
      'La reindexación tarda cuarenta minutos.\n' +
      '\n' +
      '[00:37] Ana Ruiz\n' +
      'Entonces lo movemos al viernes.\n',
  );
});

test('mezcla hablantes identificados y no identificados tal como llegan', () => {
  const txt = serializeTranscript(META, [
    { at: 0, speaker: 'Ana Ruiz', text: 'Uno.' },
    { at: 5, speaker: 'Hablante 2', text: 'Dos.' },
    { at: 9, speaker: 'Sin asignar', text: 'Tres.' },
  ])!;
  assert.match(txt, /\[00:00\] Ana Ruiz/);
  assert.match(txt, /\[00:05\] Hablante 2/);
  assert.match(txt, /\[00:09\] Sin asignar/);
  // Ni etiquetas crudas ni identificadores internos.
  assert.doesNotMatch(txt, /SPEAKER_\d/);
  assert.doesNotMatch(txt, /[0-9a-f]{8}-[0-9a-f]{4}/);
});

test('el orden es CRONOLÓGICO aunque lleguen desordenadas', () => {
  const txt = serializeTranscript(META, [
    { at: 37, speaker: 'C', text: 'tercera' },
    { at: 0, speaker: 'A', text: 'primera' },
    { at: 12, speaker: 'B', text: 'segunda' },
  ])!;
  const orden = [...txt.matchAll(/\[(\d\d:\d\d)\]/g)].map((m) => m[1]);
  assert.deepEqual(orden, ['00:00', '00:12', '00:37']);
});

test('dos intervenciones en el mismo segundo conservan su orden de llegada', () => {
  const txt = serializeTranscript(META, [
    { at: 10, speaker: 'A', text: 'primera' },
    { at: 10, speaker: 'B', text: 'segunda' },
  ])!;
  assert.ok(txt.indexOf('primera') < txt.indexOf('segunda'), 'el orden es estable');
});

test('las marcas pasan de la hora sin perder los minutos', () => {
  assert.equal(transcriptStamp(0), '00:00');
  assert.equal(transcriptStamp(7), '00:07');
  assert.equal(transcriptStamp(59), '00:59');
  assert.equal(transcriptStamp(60), '01:00');
  assert.equal(transcriptStamp(599), '09:59');
  assert.equal(transcriptStamp(3600), '1:00:00');
  assert.equal(transcriptStamp(3903), '1:05:03');
  assert.equal(transcriptStamp(7384), '2:03:04');
  // Y en el documento, con una reunión larga de verdad.
  const txt = serializeTranscript(META, [
    { at: 3903, speaker: 'A', text: 'pasada la hora' },
    { at: 12, speaker: 'B', text: 'al principio' },
  ])!;
  assert.match(txt, /\[00:12\] B/);
  assert.match(txt, /\[1:05:03\] A/);
});

test('la duración de la cabecera es HH:MM:SS', () => {
  assert.equal(durationLabel(0), '00:00:00');
  assert.equal(durationLabel(423), '00:07:03');
  assert.equal(durationLabel(3600), '01:00:00');
  assert.equal(durationLabel(45_296), '12:34:56');
});

test('las tildes, las eñes y los signos sobreviven intactos', () => {
  const txt = serializeTranscript(
    { title: 'Reunión de mañana — ¿seguimos?', clientName: 'Ñandú S.L.', date: null, durationSeconds: null },
    [{ at: 0, speaker: 'Iñaki Peña', text: '¿Añadimos la señal? Sí, cámbialo mañana.' }],
  )!;
  assert.match(txt, /Reunión de mañana — ¿seguimos\?/);
  assert.match(txt, /Ñandú S\.L\./);
  assert.match(txt, /Iñaki Peña/);
  assert.match(txt, /¿Añadimos la señal\? Sí, cámbialo mañana\./);
});

test('los saltos de línea del texto original se conservan', () => {
  const txt = serializeTranscript(META, [
    { at: 0, speaker: 'A', text: 'Primera línea.\nSegunda línea.' },
  ])!;
  assert.match(txt, /\[00:00\] A\nPrimera línea\.\nSegunda línea\.\n/);
});

// ──────────────────────── Los metadatos ausentes ─────────────────────────

test('un metadato que no existe OMITE su línea, no la deja vacía', () => {
  const txt = serializeTranscript(
    { title: 'Sólo el título', clientName: null, date: undefined, durationSeconds: null },
    [{ at: 0, speaker: 'A', text: 'Texto.' }],
  )!;
  assert.equal(txt, 'Sólo el título\n\n[00:00] A\nTexto.\n');
  for (const campo of ['Cliente:', 'Fecha:', 'Duración:']) {
    assert.doesNotMatch(txt, new RegExp(campo), `${campo} no debe aparecer`);
  }
});

test('un metadato en blanco cuenta como ausente', () => {
  const txt = serializeTranscript(
    { title: 'T', clientName: '   ', date: '', durationSeconds: 0 },
    [{ at: 0, speaker: 'A', text: 'Texto.' }],
  )!;
  assert.equal(txt, 'T\n\n[00:00] A\nTexto.\n');
});

test('con duración presente y cliente ausente, sólo sale la duración', () => {
  const txt = serializeTranscript(
    { title: 'T', clientName: null, date: null, durationSeconds: 90 },
    [{ at: 0, speaker: 'A', text: 'Texto.' }],
  )!;
  assert.equal(txt, 'T\nDuración: 00:01:30\n\n[00:00] A\nTexto.\n');
});

// ───────────────────────── El transcript vacío ───────────────────────────

test('un transcript vacío devuelve null: no hay fichero engañoso', () => {
  assert.equal(serializeTranscript(META, []), null);
});

test('un transcript de sólo espacios también es vacío', () => {
  assert.equal(
    serializeTranscript(META, [
      { at: 0, speaker: 'A', text: '   ' },
      { at: 4, speaker: 'B', text: '\n\n' },
    ]),
    null,
    'una cabecera sin intervenciones parece un transcript vacío y no lo es',
  );
});

test('las intervenciones vacías se caen, pero el resto se conserva', () => {
  const txt = serializeTranscript(META, [
    { at: 0, speaker: 'A', text: '  ' },
    { at: 4, speaker: 'B', text: 'Esto sí.' },
  ])!;
  assert.match(txt, /\[00:04\] B\nEsto sí\./);
  assert.doesNotMatch(txt, /\[00:00\]/);
});

// ─────────────────────── El nombre del fichero ───────────────────────────

test('el nombre del fichero se sanea y acaba en -transcript.txt', () => {
  assert.equal(transcriptFileName('Revisión del índice'), 'revision-del-indice-transcript.txt');
  assert.equal(transcriptFileName('Reunión: kickoff / fase 2'), 'reunion-kickoff-fase-2-transcript.txt');
  assert.equal(transcriptFileName('  Mañana   con   Ñandú  '), 'manana-con-nandu-transcript.txt');
  assert.equal(transcriptFileName('TestDemo'), 'testdemo-transcript.txt');
});

test('el nombre nunca lleva caracteres que un sistema de ficheros reserve', () => {
  for (const malo of ['a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b>', 'a|b', '../../etc/passwd']) {
    const n = transcriptFileName(malo);
    assert.doesNotMatch(n, /[/\\:*?"<>|]/, `«${malo}» produjo «${n}»`);
    assert.doesNotMatch(n, /\.\./, 'ni una travesía de directorios');
    assert.match(n, /-transcript\.txt$/);
  }
});

test('un título sin nada utilizable cae en un nombre por omisión', () => {
  assert.equal(transcriptFileName('¿?¡!'), 'reunion-transcript.txt');
  assert.equal(transcriptFileName(''), 'reunion-transcript.txt');
  assert.equal(transcriptFileName('---'), 'reunion-transcript.txt');
});

test('un título larguísimo se acorta y no pierde el sufijo', () => {
  const n = transcriptFileName('palabra '.repeat(60));
  assert.ok(n.length <= 80 + '-transcript.txt'.length, `mide ${n.length}`);
  assert.match(n, /-transcript\.txt$/);
  assert.doesNotMatch(n, /--/);
});

// ─────────────────────────── El portapapeles ─────────────────────────────

test('copiar escribe el documento COMPLETO, no lo visible', () => {
  const largo = Array.from({ length: 250 }, (_, i) => ({
    at: i * 7,
    speaker: i % 2 === 0 ? 'Ana Ruiz' : 'Hablante 2',
    text: `Intervención número ${i}.`,
  }));
  const txt = serializeTranscript(META, largo)!;
  let escrito: string | null = null;
  const portapapeles: ClipboardDeps = {
    writeText: async (t) => { escrito = t; },
  };
  return copyText(txt, portapapeles).then((ok) => {
    assert.equal(ok, true);
    assert.equal(escrito, txt);
    // Las 250 intervenciones, incluida la última.
    assert.equal((escrito!.match(/\[\d/g) ?? []).length, 250);
    assert.match(escrito!, /Intervención número 249\./);
  });
});

test('si el portapapeles falla, copiar devuelve false', async () => {
  const revienta: ClipboardDeps = {
    writeText: async () => { throw new Error('NotAllowedError'); },
  };
  assert.equal(await copyText('cualquier cosa', revienta), false);
});

test('sin portapapeles disponible, copiar devuelve false y no lanza', async () => {
  assert.equal(await copyText('cualquier cosa', null), false);
});

test('copiar una cadena vacía no se considera un éxito', async () => {
  let llamado = false;
  const p: ClipboardDeps = { writeText: async () => { llamado = true; } };
  assert.equal(await copyText('', p), false);
  assert.equal(llamado, false, 'ni se molesta en llamar al portapapeles');
});

// ───────────────────────────── La descarga ───────────────────────────────

function espia() {
  const eventos: string[] = [];
  let urlCreada: string | null = null;
  let revocada: string | null = null;
  let blob: Blob | null = null;
  let nombre: string | null = null;
  const deps: DownloadDeps = {
    createObjectURL: (b) => {
      blob = b;
      urlCreada = 'blob:falso-1';
      eventos.push('create');
      return urlCreada;
    },
    triggerDownload: (url, fileName) => {
      eventos.push(`download:${url}`);
      nombre = fileName;
    },
    revokeObjectURL: (url) => {
      eventos.push('revoke');
      revocada = url;
    },
    // Inmediato, para poder comprobar la revocación sin esperar un temporizador.
    schedule: (fn) => fn(),
  };
  return {
    deps,
    get eventos() { return eventos; },
    get urlCreada() { return urlCreada; },
    get revocada() { return revocada; },
    get blob() { return blob; },
    get nombre() { return nombre; },
  };
}

test('descargar crea un TXT con el contenido esperado y en UTF-8', async () => {
  const txt = serializeTranscript(META, LINEAS)!;
  const e = espia();
  downloadTextFile('revision-del-indice-transcript.txt', txt, e.deps);

  assert.equal(e.nombre, 'revision-del-indice-transcript.txt');
  assert.ok(e.blob);
  assert.equal(e.blob!.type, 'text/plain;charset=utf-8', 'sin charset, las tildes se leen mal');
  assert.equal(await e.blob!.text(), txt, 'el fichero lleva exactamente lo que se copia');
});

test('el Object URL se REVOCA, y después de disparar la descarga', () => {
  const e = espia();
  const url = downloadTextFile('x-transcript.txt', 'contenido', e.deps);
  assert.equal(url, e.urlCreada);
  assert.equal(e.revocada, url, 'se revoca el mismo url que se creó');
  assert.deepEqual(
    e.eventos,
    ['create', 'download:blob:falso-1', 'revoke'],
    'revocar antes de disparar dejaría la descarga vacía',
  );
});

test('el contenido descargado y el copiado son IDÉNTICOS', async () => {
  const txt = serializeTranscript(META, LINEAS)!;
  let copiado: string | null = null;
  await copyText(txt, { writeText: async (t) => { copiado = t; } });
  const e = espia();
  downloadTextFile('t.txt', txt, e.deps);
  assert.equal(copiado, await e.blob!.text(), 'un solo serializador, un solo documento');
});

// ───────── Lo que no se puede ejecutar: el cableado de la pantalla ───────

const ACCIONES = 'web/components/reuniones/TranscriptActions.tsx';
const WORKSPACE = 'web/components/reuniones/MeetingWorkspace.tsx';

test('no hay red: ni fetch, ni endpoint, ni servicio externo', () => {
  for (const f of [
    ACCIONES,
    'web/lib/meetingsTranscriptExport.ts',
    'web/lib/meetingsTranscriptActions.ts',
  ]) {
    const src = sinComentarios(leer(f));
    assert.doesNotMatch(src, /fetch\(/, `${f} no hace red`);
    assert.doesNotMatch(src, /XMLHttpRequest|navigator\.sendBeacon/, `${f} tampoco por otra vía`);
    assert.doesNotMatch(src, /https?:\/\//, `${f} no nombra ningún servicio`);
  }
});

test('el mismo documento alimenta la cabecera y la pestaña', () => {
  const src = sinComentarios(leer(WORKSPACE));
  // Un solo `useTranscriptExport` en todo el área de trabajo.
  assert.equal((src.match(/useTranscriptExport\(/g) ?? []).length, 1);
  // Y lo consumen los dos: el «Exportar» de la cabecera y la fila.
  assert.match(src, /onClick=\{transcriptActions\.descargar\}/);
  assert.match(src, /<TranscriptActionsRow acciones=\{transcriptActions\}/);
});

test('el doble clic no dispara dos veces', () => {
  const src = sinComentarios(leer(ACCIONES));
  // Un `ref` ADEMÁS del estado: dos clics en el mismo cuadro leen el mismo
  // valor de estado y los dos pasarían.
  assert.match(src, /const ocupado = useRef\(false\)/);
  assert.equal((src.match(/if \(ocupado\.current/g) ?? []).length, 2, 'copiar y descargar');
  assert.match(src, /ocupado\.current = true/);
  // Y los botones se deshabilitan mientras dura.
  assert.match(src, /disabled=\{acciones\.enVuelo\}/);
  assert.match(src, /aria-busy=\{acciones\.enVuelo\}/);
});

test('ni el audio ni las pestañas se tocan al copiar o descargar', () => {
  const src = sinComentarios(leer(ACCIONES));
  for (const prohibido of [/<audio/, /new Audio\(/, /\.pause\(\)/, /\.play\(\)/, /currentTime/, /setTab/]) {
    assert.doesNotMatch(src, prohibido, `no debe aparecer ${prohibido}`);
  }
  // El aviso se monta en el ÁREA DE TRABAJO, no en la pestaña: montado en la
  // pestaña, cambiar de vista lo desmontaría y dejaría sin confirmar una acción
  // que sí ocurrió.
  const ws = sinComentarios(leer(WORKSPACE));
  assert.match(ws, /<MeetingToast texto=\{aviso\.texto\} onCerrar=\{aviso\.cerrar\} \/>/);
});

test('el aviso es uno solo y compartido con «Eliminar reunión»', () => {
  const toast = 'web/components/reuniones/MeetingToast.tsx';
  const src = leer(toast);
  assert.match(src, /role="status"/);
  assert.match(src, /aria-live="polite"/);
  // Nunca sólo color: lo que informa es el texto.
  assert.match(src, /\{texto\}/);
  // Y el módulo de eliminación lo IMPORTA en vez de tener su propia copia.
  const del = leer('web/components/reuniones/MeetingDeletion.tsx');
  assert.match(del, /import \{ MeetingToast \} from "@\/components\/reuniones\/MeetingToast"/);
  assert.doesNotMatch(sinComentarios(del), /function Aviso\(/, 'no quedó una copia');
});

test('los tres mensajes son los pedidos, literalmente', () => {
  const src = leer(ACCIONES);
  assert.match(src, /"Transcript copiado"/);
  assert.match(src, /"Transcript descargado"/);
  assert.match(src, /"No pudimos copiar el transcript\. Inténtalo nuevamente\."/);
});

test('sin transcript, las acciones no se ofrecen y se explica por qué', () => {
  const src = leer(ACCIONES);
  assert.match(src, /Todavía no hay transcript que copiar ni descargar/);
  assert.match(src, /Este transcript no tiene texto que copiar ni descargar/);
  // Y el «Exportar» de la cabecera se deshabilita con su motivo.
  const ws = leer(WORKSPACE);
  assert.match(ws, /disabled=\{!transcriptActions\.disponible \|\| transcriptActions\.enVuelo\}/);
  assert.match(ws, /Todavía no hay transcript que exportar/);
});

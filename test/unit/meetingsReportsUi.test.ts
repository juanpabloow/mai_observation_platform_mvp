import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Contrato a nivel de fuente de la pestaña Reportes.
 *
 * Misma técnica que el resto de contratos de pantalla de este repositorio (sin
 * HTTP, sin DB, sin render de React): son componentes de cliente y páginas
 * `server-only` que el runner de la raíz no puede invocar. Lo que se ejecuta de
 * verdad —la lista cerrada, las citas, las fechas— está en
 * `meetingsReportsContract.test.ts`; aquí se guarda el CABLEADO, que es lo que
 * un rediseño puede romper en silencio.
 */

const raiz = new URL('../../', import.meta.url);
const leer = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, raiz)), 'utf8');
const sinComentarios = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const REPORTS = 'web/components/reuniones/ReportsTab.tsx';
const WORKSPACE = 'web/components/reuniones/MeetingWorkspace.tsx';
const FICHA = 'web/app/clients/[clientId]/reuniones/[meetingId]/page.tsx';
const RUTA_REPORTES = 'web/app/api/meetings/v1/meetings/[meetingId]/reports/route.ts';
const RUTA_PLANTILLAS = 'web/app/api/meetings/v1/report-templates/route.ts';
const RUTA_EDITAR = 'web/app/api/meetings/v1/report-templates/[templateId]/route.ts';
const RUTA_RESTAURAR = 'web/app/api/meetings/v1/report-templates/[templateId]/restore/route.ts';
const SERVICIO = 'src/meetings/analysis/reports/service.ts';

// ───────────────── El recorrido completo está en la pestaña ──────────────

test('la pestaña ofrece las tres acciones de cada plantilla', () => {
  const src = leer(REPORTS);
  for (const rotulo of ['Generar', 'Editar instrucciones', 'Restaurar predeterminado']) {
    assert.match(src, new RegExp(rotulo), `falta «${rotulo}»`);
  }
  // Y el nombre, la descripción y la versión de cada una.
  assert.match(src, /\{t\.name\}/);
  assert.match(src, /\{t\.description\}/);
  assert.match(src, /v\{t\.version\}/);
});

test('los cuatro estados existen: vacío, generando, listo y error con reintento', () => {
  const src = leer(REPORTS);
  assert.match(src, /Todavía no hay reportes/, 'vacío');
  assert.match(src, /Generando el reporte…/, 'generando');
  assert.match(src, /kind: "generating"/);
  assert.match(src, /kind: "error"/);
  assert.match(src, /Reintentar/, 'y el error se puede reintentar');
  assert.match(src, /role="alert"/, 'el error se anuncia');
});

test('hay historial de reportes y se puede abrir uno anterior', () => {
  const src = sinComentarios(leer(REPORTS));
  assert.match(src, /Reportes generados/);
  assert.match(src, /setAbierto\(r\.id\)/, 'un clic abre el reporte de esa fila');
  assert.match(src, /aria-current=\{r\.id === abierto\}/);
  // Y los de otra versión de transcripción se marcan, en vez de esconderse.
  assert.match(src, /Otra versión|otra versión del transcript/);
});

test('NO hay editor manual del contenido generado ni exportación', () => {
  const src = sinComentarios(leer(REPORTS));
  // El mobiliario del fixture prometía esto y no existía. No debe volver.
  for (const prohibido of [/cambios sin guardar/, /Descartar/, /\bPDF\b/, /DOCX/, /Compartir/]) {
    assert.doesNotMatch(src, prohibido, `fuera de alcance: ${prohibido}`);
  }
  // El documento se pinta desde datos, no es editable.
  assert.doesNotMatch(src, /contentEditable/);
});

test('el fixture de Reportes se fue del workspace y no quedó a medias', () => {
  const ws = sinComentarios(leer(WORKSPACE));
  assert.doesNotMatch(ws, /function Reports\b/, 'el componente viejo se fue');
  assert.doesNotMatch(ws, /meeting\.reportList/, 'y con él su fuente de datos inventada');
  assert.match(ws, /<ReportsTab/, 'y en su sitio está el de verdad');
});

// ─────────────────────── El reproductor no se toca ───────────────────────

test('la pestaña NO crea un segundo elemento de audio', () => {
  // Sin comentarios: la nota que EXPLICA la regla nombra `<audio>`, y una
  // aserción que la cuenta como código prohíbe documentar el motivo.
  const src = sinComentarios(leer(REPORTS));
  assert.doesNotMatch(src, /<audio/, 'un segundo <audio> es el fallo que costó arreglar el dock');
  assert.doesNotMatch(src, /new Audio\(/);
  assert.doesNotMatch(src, /<AudioDock|<AudioPlayer/, 'ni monta el dock por su cuenta');
  // Importar `DOCK_GAP_CLS` sí: es el hueco que reserva quien scrollea, no el
  // reproductor.
  assert.match(src, /DOCK_GAP_CLS/);
});

test('las citas usan el MISMO jumpTo del workspace, que cambia a Transcript y hace seek', () => {
  const ws = sinComentarios(leer(WORKSPACE));
  // `jumpTo` sigue haciendo las tres cosas.
  const i = ws.indexOf('const jumpTo = (seconds: number) =>');
  assert.ok(i > 0, 'jumpTo existe');
  const cuerpo = ws.slice(i, ws.indexOf('};', i));
  assert.match(cuerpo, /setAt\(seconds\)/, 'mueve el playhead');
  assert.match(cuerpo, /setFocusedAt\(seconds\)/);
  assert.match(cuerpo, /setTab\("transcript"\)/, 'y cambia a Transcript');
  // Y es exactamente eso lo que recibe la pestaña.
  assert.match(ws, /<ReportsTab[\s\S]*?onSeek=\{jumpTo\}/);
});

test('las citas del documento son botones que llaman a onSeek con el segundo del segmento', () => {
  const src = sinComentarios(leer(REPORTS));
  // `StampLink` es el mismo componente que usan el transcript y el resumen.
  assert.match(src, /import \{ StampLink \}/);
  assert.equal(
    (src.match(/<StampLink/g) ?? []).length, 2,
    'la cabecera de sección y el elemento; nada más',
  );
  assert.match(src, /at=\{item\.citation\.at\}/, 'el segundo sale de la cita resuelta por el servidor');
  assert.match(src, /at=\{sec\.citation\.at\}/);
  assert.doesNotMatch(src, /at=\{\d/, 'nunca un tiempo escrito a mano');
});

// ──────────── Lo que la interfaz muestra cuando algo no consta ───────────

test('sin responsable dice «Sin asignar»; sin fecha, «No consta»', () => {
  const src = leer(REPORTS);
  assert.match(src, /Sin asignar/);
  assert.match(src, /No consta/);
  // Y se decide por `null`, no por una cadena vacía que podría venir del modelo.
  assert.match(src, /item\.owner === null/);
  assert.match(src, /item\.dueText === null/);
});

test('el caveat se pinta cuando existe, en su propio bloque', () => {
  const src = sinComentarios(leer(REPORTS));
  assert.match(src, /doc\.caveat \?/);
  assert.match(src, /Advertencia/);
});

test('el coste NO se pinta en la interfaz, pero sí se guarda', () => {
  // Decisión de producto: el gasto se registra —`cost_usd`, `input_tokens` y
  // `output_tokens` en `meeting_analyses`— y no se muestra. A quien lee un acta
  // no le aporta nada, y un importe en la cabecera convierte un documento de
  // trabajo en una factura.
  const src = sinComentarios(leer(REPORTS));
  assert.doesNotMatch(src, /costUsd/, 'la vista no lee el coste');
  assert.doesNotMatch(src, /coste/i, 'ni lo nombra');
  assert.doesNotMatch(src, /toFixed\(4\)/);

  // Pero el camino del dato sigue entero: columna, vista del servidor y tipo.
  const servicio = leer(SERVICIO);
  assert.match(servicio, /readonly costUsd: number \| null/);
  assert.match(servicio, /costUsd: row\.cost_usd === null \? null : Number\(row\.cost_usd\)/);
  const repo = leer('src/db/repositories/meetings/analyses.ts');
  assert.match(repo, /cost_usd/, 'y se persiste');
});

test('el documento se alinea a la IZQUIERDA con medida, no centrado', () => {
  const src = sinComentarios(leer(REPORTS));
  // Ocupa el ancho del panel hasta una medida legible y arranca en el borde
  // izquierdo. Centrarlo dejaría dos calles simétricas y haría flotar un
  // documento, que se lee desde un margen.
  assert.match(src, /<article className="flex max-w-\[58rem\]/);
  assert.doesNotMatch(src, /<article[^>]*mx-auto/, 'sin centrar');
  assert.doesNotMatch(src, /items-center[^"]*"[\s>]*\n?\s*<article/);
});
// ───────────── El prompt interno no sale por ninguna parte ──────────────

test('ni la interfaz ni las rutas exponen el system prompt ni el esquema', () => {
  const publicos = [REPORTS, RUTA_REPORTES, RUTA_PLANTILLAS, RUTA_EDITAR, RUTA_RESTAURAR].map(leer);
  for (const src of publicos) {
    for (const prohibido of [
      /REPORT_SYSTEM_PROMPT/,
      /reportJsonSchema/,
      /json_schema/,
      /SELF_OWNER/,
    ]) {
      assert.doesNotMatch(src, prohibido, `no debe aparecer ${prohibido}`);
    }
  }
  // El log de la ruta registra CUÁNTOS responsables permitidos hay, que es un
  // número útil para diagnosticar. La lista de nombres no sale por ningún
  // sitio, y el cuerpo de la respuesta no incluye la estimación.
  const ruta = sinComentarios(leer(RUTA_REPORTES));
  assert.match(ruta, /estimate\.allowedOwners/, 'el recuento sí, y sólo en el log');
  // El ÚLTIMO `Response.json`: el primero es el del GET, y la estimación sólo
  // podría filtrarse por el del POST.
  const iResponse = ruta.lastIndexOf('return Response.json(');
  assert.doesNotMatch(
    ruta.slice(iResponse), /estimate/,
    'la estimación no viaja al navegador',
  );
});

test('la vista de una plantilla sólo lleva el texto EDITABLE', () => {
  const src = leer(SERVICIO);
  const i = src.indexOf('export interface TemplateView');
  const vista = src.slice(i, src.indexOf('}', i));
  for (const campo of ['instructions', 'name', 'description', 'version']) {
    assert.match(vista, new RegExp(`readonly ${campo}`), `${campo} sí sale`);
  }
  for (const prohibido of ['systemPrompt', 'schema', 'guard']) {
    assert.doesNotMatch(vista, new RegExp(prohibido, 'i'), `${prohibido} NO sale`);
  }
});

test('ningún componente de web/ importa el prompt ni el contrato del reporte', () => {
  // La frontera es de IMPORTACIÓN, no de disciplina: si un componente pudiera
  // importar el prompt, el prompt acabaría en el paquete del navegador.
  const dirs = ['web/components/reuniones', 'web/lib'];
  for (const dir of dirs) {
    for (const f of readdirSync(fileURLToPath(new URL(dir, raiz)))) {
      if (!f.endsWith('.ts') && !f.endsWith('.tsx')) continue;
      const src = leer(`${dir}/${f}`);
      assert.doesNotMatch(src, /reports\/prompt\.js/, `${dir}/${f} importa el prompt`);
      assert.doesNotMatch(
        src, /from "@worker\/meetings\/analysis\/reports\/contract\.js"/,
        `${dir}/${f} importa el contrato`,
      );
    }
  }
});

// ──────────────────────── El cuerpo de las peticiones ───────────────────

test('el navegador no puede proponer instrucciones al generar', () => {
  const ruta = leer(RUTA_REPORTES);
  assert.match(ruta, /GenerateReportBody/);
  const val = leer('web/lib/meetingsValidation.ts');
  const i = val.indexOf('export const GenerateReportBody');
  const esquema = val.slice(i, val.indexOf(';', i));
  assert.match(esquema, /clientId/);
  assert.match(esquema, /templateId/);
  assert.doesNotMatch(esquema, /instructions/, 'el texto lo lee el servidor de la plantilla guardada');
  assert.match(esquema, /\.strict\(\)/, 'y nada más pasa');
});

test('editar y restaurar exigen expectedVersion', () => {
  const val = leer('web/lib/meetingsValidation.ts');
  for (const nombre of ['EditTemplateBody', 'RestoreTemplateBody']) {
    const i = val.indexOf(`export const ${nombre}`);
    const esquema = val.slice(i, val.indexOf(';', i));
    assert.match(esquema, /expectedVersion/, `${nombre} lleva el testigo`);
  }
  // Y la interfaz lo manda de verdad, con la versión que estaba mirando.
  const src = leer(REPORTS);
  assert.match(src, /expectedVersion: t\.version/);
});

test('GET lista y POST genera: una recarga no puede costar dinero', () => {
  const ruta = leer(RUTA_REPORTES);
  assert.match(ruta, /export async function GET/);
  assert.match(ruta, /export async function POST/);
  const iGet = ruta.indexOf('export async function GET');
  const iPost = ruta.indexOf('export async function POST');
  const get = ruta.slice(iGet, iPost);
  assert.doesNotMatch(get, /generateReport/, 'el GET no genera nada');
  assert.match(get, /listReports/);
});

test('el POST registra el techo de coste ANTES de llamar, y sin contenido', () => {
  const ruta = sinComentarios(leer(RUTA_REPORTES));
  const iEstimate = ruta.indexOf('previewReportCost');
  const iGenerate = ruta.indexOf('generateReport(scope');
  assert.ok(iEstimate > 0 && iGenerate > iEstimate, 'el techo se calcula antes de generar');
  assert.match(ruta, /usd_max/);
  // Nada de contenido en los logs.
  for (const prohibido of [/instructions/, /transcript/, /apiKey/, /payload/]) {
    assert.doesNotMatch(ruta, prohibido, `el log no lleva ${prohibido}`);
  }
});

// ─────────────────────────────── Permisos ────────────────────────────────

test('el permiso de edición se decide en el servidor y baja como dato', () => {
  const ficha = leer(FICHA);
  assert.match(ficha, /canEditTemplates=\{scope\.role === "owner" \|\| scope\.role === "admin"\}/);
  // Y el servicio lo vuelve a exigir, que es la defensa de verdad.
  const servicio = leer(SERVICIO);
  assert.match(servicio, /function requireAdmin/);
  assert.match(servicio, /scope\.role !== 'owner' && scope\.role !== 'admin'/);
  for (const fn of ['editTemplate', 'restoreTemplate']) {
    const i = servicio.indexOf(`export async function ${fn}`);
    assert.match(servicio.slice(i, i + 400), /requireAdmin\(scope\)/, `${fn} lo exige`);
  }
});

test('generar y listar NO exigen rol: cualquier miembro del cliente puede', () => {
  const servicio = leer(SERVICIO);
  for (const fn of ['generateReport', 'listReports', 'listTemplates']) {
    const i = servicio.indexOf(`export async function ${fn}`);
    const cuerpo = servicio.slice(i, servicio.indexOf('\n}', i));
    assert.doesNotMatch(cuerpo, /requireAdmin/, `${fn} no debe pedir rol`);
  }
});

// ──────────────── Persistencia: el servidor resuelve, no el cliente ─────

test('los reportes bajan como prop desde el servidor, no se piden al montar', () => {
  const ficha = leer(FICHA);
  assert.match(ficha, /listMeetingReports/);
  assert.match(ficha, /listReportTemplates/);
  assert.match(ficha, /reports=\{reports\}/);
  // La pestaña no hace un fetch de lectura al montarse: eso es lo que haría
  // que una recarga pareciera regenerar.
  const src = sinComentarios(leer(REPORTS));
  assert.doesNotMatch(src, /useEffect\([\s\S]{0,200}fetch\(/, 'no se lee al montar');
  // Sus únicos fetch son los tres de escritura.
  assert.equal((src.match(/fetch\(/g) ?? []).length, 3, 'generar, editar y restaurar');
});

test('editar avisa de que los reportes ya hechos no cambian', () => {
  const src = leer(REPORTS);
  assert.match(src, /Los reportes ya generados no cambian/);
  assert.match(src, /Guardar como v\$\{t\.version \+ 1\}/, 'y de que crea una versión');
});

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * SOURCE CONTRACT: Equipo follows the APPROVED «M_AI Agenda» reference (E1 list, E2 ficha,
 * f56–f58 panels), on the same chrome as Calendario and Horarios (agenda/AgendaChrome +
 * the `.u-ag` tokens). It replaces the earlier "Equipo wears the Contacts layout" contract:
 * the approved design is one surface flush to the frame, not cards on a canvas.
 *
 * What is pinned is GEOMETRY and BEHAVIOUR that must not drift back: one surface, the
 * shared page header, the roster table, the ficha as its own screen with fixed tabs, a
 * read-only Perfil whose edit is a guarded panel (ONE write path), the create panel, the
 * services list + panel, and the tab guard of finding C. Copy is checked only where it is
 * the contract (presence words, finding F).
 */
const read = (rel: string): string => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '').replace(/^\s*\/\/.*$/gm, '');

const TAB = 'web/components/scheduling/staff/StaffTab.tsx';
const WORKSPACE = 'web/components/scheduling/staff/StaffWorkspace.tsx';
const DRAWER = 'web/components/scheduling/staff/StaffCreateDrawer.tsx';
const SERVICES = 'web/components/scheduling/staff/StaffServicesEditor.tsx';

test('Equipo is ONE surface flush to the frame, in the agenda tokens, with the shared header', () => {
  const ws = read(WORKSPACE);
  assert.ok(ws.includes('className={`u-ag '), 'the screen wears the agenda tokens');
  assert.ok(ws.includes('-m-[var(--content-pad)] flex min-h-0 flex-1 flex-col bg-[var(--surface)]'), 'one surface flush to the shell frame');
  const src = read(TAB);
  assert.ok(src.includes('<AgPageHeader title="Equipo" />'), 'the same title place and size as Calendario and Horarios');
});

test('the roster is ONE table (reference E1): search, «Opciones», «Añadir», then the rows', () => {
  const src = read(TAB);
  assert.ok(src.includes('role="table" aria-label="Profesionales de la sede"'), 'one table');
  for (const col of ['Profesional', 'Rol', 'Ahora', 'Citas hoy', 'Horas', 'Servicios', 'Horario']) {
    assert.ok(src.includes(`>${col}</span>`), `column ${col}`);
  }
  assert.ok(src.includes('aria-label="Buscar profesional"'), 'search');
  assert.ok(src.includes('<TeamOptions'), '«Opciones»: presence, service and site');
  assert.ok(src.includes('onClick={() => setCreating(true)}') && src.includes('Añadir'), '«Añadir» opens the create panel');
  assert.ok(src.includes('aria-label={`Abrir ficha de ${member.name}`}'), 'a row opens the ficha');
  assert.ok(src.includes('scheduling/agenda?staff=${member.id}'), '«Agenda» opens the calendar filtered to them');
  assert.ok(!src.includes('--staff-panel-w'), 'no side lane reserved for a drawer');
});

test('presence filters are counted, and the counts come from the shared roster maths', () => {
  const src = read(TAB);
  assert.ok(src.includes('{ key: "with_client", label: "Con cita ahora", n: counts.withClient }'), 'presence buckets with counts');
  assert.ok(src.includes('role="menuitemradio"'), 'one choice at a time');
  assert.ok(src.includes('rosterFacetCounts'), 'the same counts as the phone');
});

test('the ficha is its OWN screen: it replaces the list in the same surface', () => {
  const src = stripComments(read(TAB));
  assert.equal(src.match(/<StaffDetail/g)?.length, 1, 'rendered exactly once');
  assert.ok(src.includes('if (selected) {'), 'selecting a professional swaps the surface');
  assert.equal(src.includes('className={OVERLAY_SCRIM}'), false, 'no scrim: it is not an overlay');
  assert.ok(src.includes('aria-label="Ruta"') && src.includes('href={closeHref}'), 'a breadcrumb goes back to Equipo');
});

test('the ficha header introduces the person (88px tile), then two actions; the tabs stay fixed', () => {
  const src = read(TAB);
  assert.ok(src.includes('size={88} radius={18}'), 'the reference tile');
  assert.ok(src.includes('Editar perfil') && src.includes('Ver su agenda'), 'the two actions');
  assert.ok(src.includes('role="tablist"') && src.includes('<div key={tab} className="min-h-0 flex-1 overflow-y-auto'), 'tabs outside the one scrolling body');
});

test('presence words describe the agenda, not the room (finding F)', () => {
  const src = read(TAB);
  for (const claim of ['min en silla', '"Con cliente"']) assert.ok(!src.includes(claim), `no "${claim}" without an event that supports it`);
  assert.ok(src.includes('label: "Ocupado según agenda"'));
});

test('Resumen is the reference: today, the last 30 days (agenda data), next absences, the week', () => {
  const src = read(TAB);
  assert.ok(src.includes('Hoy · {fmtDayLong(now.toISOString(), tz)}'), 'today');
  assert.ok(src.includes('Últimos 30 días') && src.includes('No representan facturación ni dinero cobrado'), 'agenda numbers, never billing');
  assert.ok(src.includes('Próximas ausencias') && src.includes('Horario semanal'), 'absences and the weekly schedule');
});

test('there is ONE write path per field: Perfil reads, «Editar perfil» is a guarded panel', () => {
  const src = read(TAB);
  assert.ok(src.includes('<ProfileView member={member} onEdit={() => setEditingProfile(true)} />'), 'Perfil is read-only');
  const panel = src.slice(src.indexOf('name="staff-profile"'), src.indexOf('name="staff-profile"') + 1200);
  assert.ok(panel.includes('dirty={dirtyFields.length > 0}'), 'closing with changes asks first');
  assert.ok(src.includes('const r = await updateStaffAction(clientId, member.id, patch);'), 'ONE save for the whole person');
  assert.ok(src.includes('setDeactivateConfirm(appts)'), 'deactivating with future appointments still asks, and cancels nothing');
});

test('the CREATE panel is create-only and uses the agenda side panel (reference f56)', () => {
  const src = read(DRAWER);
  assert.ok(src.includes('<SidePanel') && src.includes('name="staff-create"'), 'the agenda side panel');
  assert.ok(src.includes('createStaffAction({ clientId, siteId: site, name: name.trim(), serviceIds: [] })'), 'the same create call; services are set in the ficha');
  assert.ok(src.includes('Empieza con el horario de la sede y sin servicios asignados'), 'it says what it starts with');
  assert.ok(src.includes('Un profesional no es una cuenta de usuario'), 'a professional is not a login');
});

test('Servicios: the tab reads, «Servicios que realiza» edits with one explicit save (f58)', () => {
  const svc = read(SERVICES);
  assert.ok(svc.includes('export function StaffServicesList(') && svc.includes('export function StaffServicesEditor('), 'list + panel');
  assert.ok(svc.includes('name="staff-services"') && svc.includes('dirty={dirty}'), 'a guarded side panel');
  assert.ok(svc.includes('Seleccionar todos') && svc.includes('Quitar todos'), 'per-category bulk choice');
  assert.ok(svc.includes('sus citas ya reservadas no cambian'), 'removing a service never touches a booking');
});

test('finding C: Horario keeps its draft — a tab change asks «Seguir editando / Descartar cambios»', () => {
  const src = read(TAB);
  assert.ok(src.includes('const requestTab = (t: DetailTab) => {') && src.includes('if (editorDirty) setTabAsk(t);'), 'a dirty editor stops the tab change');
  assert.ok(src.includes('onClick={() => requestTab(t)}'), 'every tab goes through it');
  assert.ok(src.includes('onDirtyChange={reportHoursDirty}'), 'the weekly editor reports its draft');
  assert.ok(/\{tabAsk \? \(\s*<DiscardChanges/.test(src), 'the discard question');
  assert.ok(!/autosave|autoSave/.test(src), 'no silent autosave');
});

test('the icon set is neutral — scheduling does not import from contacts', () => {
  const src = read(TAB);
  assert.ok(!/from "@\/components\/contacts/.test(src), 'the roster imports no contacts module');
  assert.ok(read('web/components/ui/icons.tsx').includes('export const IconPencil'), 'the glyphs live in ui/icons');
});

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * SOURCE CONTRACT: the roster wears the CONTACTS layout.
 *
 * Staff and Contacts are the product's two list-with-a-detail-panel screens, and they
 * had independently invented every part of that shape. Contacts settled it — three
 * cards floating on the canvas, a title band that says WHAT you are looking at over a
 * control band that says what you can DO, and the detail panel as a real column rather
 * than an overlay hovering over a hand-reserved lane. Staff now renders the same shape
 * from the same components.
 *
 * These assertions are about GEOMETRY, not copy. Nothing on the roster was added,
 * removed or renamed: the same title, tabs, search, three facets, presence counts,
 * column headers, rows, detail tabs and actions are all still there. What changed is
 * which box each one sits in — so what has to be pinned is that the boxes keep coming
 * from the shared components instead of drifting back into local class strings.
 */
const read = (rel: string): string => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');
const existsSyncWeb = (rel: string): boolean =>
  existsSync(fileURLToPath(new URL(`../../web/${rel}`, import.meta.url)));
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '').replace(/^\s*\/\/.*$/gm, '');

const TAB = 'web/components/scheduling/staff/StaffTab.tsx';
const HEADER = 'web/components/scheduling/staff/StaffHeaderCard.tsx';
const WORKSPACE = 'web/components/scheduling/staff/StaffWorkspace.tsx';
const CONTACTS = 'web/app/clients/[clientId]/contacts/page.tsx';

test('every roster card is a PageShell — no screen draws its own card twice', () => {
  for (const rel of [TAB, HEADER, WORKSPACE]) {
    const src = stripComments(read(rel));
    // The two hand-rolled frames this replaced. `rounded-2xl` on a `--line-strong`
    // hairline was a second card language living next to PageShell's 12px/--line one.
    assert.ok(!src.includes('rounded-2xl border border-line-strong'), `${rel}: no hand-rolled header card`);
    assert.ok(!src.includes('rounded-table border border-line-strong bg-surface'), `${rel}: no hand-rolled table card`);
  }
  assert.ok(read(HEADER).includes('<ModuleHeader'), 'the roster delegates to the shared header');
  assert.ok(read('web/components/ui/ModuleHeader.tsx').includes('<PageShell grow={false} clip={false}'), 'the header card sizes to its content');
  // The roster card GROWS (grow defaults to true) so the white surface continues under the
  // last row. It opts OUT of clipping because the filter row above the columns hosts the
  // Service / Site popovers, and a card's overflow-hidden cuts an absolutely-positioned
  // menu off at its edge — the same reason Contacts' table card does.
  assert.ok(/<PageShell clip=\{false\}>/.test(read(TAB)), 'the roster card absorbs the leftover height');
  assert.equal(/<PageShell grow=\{false\}[^>]*>\s*\{\/\* The column header/.test(read(TAB)), false, 'and is not pinned to its content');
});

test('the roster is ONE table (redesign E1) and never reserves a side lane', () => {
  const src = stripComments(read(TAB));
  assert.ok(!src.includes('lg:pr-[452px]'), 'no hand-reserved drawer lane');
  assert.ok(src.includes('<table className="w-full table-fixed'), 'one row per professional');
  for (const col of ['Profesional', 'Rol', 'Ahora', 'Citas hoy', 'Horas', 'Servicios', 'Horario']) {
    assert.ok(src.includes(`>${col}</th>`), `column ${col}`);
  }
  // Presence in WORDS (with a dot), the day's load as secondary data, and «Agenda» opens
  // the calendar filtered to that person.
  assert.ok(src.includes('presenceChip(d.key, d.appts, now)'), 'presence is text');
  assert.ok(src.includes('scheduling/agenda?staff=${member.id}'), '«Agenda» opens the filtered calendar');
  assert.equal(src.includes('function StaffCard('), false, 'the card grid is gone, not left dead');
});

test('the ficha is its OWN screen: it replaces the list in the same surface', () => {
  const src = stripComments(read(TAB));
  assert.equal(src.match(/<StaffDetail/g)?.length, 1, 'rendered exactly once');
  assert.ok(src.includes('if (selected) {'), 'selecting a professional swaps the surface');
  assert.equal(src.includes('className={OVERLAY_SCRIM}'), false, 'no scrim: it is not an overlay any more');
  assert.equal(src.includes('pointer-events-none fixed inset-0 z-50'), false, 'and nothing floats over the list');
  assert.ok(src.includes('aria-label="Ruta"') && src.includes('href={closeHref}'), 'a breadcrumb goes back to Equipo');
});

test("the ficha's frame is PageShell's, class for class", () => {
  const src = read(TAB);
  assert.ok(src.includes('rounded-xl border border-line bg-surface shadow-[var(--shadow-card)]'), 'the same card as the rest of the screen');
  assert.ok(!src.includes('sm:rounded-2xl'), 'not a second radius');
  const shell = read('web/components/ui/PageShell.tsx');
  for (const cls of ['rounded-xl', 'border-line', 'shadow-[var(--shadow-card)]']) {
    assert.ok(shell.includes(cls), `PageShell still owns ${cls} — the ficha is copying a live definition`);
  }
});

test('the detail panel is three zones: fixed header, FIXED tabs, one scrolling body', () => {
  const src = stripComments(read(TAB));
  // The strip stays outside the body scroll. On a phone it may scroll HORIZONTALLY,
  // otherwise five tabs are clipped beyond the right edge and cannot be reached.
  assert.ok(
    src.includes('flex shrink-0 items-center gap-3.5 overflow-x-auto border-b border-line'),
    'the fixed tab strip remains reachable on a phone',
  );
  assert.ok(src.includes('flex min-w-max items-center gap-3.5'), 'all five tabs keep their touch width');
  // Exactly ONE scrolling zone in the panel, and it resets on a tab change.
  assert.ok(src.includes('<div key={tab} className="min-h-0 flex-1 overflow-y-auto'), 'one body, reset per tab');
  assert.ok(!/overflow-y-auto[^"]*">\s*<div className="flex items-center gap-3.5 border-b/.test(src), 'tabs are not inside it');
});

test('the presence counts are CLICKABLE facet pills in the title band, from one primitive', () => {
  const src = stripComments(read(TAB));
  // They used to be a local `Legend` pushed to the right of the FILTER row — a smaller,
  // dimmer near-copy of the counters Contacts puts on the title line.
  assert.ok(!src.includes('function Legend('), 'the near-copy is gone, not left dead');
  // …then read-only `SummaryBit` counters above a `Status ▾` dropdown offering the SAME
  // three buckets: the screen stated a number and made you open a menu to act on it. The
  // counters are now the control, as Contacts' are.
  assert.ok(src.includes('<FacetPills'), 'the roster counts through the shared pills');
  assert.ok(src.includes('onPick={'), 'in client-side mode, since the roster is fully loaded');
  for (const bucket of ['with_client', 'available', 'off_today']) {
    assert.ok(src.includes(`key: "${bucket}"`), `${bucket} is a pill`);
  }
  // …and the dropdown that duplicated them is gone, so one filter cannot show two states.
  assert.equal(/label="Status"/.test(src), false, 'the duplicate Status dropdown is gone');
  // Counts must be over the WHOLE roster, never the filtered view, or clicking a pill
  // would change the numbers beside it.
  // (Counted by the shared rosterFacetCounts — presence.ts — so the phone agrees.)
  assert.ok(src.includes('rosterFacetCounts(props.members.map('), 'counts come from the full roster');
  assert.equal(/counts = filtered\./.test(src), false, 'never from the filtered list');
  // ONE definition, shared. Contacts must not have kept a private copy.
  const primitives = read('web/components/ui/primitives.tsx');
  assert.ok(primitives.includes('export function FacetPills('), 'FacetPills is a shared primitive');
  assert.ok(!stripComments(read(CONTACTS)).includes('function FacetPills('), 'Contacts does not redeclare it');
  // Contacts USED to mirror these pills; the CRM toolbar consolidation later folded its
  // stage/owner facets into the Filtrar menu, so Contacts no longer renders FacetPills.
  // The staff roster keeps them because presence is a small fixed set worth one click.
  assert.ok(!stripComments(read(CONTACTS)).includes('<FacetPills'), 'Contacts moved its facets into the Filtrar menu');
});

test('the primary action sits in the control band, and the roster keeps its dashed row', () => {
  const src = stripComments(read(TAB));
  // Contacts puts "Nuevo contacto" at the right of the controls; the title band is
  // status only. Staff had it on the title line.
  // The SHARED toolbar primary, at the far right — not a hand-rolled brand button at a
  // hard-coded height.
  assert.ok(src.includes('className={TOOLBAR_PRIMARY_CLS}'), 'primary action uses the shared black control');
  assert.ok(src.includes('actions={'), 'primary action occupies the header action slot');
  assert.ok(read('web/components/ui/ModuleHeader.tsx').includes('ml-auto flex shrink-0'), 'the shared action slot is pushed right');
  assert.ok(
    read('web/components/contacts/form/NewContactButton.tsx').includes('TOOLBAR_PRIMARY_CLS'),
    'and Contacts spends the same one',
  );
  assert.ok(!stripComments(read(WORKSPACE)).includes('Añadir profesional'), 'the workspace no longer owns the button');
  // BOTH entry points survive — the dashed row is the "next empty row" of the list.
  // Spanish now, like the rest of the CRM surfaces.
  // «profesional», the phone's word for the people on this screen (not «miembro»).
  assert.equal(src.match(/\+ Nuevo profesional/g)?.length, 1, 'one compact toolbar primary');
  assert.equal(src.match(/\+ Añadir profesional/g)?.length, 1, 'and one dashed add row');
  assert.equal(src.match(/setCreating\(true\)/g)?.length, 2, 'and both open the same dialog');
  // The counter-and-effect handshake the moved button replaced.
  assert.ok(!src.includes('openCreate'), 'no counter prop, and so no setState in an effect');
});

test('the roster still shows everything it showed before', () => {
  const src = read(TAB);
  // SPANISH labels — the roster joined the rest of the CRM surfaces. The FACTS are what
  // this case protects: every column and every presence bucket still shown.
  for (const label of [
    'Servicios',
    'Hoy',
    'Ver perfil',
    'Buscar por nombre, servicio o sede',
    'Con cliente',
    'En turno',
    'Fuera',
  ]) {
    assert.ok(src.includes(label), `${label} survived the re-layout`);
  }
  // `Status` is no longer a dropdown — its buckets are the counted pills asserted above,
  // and keeping both would let one filter show two active states. Service and Site stay:
  // neither is expressible as a small fixed set of counted pills.
  for (const facet of ['Servicio', 'Sede']) assert.ok(src.includes(`label="${facet}"`), `${facet} facet kept`);
  assert.equal(/label="Status"/.test(src), false, 'Status became the pills, not a second control');
  // THE TAB STRIP IS GONE, and that is a removal rather than a move. Two of its three
  // tabs were stubs rendering "Coming soon": Turnos needs a published-rota model (a barber
  // has weekly `working_hours` today, not shifts) and Ausencias needs a request-and-approval
  // flow on top of `schedule_exceptions`, which stores blocked time with no requester,
  // state or decision. A tab that opens an empty panel spends a click to say the feature
  // does not exist; the absence says it better.
  const ws = read(WORKSPACE);
  // Checked against the CODE, not the comments: the doc block above the component explains
  // what was removed and names the stubs, so a raw substring search finds its own
  // explanation and fails.
  const wsCode = stripComments(ws);
  assert.equal(/role="tablist"/.test(wsCode), false, 'no tab strip on the roster screen');
  for (const stub of ['Turnos', 'Ausencias', 'Coming soon']) {
    assert.equal(wsCode.includes(stub), false, `${stub} is gone, not hidden`);
  }
  // …and dropping it made this a SERVER component: the active tab was its only state.
  assert.equal(/^"use client"/.test(ws), false, 'the workspace no longer needs to be a client component');
  assert.equal(/useState/.test(ws), false, 'because it holds no state');
  // The screen still names itself — as a real heading, since there is no active tab to
  // carry the name any more.
  assert.ok(ws.includes('title: "Equipo"'), 'the screen keeps its title — in Spanish, as the nav names it');
  assert.ok(read(HEADER).includes('<ModuleHeader'), 'and it uses the shared module header');
  assert.ok(read('web/components/ui/ModuleHeader.tsx').includes('<PageHeading'), 'the shared header renders a real h1');
  assert.equal(/sr-only/.test(read(HEADER)), false, 'a visible one');
  // THE COUNT LEFT THE TITLE BAND, and the scope line with it — the title row is now one
  // clean line (name, search, primary) like Contacts'. Neither fact is lost: the number is
  // the "Todos N" facet pill in the list card, one row down and clickable, and the client
  // is named by the breadcrumb on every screen.
  assert.equal(/count:/.test(ws), false, 'no count chip on the title');
  assert.equal(/context:/.test(ws), false, 'and no scope line');
  assert.ok(read(TAB).includes('count: props.members.length'), 'the number is the "Todos" pill instead');
});

/**
 * THE INTERIOR. Matching the three cards was not enough — the panels still "felt
 * different" because the roster's body was a padded stack of individually bordered cards
 * while every other panel in the app is one surface divided by hairlines, and because the
 * roster's header was an action bar (a red button beside the name) where the contact
 * panel's is an introduction with the actions in a row below it.
 */
const PRIMITIVES = 'web/components/ui/primitives.tsx';

test('the panel body is hairline sections, not a stack of bordered cards', () => {
  const src = stripComments(read(TAB));
  // Every tab routes through the SHARED section, so none of them can drift.
  assert.ok(src.includes('<PanelSection'), 'the panel uses the shared section');
  assert.ok(/import \{\s*IconAssign,/.test(src), 'and the shared icon set');
  // The padded-stack-of-cards signature. `rounded-xl border border-line` inside a panel
  // that is itself a rounded-xl bordered card is the double frame.
  assert.equal(
    /className="flex flex-col gap-2\.5 rounded-xl border border-line p-3"/.test(src),
    false,
    'the sparkline is no longer its own bordered card',
  );
  assert.equal(/grid grid-cols-2 gap-2\.5/.test(src), false, 'the KPIs are no longer four floating tiles');
  // Every section heading carries an icon — all of them or none, the rule the contact
  // panel already holds to.
  const sections = src.match(/<(PanelSection|DetailSection)\b/g)?.length ?? 0;
  const icons = src.match(/icon=\{</g)?.length ?? 0;
  assert.ok(sections >= 8, `every tab is sectioned (${sections})`);
  assert.equal(icons, sections, `every section heading carries an icon (${icons}/${sections})`);
  // DetailSection draws the shared heading rather than a bare u-th line.
  assert.ok(src.includes('<SectionHeading title={title} icon={icon}'), 'DetailSection composes the shared heading');
  assert.equal(/<h3 className="u-th px-4/.test(src), false, 'and no longer hand-rolls one');
});

test('the metric strip is ONE divided box on both screens, from one primitive', () => {
  const primitives = read(PRIMITIVES);
  assert.ok(primitives.includes('export function MetricBox'), 'MetricBox is a shared primitive');
  assert.ok(primitives.includes('export function MetricCell'), 'so is the cell');
  // The ROSTER composes it — its four KPIs. The contact panel no longer does: its
  // CITAS / ÚLTIMA / CANAL strip is gone (the artboard has none, and each of the three was
  // restated within 200px of it — see the contacts contract). The primitive stays because
  // the roster genuinely uses it, not "in case".
  assert.ok(stripComments(read(TAB)).includes('<MetricBox'), `${TAB} composes MetricBox`);
  assert.equal(
    /<MetricBox/.test(stripComments(read('web/components/contacts/shared/ContactHeaderBlock.tsx'))),
    false,
    'the contact header no longer carries a metric strip',
  );
  // Wherever it IS used, there must be exactly one definition — the panel kept a private
  // MetricCell before this.
  const defs = ['web/components/contacts/shared/ContactHeaderBlock.tsx', TAB].filter((rel) =>
    /function MetricCell\(/.test(read(rel)),
  );
  assert.deepEqual(defs, [], `MetricCell is defined only in the primitives, found: ${defs.join(', ')}`);
});

test("the ficha header introduces the person, then two actions", () => {
  const src = stripComments(read(TAB));
  assert.ok(src.includes('text-[22px] font-semibold'), 'the name is the screen title');
  assert.ok(src.includes('avatarColor(member.name)'), 'the same avatar seed as everywhere');
  // Presence in words, where the schedule comes from, and how many services — the facts
  // a receptionist reads before opening a tab.
  assert.ok(src.includes('presenceChip(status.key, status.appts, now)'), 'presence in words');
  assert.ok(src.includes('"Usa el horario de la sede" : "Horario propio"'), 'inherited vs own is stated');
  // «Editar perfil» opens the Perfil TAB — still the one write path — and «Ver su agenda»
  // is the primary.
  assert.ok(src.includes('onClick={() => setTab("details")}'), 'Editar perfil is the Perfil tab, not a second editor');
  assert.ok(src.includes('className={ACT_PRIMARY}') && src.includes('Ver su agenda'), 'primary: the filtered agenda');
});

test('the icon set is neutral — scheduling does not import from contacts', () => {
  const src = read(TAB);
  assert.ok(!/from "@\/components\/contacts/.test(src), 'the roster imports no contacts module');
  assert.ok(read('web/components/ui/icons.tsx').includes('export const IconPencil'), 'the glyphs live in ui/icons');
  assert.ok(
    read('web/components/contacts/form/formPrimitives.tsx').includes('from "@/components/ui/icons"'),
    'and the contact form re-exports them rather than keeping a second set',
  );
});

/**
 * THE EDITOR. It was a centred modal on a dark scrim floating over the middle of the
 * screen — the exact arrangement the contact editor was deliberately moved away from.
 */
const DRAWER = 'web/components/scheduling/staff/StaffCreateDrawer.tsx';

test('there is ONE write path per field: the panel\'s tabs, no Edit button', () => {
  const tab = stripComments(read(TAB));
  // The Edit button is gone, and so is every route back into an edit form. It implied a
  // SECOND owner for the same columns — the drawer wrote name/services/hours/flags while
  // the tabs wrote the profile, and whichever saved last won.
  assert.equal(/onEdit/.test(tab), false, 'no onEdit prop threaded anywhere');
  assert.equal(/Change services/.test(tab), false, 'and no link out of the Services tab');
  assert.equal(tab.includes('<IconPencil'), false, 'no pencil affordance in the header');
  assert.equal(/const \[editing, setEditing\]/.test(tab), false, 'and no editing state to hold a member');

  // Every field the old editor owned now lives in the panel's own draft, so one Save
  // writes the whole person.
  for (const key of ['name', 'takesBookings', 'active']) {
    assert.ok(new RegExp(`^\\s+${key}:`, 'm').test(tab), `${key} is in the panel's ProfileDraft`);
  }
  assert.ok(tab.includes('value={profile.name}'), 'the Name field is bound to the draft');
  assert.ok(tab.includes('checked={profile.takesBookings}'), 'and so are the flags');
  // An empty name is refused before the round trip, and never stored as absent.
  assert.ok(tab.includes("if (d.name.trim() === \"\") return \"El nombre es obligatorio.\";"), 'name is validated');
  assert.ok(tab.includes('out.name = d.name.trim()'), 'and never nulled');

  // SERVICES: search, groups, «Seleccionar todos» and ONE explicit save (redesign Q3);
  // each pairing still goes through setStaffServiceAction.
  const svc = stripComments(read('web/components/scheduling/staff/StaffServicesEditor.tsx'));
  assert.ok(tab.includes('<StaffServicesEditor'), 'the Services tab is the assignment editor');
  assert.ok(svc.includes('Seleccionar todos') && svc.includes('Guardar servicios'), 'select all + explicit save');
  assert.ok(svc.includes('setStaffServiceAction(props.clientId, props.staffId, id, true)') && svc.includes('setStaffServiceAction(props.clientId, props.staffId, id, false)'), 'and it writes each pairing');
});

test('the CREATE panel is create-only and uses the agenda side panel', () => {
  const src = stripComments(read(DRAWER));
  for (const use of ['member?.', 'member.', '{member', 'member ?', 'member:', 'member !==']) {
    assert.equal(src.includes(use), false, `the panel knows nothing about an existing member (${use})`);
  }
  assert.ok(src.includes('export function StaffCreateDrawer'), 'and says so in its name');
  assert.equal(existsSyncWeb('components/scheduling/staff/StaffEditDialog.tsx'), false, 'no dead modal');
  assert.equal(existsSyncWeb('components/scheduling/staff/StaffEditDrawer.tsx'), false, 'and no dead edit drawer');
  // One create call with the service set, then the fields create does not take.
  assert.ok(src.includes('createStaffAction({ clientId, siteId: site, name: name.trim(), serviceIds })'), 'the same create call');
  assert.ok(src.includes('updateStaffAction(clientId, r.id, patch)'), 'and the profile patch after it');
  assert.equal(src.includes('setStaffServiceAction'), false, 'create takes the service set in one go');
  // The shared 520 px side panel (no scrim, guarded close, pinned actions).
  assert.ok(src.includes('<SidePanel') && src.includes('dirty={dirty}'), 'the agenda side panel with its unsaved-changes guard');
  assert.ok(stripComments(read(TAB)).includes('{creating ?'), 'create state opens it independently');
  // A professional is not a login.
  assert.ok(src.includes('Usuarios y accesos'), 'access to the system is a separate decision');
});

test('one control band vocabulary — the roster and Contacts share the pills', () => {
  const primitives = read(PRIMITIVES);
  // All three controls in the band take the SAME radius. The facets used to be
  // rounded-md while the search and the primary were rounded-lg, which is the kind of
  // one-step mismatch that reads as sloppiness rather than as a choice.
  for (const cls of ['TOOLBAR_PRIMARY_CLS', 'CONTROL_CLS']) {
    const decl = primitives.slice(primitives.indexOf(`export const ${cls} =`));
    assert.ok(/rounded-lg/.test(decl.slice(0, 400)), `${cls} is rounded-lg`);
    assert.ok(/h-\[var\(--control-h\)\]/.test(decl.slice(0, 400)), `${cls} is control height`);
  }
  const moduleSearch = primitives.slice(primitives.indexOf('export const MODULE_SEARCH_CLS ='));
  assert.ok(/rounded-\[9px\]/.test(moduleSearch.slice(0, 400)), 'module search matches Agenda radius');
  assert.ok(/h-\[34px\]/.test(moduleSearch.slice(0, 400)), 'module search matches Agenda height');
  // And both screens read them from there rather than re-typing a box.
  for (const rel of [TAB, 'web/components/contacts/ContactsToolbar.tsx']) {
    assert.ok(read(rel).includes('MODULE_SEARCH_CLS'), `${rel} uses the shared module-header search shell`);
  }
  assert.equal(/h-9 min-w-0 max-w-\[280px\][^"]*rounded-md/.test(read(TAB)), false, 'the roster no longer rolls its own');
});

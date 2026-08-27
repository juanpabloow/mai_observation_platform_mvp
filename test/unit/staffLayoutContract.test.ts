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
  assert.ok(read(HEADER).includes('<PageShell grow={false}>'), 'the header card sizes to its content');
  // The roster card GROWS (grow defaults to true) so the white surface continues under the
  // last row. It opts OUT of clipping because the filter row above the columns hosts the
  // Service / Site popovers, and a card's overflow-hidden cuts an absolutely-positioned
  // menu off at its edge — the same reason Contacts' table card does.
  assert.ok(/<PageShell clip=\{false\}>/.test(read(TAB)), 'the roster card absorbs the leftover height');
  assert.equal(/<PageShell grow=\{false\}[^>]*>\s*\{\/\* The column header/.test(read(TAB)), false, 'and is not pinned to its content');
});

test('the roster is three sibling cards in a row, not a drawer over a reserved lane', () => {
  const src = stripComments(read(TAB));
  // The lane trick: the roster's right edge and the panel's left edge were two
  // independent numbers that had to be kept in step by hand.
  assert.ok(!src.includes('lg:pr-[452px]'), 'no hand-reserved drawer lane');
  // The SAME strings Contacts uses, gap included — a 16px gap here against Contacts'
  // 12px is exactly the kind of near-miss that reads as two screens.
  const contacts = stripComments(read(CONTACTS));
  for (const shape of ['flex min-h-0 flex-1 gap-3', 'flex min-h-0 min-w-0 flex-1 flex-col gap-3']) {
    assert.ok(src.includes(shape), `roster: ${shape}`);
    assert.ok(contacts.includes(shape), `contacts still defines the shape this copied: ${shape}`);
  }
});

test('the detail panel is ONE element with two geometries, sized from a token', () => {
  const src = stripComments(read(TAB));
  // Rendering it once per geometry would give the reader two independent copies of the
  // hours and profile drafts, and two focus traps.
  assert.equal(src.match(/<StaffDetail/g)?.length, 1, 'rendered exactly once');
  // A column from `lg` up, a fixed overlay below it — one wrapper, breakpoint-scoped.
  assert.ok(src.includes('fixed inset-0 z-50'), 'overlay geometry below lg');
  // `lg:relative` and not `lg:static`: in flow as a column AND the positioning context
  // the EDITOR anchors to, which is what lets the editor land on the exact same box.
  assert.ok(src.includes('lg:relative'), 'and an in-flow column from lg up');
  assert.equal(src.includes('lg:static'), false, 'not static — the editor needs a context to anchor to');
  // The width must be a CLASS reading a token, not an inline style: an inline style
  // cannot be breakpoint-scoped, which is the whole reason one element can do both.
  assert.ok(src.includes('lg:w-[var(--staff-panel-w)]'), 'width comes from a token, in a class');
  assert.ok(read('web/app/globals.css').includes('--staff-panel-w:'), 'and the token is defined');
  // The scrim is overlay-only: beside the roster there is nothing to recede.
  assert.ok(/OVERLAY_SCRIM\}? lg:hidden/.test(src), 'the scrim only exists while overlaying');
});

test("the detail panel's frame is PageShell's, class for class", () => {
  const src = read(TAB);
  assert.ok(src.includes('lg:rounded-xl lg:border lg:border-line lg:shadow-[var(--shadow-card)]'), 'same card as its row');
  assert.ok(!src.includes('lg:rounded-2xl'), 'not a second radius');
  const shell = read('web/components/ui/PageShell.tsx');
  for (const cls of ['rounded-xl', 'border-line', 'shadow-[var(--shadow-card)]']) {
    assert.ok(shell.includes(cls), `PageShell still owns ${cls} — the panel is copying a live definition`);
  }
});

test('the detail panel is three zones: fixed header, FIXED tabs, one scrolling body', () => {
  const src = stripComments(read(TAB));
  // The strip used to sit inside the scroll container, so scrolling the Hours grid
  // carried the tabs off the top of the panel.
  assert.ok(
    src.includes('flex shrink-0 items-center gap-3.5 border-b border-line px-4'),
    'the tab strip does not scroll',
  );
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
  assert.ok(src.includes('props.members.reduce'), 'counts come from the full roster');
  assert.equal(/counts = filtered\./.test(src), false, 'never from the filtered list');
  // ONE definition, shared. Contacts must not have kept a private copy.
  const primitives = read('web/components/ui/primitives.tsx');
  assert.ok(primitives.includes('export function FacetPills('), 'FacetPills is a shared primitive');
  assert.ok(!stripComments(read(CONTACTS)).includes('function FacetPills('), 'Contacts does not redeclare it');
  // Contacts no longer RENDERS SummaryBit, and that is the CRM rework rather than a
  // regression (docs/ui-redesign-crm-inbox.md §2.2): its five counters became segmented
  // FACET PILLS, where the number is a filter you click instead of a statistic you read
  // and then act on separately. The counts come from the same `summarizeContacts` call.
  const contactsSrc = read(CONTACTS);
  assert.ok(contactsSrc.includes('<FacetPills'), 'Contacts counts through the facet pills instead');
  assert.ok(
    contactsSrc.includes('count: summary.new') && contactsSrc.includes('count: summary.unassigned'),
    'and they are the same real counters, from the same summary',
  );
});

test('the primary action sits in the control band, and the roster keeps its dashed row', () => {
  const src = stripComments(read(TAB));
  // Contacts puts "Nuevo contacto" at the right of the controls; the title band is
  // status only. Staff had it on the title line.
  // The SHARED toolbar primary, at the far right — not a hand-rolled brand button at a
  // hard-coded height.
  assert.ok(src.includes('${TOOLBAR_PRIMARY_CLS}'), 'primary action, far right of the controls');
  assert.ok(src.includes('ml-auto'), 'pushed to the right');
  assert.ok(
    read('web/components/contacts/form/NewContactButton.tsx').includes('TOOLBAR_PRIMARY_CLS'),
    'and Contacts spends the same one',
  );
  assert.ok(!stripComments(read(WORKSPACE)).includes('Agregar miembro'), 'the workspace no longer owns the button');
  // BOTH entry points survive — the dashed row is the "next empty row" of the list.
  // Spanish now, like the rest of the CRM surfaces.
  assert.equal(src.match(/\+ Agregar miembro/g)?.length, 2, 'button and dashed row both kept');
  assert.equal(src.match(/setCreating\(true\)/g)?.length, 2, 'and both open the same dialog');
  // The counter-and-effect handshake the moved button replaced.
  assert.ok(!src.includes('openCreate'), 'no counter prop, and so no setState in an effect');
});

test('the roster still shows everything it showed before', () => {
  const src = read(TAB);
  // SPANISH labels — the roster joined the rest of the CRM surfaces. The FACTS are what
  // this case protects: every column and every presence bucket still shown.
  for (const label of [
    'Miembro',
    'Presencia',
    'Hoy',
    'Siguiente',
    'Buscar en el equipo',
    'Con cliente',
    'Disponibles',
    'Sin turno',
  ]) {
    assert.ok(src.includes(label), `${label} survived the re-layout`);
  }
  // `Status` is no longer a dropdown — its buckets are the counted pills asserted above,
  // and keeping both would let one filter show two active states. Service and Site stay:
  // neither is expressible as a small fixed set of counted pills.
  for (const facet of ['Service', 'Site']) assert.ok(src.includes(`label="${facet}"`), `${facet} facet kept`);
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
  assert.ok(ws.includes('title: "Equipo"'), 'the screen keeps its title');
  assert.ok(read(HEADER).includes('<h1'), 'and it is a heading, not a styled span');
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

test("the panel header is an introduction, not an action bar", () => {
  const src = stripComments(read(TAB));
  // Two lines (name + presence chip, then one meta line), the contact header's shape.
  assert.ok(src.includes('text-base font-semibold tracking-tight text-foreground'), 'the name matches the contact panel');
  assert.ok(src.includes('{headerMeta}'), 'one meta line under it');
  // The presence fact is a CHIP on the name line now, not a mono line below it.
  assert.ok(/rounded-full border border-line-strong bg-chip[^"]*uppercase/.test(src), 'presence reads as a chip');
  // The per-person wash, from the SAME tone helper the avatar hashes on — two seeds
  // would mean a teal disc on a purple header.
  assert.ok(src.includes('u-contact-wash'), 'the header carries the tone wash');
  // The discs became two-tone gradient SPHERES, so the wash fades the same PAIR — one
  // stop would let the header and the avatar above it disagree.
  assert.ok(src.includes('avatarToneStyle(member.name)'), 'and the tone is this person\'s own');
  assert.ok(src.includes('avatarColor(member.name)'), 'the same seed as the avatar');
  assert.equal(src.includes('bg-panel-hero'), false, 'no third fill inside a two-fill panel');
  // Actions in their OWN row, in the contact panel's proportion: primary takes the
  // leftover width, secondaries size to their labels.
  // The shared header-action primary, filling the row. There is no Edit button beside it
  // any more: see the single-write-path test below.
  assert.ok(src.includes('className={ACT_PRIMARY}'), 'primary fills the row');
  // ACT_PRIMARY is INK now, not brand red. The CRM rework spends red on the active nav
  // item, `Agendar cita`, and the "a human is handling this" marker, and nothing else —
  // see the note on --ink in globals.css. The PROPORTION this test is really about
  // (primary takes the leftover width, secondaries size to their labels) is unchanged.
  assert.ok(
    read('web/components/ui/panelChrome.tsx').includes(
      'inline-flex h-9 min-w-0 flex-1 items-center justify-center whitespace-nowrap rounded-lg bg-ink',
    ),
    'and ACT_PRIMARY is the proportion the roster uses',
  );
  // The quiet close control both panels share, in place of a bordered ✕ box. Scoped to
  // the CLOSE control: the inline ✕ that removes a skill chip or a time range is a
  // different affordance and keeps its own treatment.
  assert.ok(src.includes('-mr-1 shrink-0 rounded-md p-1 text-faint'), 'the close control is the quiet one');
  assert.equal(
    src.includes('inline-flex size-8 shrink-0 items-center justify-center rounded-md border border-line-strong'),
    false,
    'the bordered glyph box is gone',
  );
  assert.ok(
    stripComments(read('web/components/ui/panelChrome.tsx')).includes('-mr-1 shrink-0 rounded-md p-1 text-faint'),
    'and it is the shared PANEL_CLOSE_CLS, not a lookalike',
  );
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
  assert.ok(tab.includes("if (d.name.trim() === \"\") return \"A name is required.\";"), 'name is validated');
  assert.ok(tab.includes('out.name = d.name.trim()'), 'and never nulled');

  // SERVICES toggle in place. Per-pairing, so it writes immediately rather than joining
  // the unsaved bar — the same way adding a certification already worked.
  assert.ok(tab.includes('role="switch"'), 'the service row IS the control');
  assert.ok(tab.includes('setStaffServiceAction(clientId, member.id, sv.id, !on)'), 'and it toggles the pairing');
});

test('the CREATE drawer is create-only, and opens in the panel\'s own box', () => {
  const src = stripComments(read(DRAWER));
  // No edit branch left anywhere — that is what makes the single write path true rather
  // than merely intended.
  // The identifier, not the word — "Add staff member" is copy.
  for (const use of ['member?.', 'member.', '{member', 'member ?', 'member:', 'member !==']) {
    assert.equal(src.includes(use), false, `the drawer knows nothing about an existing member (${use})`);
  }
  assert.ok(src.includes('export function StaffCreateDrawer'), 'and says so in its name');
  assert.equal(existsSyncWeb('components/scheduling/staff/StaffEditDialog.tsx'), false, 'no dead modal');
  assert.equal(existsSyncWeb('components/scheduling/staff/StaffEditDrawer.tsx'), false, 'and no dead edit drawer');
  // It still writes exactly what create wrote: one call, then the hours patch.
  assert.ok(src.includes('createStaffAction({ clientId, siteId: target, name: trimmed, serviceIds })'), 'the same create call');
  assert.ok(src.includes('updateStaffAction(clientId, r.id, { workingHours })'), 'and the hours patch after it');
  assert.equal(src.includes('setStaffServiceAction'), false, 'create takes the service set in one go');

  // The modal's signature, gone: a viewport-centred flex box with a max-width card.
  assert.equal(/fixed inset-0[^"]*items-start justify-center/.test(src), false, 'nothing centres on the viewport');
  assert.equal(src.includes('max-w-md'), false, 'no floating fixed-width card');
  assert.equal(src.includes('bg-popover'), false, 'and it is not a popover surface');
  // It fills the panel REGION and takes its width from there, never its own.
  assert.ok(src.includes('lg:absolute lg:inset-y-0 lg:right-0'), 'it fills the panel region from lg up');
  assert.ok(src.includes('fixed inset-y-0 right-0'), 'and covers full-bleed below it');
  assert.equal(/w-\[var\(--staff-panel-w\)\]/.test(src), false, 'the drawer sets no width of its own');
  assert.ok(stripComments(read(TAB)).includes('lg:w-[var(--staff-panel-w)]'), 'the region owns the width');
  assert.ok(stripComments(read(TAB)).includes('{selected || creating ?'), 'the region opens for a selection OR a create');

  // A FORM: transparent catcher where it has a lane, focus trap, pinned save bar.
  assert.ok(src.includes('bg-black/40 lg:bg-transparent'), 'dark only while covering');
  assert.ok(src.includes('useTrappedPanel({ active: true'), 'a form always traps focus');
  assert.ok(src.includes('flex min-h-0 flex-1 flex-col overflow-y-auto bg-surface'), 'one scrolling body');
  assert.ok(src.includes('flex shrink-0 items-center gap-2 border-t border-line bg-surface'), 'a pinned save bar');
  assert.ok(src.includes('className={BTN_PRIMARY}') && src.includes('className={BTN_SECONDARY}'), 'the shared footer buttons');
  const sections = src.match(/<PanelSection/g)?.length ?? 0;
  const icons = src.match(/icon=\{</g)?.length ?? 0;
  assert.ok(sections >= 3, `the form is sectioned (${sections})`);
  assert.equal(icons, sections, `every section carries an icon (${icons}/${sections})`);
});

test('one control band vocabulary — the roster and Contacts share the pills', () => {
  const primitives = read(PRIMITIVES);
  // All three controls in the band take the SAME radius. The facets used to be
  // rounded-md while the search and the primary were rounded-lg, which is the kind of
  // one-step mismatch that reads as sloppiness rather than as a choice.
  for (const cls of ['SEARCH_SHELL_CLS', 'TOOLBAR_PRIMARY_CLS', 'CONTROL_CLS']) {
    const decl = primitives.slice(primitives.indexOf(`export const ${cls} =`));
    assert.ok(/rounded-lg/.test(decl.slice(0, 400)), `${cls} is rounded-lg`);
    assert.ok(/h-\[var\(--control-h\)\]/.test(decl.slice(0, 400)), `${cls} is control height`);
  }
  // And both screens read them from there rather than re-typing a box.
  for (const rel of [TAB, 'web/components/contacts/ContactsToolbar.tsx']) {
    assert.ok(read(rel).includes('SEARCH_SHELL_CLS'), `${rel} uses the shared search shell`);
  }
  assert.equal(/h-9 min-w-0 max-w-\[280px\][^"]*rounded-md/.test(read(TAB)), false, 'the roster no longer rolls its own');
});

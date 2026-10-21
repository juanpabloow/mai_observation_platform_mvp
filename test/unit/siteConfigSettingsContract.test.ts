import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * SOURCE-LEVEL CONTRACT (no HTTP/DB): the config-only booking rules (min notice, booking
 * horizon, slot granularity) are now VISIBLE + EDITABLE on the site form, and the C-6 "Why
 * is nothing available?" panel names minimum notice (it used to silently swallow the first
 * N minutes). Data-layer behaviour is proven in test/integration/minNoticeSetting.test.ts.
 */

const web = (rel: string): string => readFileSync(fileURLToPath(new URL(`../../web/${rel}`, import.meta.url)), 'utf8');

test('the settings loader passes scheduling_config to the panel', () => {
  assert.ok(web('lib/schedulingSettingsData.ts').includes('scheduling_config: s.scheduling_config'), 'site mapping includes scheduling_config');
});

test('EditableSite shows + edits min notice, booking horizon and slot granularity in Spanish', () => {
  const src = web('components/scheduling/AdminPanel.tsx');
  assert.ok(src.includes('Anticipación mínima (min)'), 'min notice input');
  assert.ok(src.includes('Días disponibles hacia adelante'), 'booking horizon input');
  assert.ok(src.includes('Intervalo entre horarios (min)'), 'slot granularity input');
  // Save threads the edited values back through updateSiteAction (merged over existing).
  assert.ok(/schedulingConfig:\s*\{[\s\S]*min_notice_min:\s*Number\(minNotice\)/.test(src), 'save sends schedulingConfig.min_notice_min');
  assert.ok(src.includes('...site.scheduling_config'), 'existing buffers preserved on save');
});

test('the availability diagnostic names minimum notice', () => {
  const src = web('components/scheduling/AdminPanel.tsx');
  // The diagnostic is a card of findings now; the notice line is one of them.
  assert.ok(src.includes('de anticipación mínima'), 'panel shows a minimum notice line');
  assert.ok(src.includes('min_notice_min'), 'read from the site config, not hardcoded');
  assert.ok(src.includes('días de horizonte · cupos cada'), 'and states the horizon and interval beside it');
  // Amber vs green per row: which of the reasons is actually the blocking one.
  assert.ok(src.includes('finding.ok ? "bg-success" : "bg-warn-rule"'), 'each finding says whether it is the problem');
});

test('settings are task-oriented: one PAGE per job, no tabs inside a page (design B)', () => {
  const src = web('components/scheduling/AdminPanel.tsx');
  for (const [page, title] of [
    ['sites', 'Sedes'], ['rules', 'Reglas de reserva'], ['hours', 'Horarios y ausencias'],
    ['services', 'Servicios'], ['promotions', 'Promociones'], ['"booking-page"', 'Página de reservas'],
  ]) {
    assert.ok(src.includes(`  ${page}: { title: "${title}"`), `${title} is its own page`);
  }
  // The production header card of «Configuración de agenda», titled by the page's job —
  // without its tab row: the sidebar is the only menu (no tabs on top of it).
  assert.ok(src.includes('<h1 className="truncate text-xl font-semibold tracking-[-0.025em] text-foreground">{meta.title}</h1>'), 'each page is titled by its job, in Spanish');
  assert.ok(!src.includes('SETTINGS_TABS') && !src.includes('aria-label="Secciones de configuración"'), 'no tab row duplicating the sidebar');
  assert.ok(!src.includes('role="tablist"'), 'no tab strip inside a settings page');
  // Horarios y ausencias holds the production Bloqueos list as its «Ausencias» section.
  assert.ok(src.includes('<div id={ABSENCES_ANCHOR} className="scroll-mt-4">'), 'Ausencias is a section of Horarios y ausencias');
  // SEDES edit in place (the reference's list + detail on one surface), saying when there
  // is something unsaved; SERVICES edit in a wide editor OVER the menu, so a hundred-row
  // catalogue never unfolds a form inside the list.
  assert.ok(src.includes('Cambios sin guardar'), 'the site editor says when there is something to save');
  assert.ok(src.includes('<ServiceMenu'), 'the Servicios tab is the services menu');
  const editor = web('components/scheduling/services/ServiceEditor.tsx');
  // The editor is edited IN the Servicios surface (module redesign): it replaces the list
  // while it is open, and the list stays mounted (hidden) so closing returns to the same
  // scroll position and filters.
  const menuSrc = web('components/scheduling/services/ServiceMenu.tsx');
  assert.ok(editor.includes('<EditorFrame') && editor.includes('<EditorHeader'), 'the service editor is the shared in-page editor frame');
  assert.ok(menuSrc.includes('hidden={Boolean(editor)}'), 'the list stays mounted while the editor is open');
});

test('every settings form opens over the page, never fixed into a tab', () => {
  const src = web('components/scheduling/AdminPanel.tsx');
  assert.ok(src.includes('function ConfigModal('), 'there is one modal primitive');
  assert.ok(src.includes('title="Nuevo bloqueo"'), 'Nuevo bloqueo is created in a modal');
  // A new SITE is created in the Sedes screen's in-page editor (module redesign), like a
  // service: the shared editor frame, never a form inside a tab.
  const sites = web('components/scheduling/settings/SitesScreen.tsx');
  assert.ok(sites.includes('function SiteEditor(') && sites.includes('<EditorFrame') && sites.includes('"Nueva sede"'), 'Nueva sede is the in-page site editor');
  assert.equal(src.match(/<ConfigModal/g)?.length, 1, 'no settings form escapes the modal primitive');
  const menu = web('components/scheduling/services/ServiceMenu.tsx');
  assert.equal(menu.match(/<ServiceEditor/g)?.length, 1, 'one editor serves both create and edit');
  // The editor asks before discarding, and archiving (never deleting) preserves history.
  const editorSrc = web('components/scheduling/services/ServiceEditor.tsx');
  assert.ok(editorSrc.includes('useEditorGuard(') && editorSrc.includes('<DiscardChanges'), 'unsaved changes are protected');
  assert.ok(web('components/ui/module/ConfirmLayer.tsx').includes('¿Descartar los cambios?'), 'with the one discard question');
  assert.ok(menu.includes('deactivateServiceAction') && !/delete.*Service|eliminar permanentemente/i.test(menu), 'archive, never permanent delete');
});

test('touch targets reach 44px below lg while desktop keeps the compact 34-36px', () => {
  const src = web('components/scheduling/AdminPanel.tsx');
  for (const token of ['h-[44px] lg:h-[36px]', 'h-[44px] lg:h-[34px]']) {
    assert.ok(src.includes(token), `${token} control height is responsive`);
  }
  // PX, not rem: the app's root font-size is 14.4px, so Tailwind's h-11/h-9 rem steps
  // silently render 39.6px/32.4px and miss the spec. Guard against a well-meaning
  // "tidy-up" back to the rem scale.
  // Space-prefixed only, so `min-h-11` (a layout floor, not a control) and the
  // backticked mentions in the comment above the constants are not false positives.
  assert.ok(!/ h-11\b/.test(src), 'no rem-scale h-11 control — it is 39.6px here, not 44px');
  assert.ok(!/ h-9\b/.test(src), 'no rem-scale h-9 control — it is 32.4px here, not 36px');
});

test('blocks read soonest-first, in the timezone of the site they close', () => {
  const src = web('components/scheduling/AdminPanel.tsx');
  assert.ok(
    src.includes('[...exceptions].sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at))'),
    'the per-site fetches are re-ordered into one upcoming list',
  );
  // A block belongs to a site's wall clock; formatting it in the browser's zone showed
  // a Madrid closure at Bogotá times.
  assert.ok(src.includes('timeStyle: "short", timeZone }'), 'the formatter is given an explicit zone');
  assert.ok(src.includes('site?.timezone ?? "UTC"'), 'that zone comes from the block\'s own site');
});

test('updateSiteAction validates scheduling_config (a bad value cannot silently break availability)', () => {
  const src = web('lib/schedulingAdminActions.ts');
  assert.ok(src.includes('sanitizeSchedulingConfig('), 'config is sanitized before persistence');
  assert.ok(/booking_horizon_days[\s\S]*1, 365/.test(src) || src.includes('1, 365'), 'horizon is range-checked');
});

test('a failed save never creates the same service twice; retrying resumes from what was written', () => {
  // The BEHAVIOUR is proven in test/unit/serviceSave.test.ts (fake actions failing at each
  // step) and test/integration/serviceCreateAtomic.test.ts (the real transaction). Here:
  // the editor really uses that sequence, and the create really is the atomic one.
  const editor = web('components/scheduling/services/ServiceEditor.tsx');
  assert.ok(editor.includes('const out = await runServiceSave('), 'the editor saves through runServiceSave');
  assert.ok(editor.includes('const persisted = useRef<PersistedService>({'), 'it keeps what the server holds across attempts');
  assert.ok(editor.includes('onLeave: () => (savedAll.current || wrote.current ? onSaved() : onClose())'), 'a partial save is not hidden on close');
  const action = web('lib/schedulingAdminActions.ts');
  assert.ok(action.includes('svc = await createServiceWithSites('), 'createServiceAction is the transactional create');
  assert.ok(!/createService\(\{/.test(action), 'the non-atomic insert-then-link path is gone');
});

test('a service row does not clip its own ⋯ menu', () => {
  // The catalogue is an aligned table now (components/ui/module/ListTable). The row draws
  // no overflow clip, archived rows dim their TEXT (no opacity stacking trap), and the row
  // whose menu is open is lifted above its siblings.
  const table = web('components/ui/module/ListTable.tsx');
  const row = table.slice(table.indexOf('export function ListRow'), table.indexOf('export function ListFoot'));
  assert.ok(!row.includes('overflow-hidden'), 'the row has no overflow-hidden');
  assert.ok(!row.includes('opacity-'), 'dimming is text colour, not opacity');
  assert.ok(row.includes('raised ? "relative z-[3]" : ""'), 'the open row sits above its siblings');
  assert.ok(web('components/scheduling/services/ServiceMenu.tsx').includes('raised={menu === `t:${s.id}`}'), 'the menu lifts the row it opened');
});

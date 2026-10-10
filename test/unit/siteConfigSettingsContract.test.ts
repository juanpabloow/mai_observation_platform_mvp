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

test('admin page passes scheduling_config to the panel', () => {
  assert.ok(web('app/clients/[clientId]/scheduling/admin/page.tsx').includes('scheduling_config: s.scheduling_config'), 'site mapping includes scheduling_config');
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

test('settings are task-oriented and editors are progressively disclosed', () => {
  const src = web('components/scheduling/AdminPanel.tsx');
  for (const label of ['Resumen', 'Sedes y horarios', 'Servicios', 'Bloqueos', 'Reglas']) {
    assert.ok(src.includes(`label: "${label}"`), `${label} tab exists`);
  }
  assert.ok(src.includes('>Configuración de agenda</h1>'), 'the screen uses the clear Spanish name');
  assert.ok(src.includes('border-b-2') && src.includes('border-foreground text-foreground'), 'settings use compact underline tabs');
  // SEDES edit in place (the reference's list + detail on one surface); SERVICES edit
  // in a wide editor OVER the menu, so a hundred-row catalogue never unfolds a form inside the list.
  assert.ok(src.includes('aria-expanded={editing}'), 'the site editor is disclosed inside its detail pane');
  assert.ok(src.includes('<ServiceMenu'), 'the Servicios tab is the services menu');
  const editor = web('components/scheduling/services/ServiceEditor.tsx');
  assert.ok(editor.includes('role="dialog"') && editor.includes('fixed inset-0 z-50'), 'the service editor opens over the list');
});

test('every settings form opens over the page, never fixed into a tab', () => {
  const src = web('components/scheduling/AdminPanel.tsx');
  assert.ok(src.includes('function ConfigModal('), 'there is one modal primitive');
  for (const title of ['Nueva sede', 'Nuevo bloqueo']) {
    assert.ok(src.includes(`title="${title}"`), `${title} is created in a modal`);
  }
  // Two openings of the modal primitive (create site / create block); services create
  // AND edit in the wide ServiceEditor overlay. Neither renders a form into a tab.
  assert.equal(src.match(/<ConfigModal/g)?.length, 2, 'no settings form escapes the modal primitive');
  const menu = web('components/scheduling/services/ServiceMenu.tsx');
  assert.equal(menu.match(/<ServiceEditor/g)?.length, 1, 'one editor serves both create and edit');
  // The editor asks before discarding, and archiving (never deleting) preserves history.
  assert.ok(web('components/scheduling/services/ServiceEditor.tsx').includes('¿Descartar los cambios?'), 'unsaved changes are protected');
  assert.ok(menu.includes('deactivateServiceAction') && !/delete.*Service|eliminar permanentemente/i.test(menu), 'archive, never permanent delete');
});

test('touch targets reach 44px below lg while desktop keeps the compact 34-36px', () => {
  const src = web('components/scheduling/AdminPanel.tsx');
  for (const token of ['h-[44px] lg:h-[36px]', 'h-[44px] lg:h-[34px]', 'h-[44px] shrink-0 items-center gap-1.5 border-b-2']) {
    assert.ok(src.includes(token), `${token} control height is responsive`);
  }
  // PX, not rem: the app's root font-size is 14.4px, so Tailwind's h-11/h-9 rem steps
  // silently render 39.6px/32.4px and miss the spec. Guard against a well-meaning
  // "tidy-up" back to the rem scale.
  // Space-prefixed only, so `min-h-11` (a layout floor, not a control) and the
  // backticked mentions in the comment above the constants are not false positives.
  assert.ok(!/ h-11\b/.test(src), 'no rem-scale h-11 control — it is 39.6px here, not 44px');
  assert.ok(!/ h-9\b/.test(src), 'no rem-scale h-9 control — it is 32.4px here, not 36px');
  assert.ok(src.includes('overflow-x-auto'), 'the tab strip scrolls horizontally rather than wrapping');
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
  assert.ok(editor.includes('const leave = () => (wrote.current ? onSaved() : onClose());'), 'a partial save is not hidden on close');
  const action = web('lib/schedulingAdminActions.ts');
  assert.ok(action.includes('svc = await createServiceWithSites('), 'createServiceAction is the transactional create');
  assert.ok(!/createService\(\{/.test(action), 'the non-atomic insert-then-link path is gone');
});

test('a service card does not clip its own ⋯ menu', () => {
  const menu = web('components/scheduling/services/ServiceMenu.tsx');
  const card = menu.slice(menu.indexOf('function ServiceCard'), menu.indexOf('function CategoryButton'));
  const article = card.slice(card.indexOf('<article'), card.indexOf('>', card.indexOf('className={`group')));
  assert.ok(!article.includes('overflow-hidden'), 'the card has no overflow-hidden');
  assert.ok(!article.includes('opacity-75'), 'the archived dimming is on the content, not on the card (no stacking trap)');
  assert.ok(article.includes('menuOpen ? "z-10" : ""'), 'the open card sits above its siblings');
});

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve as resolvePath } from 'node:path';
import { buildDocumentTitle, pageForTitle } from '../../web/lib/documentTitle.js';
import { parseClientSurface } from '../../web/lib/clientSurface.js';

/**
 * Auditoría UI 2026-11-03, fase 3: cabeceras (F07), búsquedas (F08), lenguaje (F09/F18) y
 * controles táctiles (F05/F17). Where a component can be rendered outside Next (no server
 * actions, no router), it is RENDERED and read the way assistive tech reads it — names,
 * roles, states — instead of matching its source text.
 */
const web = fileURLToPath(new URL('../../web/', import.meta.url));
const read = (rel: string) => readFileSync(`${web}${rel}`, 'utf8');
const req = createRequire(pathToFileURL(resolvePath(web, 'package.json')));
const React = req('react') as typeof import('react');
const { renderToStaticMarkup } = req('react-dom/server') as typeof import('react-dom/server');
(globalThis as { React?: unknown }).React = React;
const h = React.createElement;

/** Visible text of rendered markup (tags dropped, entities left as they are). */
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
/** Every element's opening tag that carries `attr="value"`. */
const tagsWith = (html: string, attr: string, value: string) =>
  html.match(new RegExp(`<[a-z]+[^>]*\\b${attr}="${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>`, 'g')) ?? [];

test('one name for the workflows module: «Flujos» in rail, H1, breadcrumb and tab', () => {
  // The rail's built labels are asserted in sectionNav.test (labels.automations).
  assert.equal(parseClientSurface('/clients/c1/workflows')?.label, 'Flujos', 'breadcrumb');
  assert.equal(buildDocumentTitle(pageForTitle('/clients/c1/workflows').label, 'Gallery'), 'Flujos · Gallery · M_AI', 'tab');
  assert.ok(read('app/clients/[clientId]/workflows/page.tsx').includes('title="Flujos"'), 'H1');
  assert.ok(read('lib/sectionNav.ts').includes('{ id: "workflows", label: "Flujos", href: wf.executions }'), 'rail');
});

test('the workflows list: shared search with a name, Spanish status, approved empty states', async () => {
  const { ClientWorkflowsList } = await import('../../web/components/ClientWorkflowsList.js');
  const rows = [
    { n8nWorkflowId: 'wf-a', name: 'Bot de reservas', active: true },
    { n8nWorkflowId: 'wf-b', name: 'Recordatorios', active: false },
  ];
  const html = renderToStaticMarkup(h(ClientWorkflowsList, { clientId: 'c1', workflows: rows }));
  // The search is a labelled search field (the label is the accessible name, not a placeholder).
  const input = html.match(/<input[^>]*type="search"[^>]*>/)?.[0] ?? '';
  const id = input.match(/id="([^"]+)"/)?.[1];
  assert.ok(id && html.includes(`<label for="${id}" class="sr-only">Buscar flujos</label>`), 'search has an accessible name');
  assert.ok(!/Search|Active|Inactive|workflows/.test(text(html).replace(/wf-[ab]/g, '')), 'no English left on screen');
  assert.ok(text(html).includes('Activo') && text(html).includes('Inactivo'), 'status in Spanish');

  const empty = renderToStaticMarkup(h(ClientWorkflowsList, { clientId: 'c1', workflows: [] }));
  assert.ok(text(empty).includes('Todavía no hay flujos'), 'empty client state');
  assert.ok(!empty.includes('border-dashed'), 'the approved state, not a dashed box');
});

test('the header workflow switcher: a named combobox and Spanish options', async () => {
  const { WorkflowSwitcherPanel } = await import('../../web/components/WorkflowSwitcherPanel.js');
  const html = renderToStaticMarkup(
    h(WorkflowSwitcherPanel, {
      workflows: [{ id: 'wf1', name: 'Bot', active: true }, { id: 'wf2', name: 'Viejo', active: false }],
      current: 'all',
      onSelect: () => {},
      clientName: 'Gallery',
    } as never),
  );
  assert.equal(tagsWith(html, 'role', 'combobox').length, 1);
  assert.ok(tagsWith(html, 'aria-label', 'Buscar flujos').length === 1, 'the combobox is named');
  assert.ok(tagsWith(html, 'aria-label', 'Flujos').some((t) => t.includes('role="listbox"')), 'the listbox is named');
  assert.ok(text(html).includes('Todos los flujos') && text(html).includes('Activos') && text(html).includes('Inactivos'));
  assert.ok(text(html).includes('Flujos de Gallery'));
  assert.ok(!/All workflows|Search workflows|Active|Inactive/.test(text(html)), 'no English option or group');
});

test('compact icon controls answer to 44×44 on touch, coarse pointers included (F05)', () => {
  const css = read('app/globals.css');
  const block = css.slice(css.indexOf('@media (max-width: 1023.98px), (any-pointer: coarse) {\n  .u-tap::after'));
  assert.ok(block.startsWith('@media (max-width: 1023.98px), (any-pointer: coarse)'), 'width OR a coarse pointer — not width alone');
  assert.match(block.slice(0, 200), /width: max\(100%, 44px\);\s*height: max\(100%, 44px\);/);
  // The controls the audit measured carry it: the bar's menu button, the phone menu button,
  // the shared IconButton (36px from lg), the dashboard help and the payment arrows.
  assert.ok(read('components/HeaderBar.tsx').includes('className="u-tap inline-flex rounded-lg p-1.5 text-muted'));
  assert.ok(read('components/MobileMenuButton.tsx').includes('u-tap flex size-9'));
  assert.ok(read('components/ui/controls.tsx').includes('u-focus u-tap inline-flex size-[44px]'));
  assert.ok(read('components/value/ValueDashboard.tsx').includes('"u-focus u-tap"'));
  assert.ok(read('components/scheduling/PaymentMethodsPanel.tsx').includes('const MOVE = "u-focus u-tap inline-flex size-[44px]'));
});

test('a shared segmented control: each option keeps its name and pressed state, and the touch area', async () => {
  const { Segmented } = await import('../../web/components/ui/controls.js');
  const html = renderToStaticMarkup(
    h(Segmented, { label: 'Periodo', size: 'sm', value: 'week', options: [{ value: 'day', label: 'Día' }, { value: 'week', label: 'Semana' }], onChange: () => {} } as never),
  );
  assert.ok(tagsWith(html, 'role', 'group').some((t) => t.includes('aria-label="Periodo"')), 'a named group');
  assert.equal(tagsWith(html, 'aria-pressed', 'true').length, 1, 'one pressed option');
  assert.ok(tagsWith(html, 'aria-pressed', 'true')[0].includes('u-tap'), 'drawn inside the 4px shell padding, but answers to 44px');
});

test('the shared IconButton keeps its name and gains the touch area', async () => {
  const { IconButton } = await import('../../web/components/ui/controls.js');
  const html = renderToStaticMarkup(h(IconButton, { label: 'Cerrar', onClick: () => {} }, h('path', { d: 'M4 4l8 8' })));
  assert.ok(tagsWith(html, 'aria-label', 'Cerrar').length === 1);
  assert.ok(/class="[^"]*\bu-tap\b/.test(html));
  assert.ok(/class="[^"]*\bsize-\[44px\][^"]*\blg:size-\[36px\]/.test(html), 'desktop density unchanged');
});

test('the phone menu has a visible, named close and the scrim is not a second one (F17)', () => {
  const rail = read('components/AppSidebar.tsx');
  const drawer = rail.slice(rail.indexOf('MOBILE drawer'));
  assert.equal((drawer.match(/aria-label="Cerrar menú"/g) ?? []).length, 1, 'exactly one named close');
  assert.match(drawer, /<button\s+type="button"\s+onClick=\{\(\) => setMobileOpen\(false\)\}\s+aria-label="Cerrar menú"[\s\S]*?size-11/, 'inside the drawer, 44×44');
  assert.match(drawer, /aria-hidden\s+tabIndex=\{-1\}\s+onClick=\{\(\) => setMobileOpen\(false\)\}\s+className="fixed inset-0/, 'the scrim still closes on tap, hidden from AT');
  assert.ok(rail.includes('useTrappedPanel({ active: mobileOpen, onClose: () => setMobileOpen(false) })'), 'Escape + focus return stay');
  assert.ok(!rail.includes('Toggle sidebar') && !read('components/HeaderBar.tsx').includes('Open menu'), 'Spanish names');
});

test('Métodos de pago and Ocupación sit on the approved surface with one 24px title (F07)', () => {
  for (const [file, title] of [['components/scheduling/PaymentMethodsPanel.tsx', 'Métodos de pago'], ['components/scheduling/OccupancyPanel.tsx', 'Ocupación']]) {
    const src = read(file);
    assert.ok(src.includes(`<ModuleSurface label="${title}">`), `${title}: one surface`);
    assert.ok(src.includes(`title="${title}"`) && src.includes('<SurfaceHeader'), `${title}: the shared title band (u-page-title)`);
    assert.ok(!src.includes('<PageShell'), `${title}: no card-in-card`);
    assert.ok(!src.includes('<h1'), `${title}: no private h1`);
  }
  const occ = read('components/scheduling/OccupancyPanel.tsx');
  assert.ok(occ.includes('label="No asistió"') && !occ.includes('No-shows'), 'same word as the rest of the app');
  assert.ok(occ.includes('<Segmented') && occ.includes('label="Periodo"'), 'the shared segmented control');
  const pm = read('components/scheduling/PaymentMethodsPanel.tsx');
  assert.ok(pm.includes('aria-label={`Subir ${m.label}`}') && pm.includes('aria-label={`Renombrar ${m.label}`}'), 'row actions name their method');
  assert.ok(!pm.includes('truncate text-sm text-foreground'), 'method names wrap instead of «Davipl…»');
});

test('searches: contacts never overflows its slot; campaigns gets a full row on a phone (F08)', () => {
  const toolbar = read('components/contacts/ContactsToolbar.tsx');
  assert.ok(toolbar.includes('md:min-w-[min(15rem,100%)]') && !toolbar.includes('md:min-w-[15rem]'), 'the 15rem floor is capped by the slot');
  assert.ok(toolbar.includes('aria-label="Borrar búsqueda"'), 'same clear name as the shared SearchField');
  assert.ok(toolbar.includes('apply({ q: draft.trim() })'), 'contacts still searches on submit (server query)');
  const ads = read('components/campaigns/CampaignsPanel.tsx');
  assert.match(ads, /<SearchField\s+value=\{search\}[\s\S]*?label="Buscar anuncio"[\s\S]*?max-sm:basis-full/);
});

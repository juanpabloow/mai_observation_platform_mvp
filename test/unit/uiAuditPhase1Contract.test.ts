import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { buildDocumentTitle, pageForTitle } from '../../web/lib/documentTitle.js';

/**
 * Auditoría UI 2026-11-03, fase 1: negocio visible, foco del alta de contacto,
 * identidad de Ejecuciones e idioma/título del documento.
 */
const read = (rel: string) => readFileSync(new URL(`../../web/${rel}`, import.meta.url), 'utf8');
const CID = '0000a0d1-0000-4000-8000-0000000000c1';

test('tab title reads «Pantalla · Negocio · M_AI» (F18)', () => {
  assert.deepEqual(pageForTitle(`/clients/${CID}/scheduling/payment-methods`), { label: 'Métodos de pago', clientId: CID });
  assert.deepEqual(pageForTitle(`/clients/${CID}/workflows/wf1/executions`), { label: 'Ejecuciones', clientId: CID });
  assert.deepEqual(pageForTitle('/'), { label: 'Inicio', clientId: null });
  assert.deepEqual(pageForTitle('/settings/security/sessions'), { label: 'Sesiones', clientId: null });
  assert.equal(buildDocumentTitle('Pipeline', 'Gallery'), 'Pipeline · Gallery · M_AI');
  assert.equal(buildDocumentTitle(null, null), 'M_AI', 'an unknown screen still names the product');
  assert.equal(buildDocumentTitle('Inicio', ' '), 'Inicio · M_AI', 'no empty segment');
});

test('the document is Spanish and no longer «Observability Platform»', () => {
  const layout = read('app/layout.tsx');
  assert.ok(layout.includes('lang="es"'));
  assert.ok(!layout.includes('Observability Platform'));
  const header = read('components/HeaderBar.tsx');
  assert.ok(header.includes('buildDocumentTitle(') && header.includes('new MutationObserver('), 'the header owns the title and survives Next re-applying the static one');
});

test('the rail names the business while the top bar is hidden (F02)', () => {
  const rail = read('components/AppSidebar.tsx');
  // Only in the hidden-bar mode: the same `.u-rail-toggle` gate as the rail's own toggle,
  // so the name never shows twice next to the header chip.
  assert.match(rail, /function RailBusinessChip[\s\S]*?className="u-rail-toggle w-full shrink-0 px-2 pb-1\.5"/);
  assert.ok(rail.includes('aria-label={`Negocio: ${business.name}. Cambiar de negocio`}'));
  assert.ok(rail.includes('canSwitch: !isMember'), 'a member sees the name, not a way to change it');
  const server = read('components/AppSidebarServer.tsx');
  assert.ok(server.includes('clientNames = { [memberClient.id]: memberClient.name }'), 'a member only receives their own business');
});

test('Nuevo contacto beside the list still starts in the form (F03)', () => {
  const drawer = read('components/contacts/form/ContactFormDrawer.tsx');
  const effect = drawer.slice(drawer.indexOf('auditoría 2026-11-03, F03'));
  assert.ok(effect.includes('if (modal) return;'), 'the modal path keeps the focus trap');
  assert.ok(effect.includes('field?.focus({ preventScroll: true })'), 'focus moves to the first field');
  assert.ok(effect.includes('restoreTo?.focus?.({ preventScroll: true })'), 'and returns to the trigger on close');
  assert.ok(drawer.includes('aria-modal={modal || undefined}'), 'not announced as modal while it is not');
});

test('Ejecuciones has a landmark and a heading with the workflow name (F06)', () => {
  const page = read('app/clients/[clientId]/workflows/[workflowId]/(workspace)/executions/page.tsx');
  assert.ok(page.includes('<main className="flex min-h-0 flex-1 flex-col">'));
  assert.ok(page.includes('{workflow.name ?? workflowId}'));
  assert.ok(page.includes('className="u-topbar-fallback'));
  assert.ok(!page.includes('} matching<'), 'the count is in Spanish');
  const css = read('app/globals.css');
  assert.ok(css.includes("html[data-topbar='hidden'] .u-topbar-fallback"), 'drawn only while the bar is hidden');
});

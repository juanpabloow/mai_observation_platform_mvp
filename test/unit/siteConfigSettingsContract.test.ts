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
  assert.ok(src.includes('Anticipación mínima:'), 'panel shows a minimum notice line');
  assert.ok(src.includes('min_notice_min') && src.includes('no se ofrecen'), 'explains the swallowed time');
});

test('settings are task-oriented and editors are progressively disclosed', () => {
  const src = web('components/scheduling/AdminPanel.tsx');
  for (const label of ['Resumen', 'Sedes y horarios', 'Servicios', 'Bloqueos']) {
    assert.ok(src.includes(`label: "${label}"`), `${label} tab exists`);
  }
  assert.ok(src.includes('title="Configuración de agenda"'), 'the screen uses the clear Spanish name');
  assert.ok(src.includes('aria-expanded={editing}'), 'site/service forms are collapsed behind Editar');
});

test('updateSiteAction validates scheduling_config (a bad value cannot silently break availability)', () => {
  const src = web('lib/schedulingAdminActions.ts');
  assert.ok(src.includes('sanitizeSchedulingConfig('), 'config is sanitized before persistence');
  assert.ok(/booking_horizon_days[\s\S]*1, 365/.test(src) || src.includes('1, 365'), 'horizon is range-checked');
});

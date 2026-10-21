import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { OFFLINE_ERROR, safeAction } from '../../web/components/ui/module/safeAction.ts';

/**
 * A server action that THROWS (network down) must come back as an error the screen shows,
 * so the draft is kept and the leave guard re-arms. Found in QA: Reglas stayed on
 * «Guardando…» forever and Back dropped the draft without asking.
 */

test('a thrown action becomes { ok: false } with a Spanish, actionable message', async () => {
  const quiet = console.error;
  console.error = () => {};
  try {
    const r = await safeAction(async () => {
      throw new TypeError('Failed to fetch');
    });
    assert.deepEqual(r, { ok: false, error: OFFLINE_ERROR, offline: true });
    assert.match(OFFLINE_ERROR, /No se pudo conectar/);
  } finally {
    console.error = quiet;
  }
});

test('an answer passes through untouched — success and the action\'s own errors alike', async () => {
  assert.deepEqual(await safeAction(async () => ({ ok: true as const, id: 'x' })), { ok: true, id: 'x' });
  assert.deepEqual(await safeAction(async () => ({ ok: false as const, error: 'Revisa el número' })), { ok: false, error: 'Revisa el número' });
});

test('every save of the module screens goes through it (no bare await of an action)', () => {
  const files = [
    'scheduling/settings/RulesScreen.tsx',
    'scheduling/settings/BookingPageScreen.tsx',
    'scheduling/settings/SitesScreen.tsx',
    'scheduling/services/BookingCategoriesPanel.tsx',
    'scheduling/services/ServiceEditor.tsx',
    'scheduling/services/ServiceMenu.tsx',
    'scheduling/promotions/PromotionsSection.tsx',
    'scheduling/reviews/ReviewsScreen.tsx',
    'catalog/CatalogPanel.tsx',
    'contacts/FieldDefinitions.tsx',
    'campaigns/CampaignsPanel.tsx',
  ];
  for (const f of files) {
    const src = readFileSync(fileURLToPath(new URL(`../../web/components/${f}`, import.meta.url)), 'utf8');
    const bare = src.match(/await (?!safeAction)[A-Za-z]+Action\(/g) ?? [];
    assert.deepEqual(bare, [], `${f} awaits an action without safeAction`);
  }
});

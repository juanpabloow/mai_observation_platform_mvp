import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * SOURCE CONTRACT (E-3): the rule "no machine API response exposes a timestamp without a
 * local label beside it". Guards the wiring the pure/live tests can't (server-only modules).
 */
const web = (rel: string): string => readFileSync(fileURLToPath(new URL(`../../web/${rel}`, import.meta.url)), 'utf8');

test('CRM contact summary labels next_appointment and note timestamps', () => {
  const src = web('lib/crmApi.ts');
  for (const f of ['start_local', 'start_label', 'date_label', 'day']) {
    assert.ok(src.includes(f), `next_appointment carries ${f}`);
  }
  assert.ok(src.includes('localStartFields('), 'reuses the shared C-6 helper (not a second formatter)');
  assert.ok(src.includes('created_at_local') && src.includes('created_at_label'), 'recent_notes carry created_at labels');
});

test('notes POST response labels created_at', () => {
  const src = web('app/api/crm/v1/contacts/[contactId]/notes/route.ts');
  assert.ok(src.includes('created_at_label') && src.includes('localMomentFields('), 'note created_at is labeled via the shared helper');
});

test('availability exposes free_blocks, has_availability and a compact mode', () => {
  const src = web('app/api/scheduling/v1/availability/route.ts');
  assert.ok(src.includes('free_blocks'), 'free_blocks in the response');
  assert.ok(src.includes('has_availability'), 'has_availability in the response');
  assert.ok(src.includes('compact') && src.includes('computeFreeBlocks('), 'compact param + engine-side grouping');
});

test('CRM routes that emit timestamps honor the tz/locale presentation params', () => {
  // Only the responses that carry a timestamp need a tz/locale label. D-3 made the
  // enrichment WRITES (upsert, tags) return a timestamp-free shape, so they no longer
  // resolve tz/locale — the rule "no timestamp without a local label" is satisfied by
  // there being NO timestamp. The reads (GET contact, lookup) and the note timestamp still do.
  for (const rel of [
    'app/api/crm/v1/contacts/[contactId]/route.ts', // GET (read) labels next_appointment
    'app/api/crm/v1/contacts/lookup/route.ts',
    'app/api/crm/v1/contacts/[contactId]/notes/route.ts', // note created_at label
  ]) {
    assert.ok(web(rel).includes('resolveLabelParams('), `${rel} resolves tz/locale`);
  }
});

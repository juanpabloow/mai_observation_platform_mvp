import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { buildEnabledModulesMap } from '../../web/lib/enabledModulesMap.js';

/** Sidebar module-map builder: the default ("Unassigned") client never exposes
 * modules, even when the Phase-1 backfill left enabled rows for it. */

const DEFAULT_ID = 'default-client';

test('groups enabled rows by client and skips disabled ones', () => {
  const map = buildEnabledModulesMap(
    [
      { client_id: 'a', module_key: 'crm', enabled: true },
      { client_id: 'a', module_key: 'scheduling', enabled: false },
      { client_id: 'b', module_key: 'scheduling', enabled: true },
    ],
    null,
  );
  assert.deepEqual(map, { a: ['crm'], b: ['scheduling'] });
});

test("the default client's rows are excluded even when enabled (backfill residue is inert)", () => {
  const map = buildEnabledModulesMap(
    [
      { client_id: DEFAULT_ID, module_key: 'crm', enabled: true },
      { client_id: DEFAULT_ID, module_key: 'scheduling', enabled: true },
      { client_id: 'named', module_key: 'crm', enabled: true },
    ],
    DEFAULT_ID,
  );
  assert.equal(map[DEFAULT_ID], undefined, 'Unassigned never exposes modules');
  assert.deepEqual(map.named, ['crm']);
});

test('null exclude keeps every non-disabled row (member path filters upstream)', () => {
  const map = buildEnabledModulesMap([{ client_id: DEFAULT_ID, module_key: 'crm', enabled: true }], null);
  assert.deepEqual(map, { [DEFAULT_ID]: ['crm'] });
});

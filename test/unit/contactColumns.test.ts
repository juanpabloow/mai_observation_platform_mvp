import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { OPTIONAL_COLUMNS, parseColumns } from '../../web/lib/contactColumns.js';

/**
 * The Contacts table column model. The contract that matters for the redesign:
 * `?cols=` is PRESENTATIONAL ONLY — it can pick which optional columns render and
 * nothing else. It never reaches a query, so it can never change which rows come
 * back or what a value says.
 */

test('absent / empty / junk input yields no optional columns', () => {
  assert.deepEqual(parseColumns(undefined), []);
  assert.deepEqual(parseColumns(null), []);
  assert.deepEqual(parseColumns(''), []);
  assert.deepEqual(parseColumns(',,,'), []);
  assert.deepEqual(parseColumns('nope,alsonope'), []);
});

test('known keys are kept; unknown ones are dropped rather than breaking the table', () => {
  assert.deepEqual(parseColumns('owner'), ['owner']);
  assert.deepEqual(parseColumns('owner,visits'), ['owner', 'visits']);
  // A hand-edited URL mixing real and bogus keys must not desync header/rows.
  assert.deepEqual(parseColumns('owner,haxx,visits'), ['owner', 'visits']);
});

test('output is deduplicated and in the CANONICAL order, whatever the URL order', () => {
  // Header cells and row cells are both built from this list, so a URL-dependent
  // order would misalign the two.
  assert.deepEqual(parseColumns('visits,owner'), ['owner', 'visits']);
  assert.deepEqual(parseColumns('owner,owner,owner'), ['owner']);
  assert.deepEqual(parseColumns('created,consent,visits,owner'), ['owner', 'visits', 'consent', 'created']);
});

test('whitespace around keys is tolerated', () => {
  assert.deepEqual(parseColumns(' owner , visits '), ['owner', 'visits']);
});

test('the REQUIRED columns are not part of the optional set (they can never be hidden)', () => {
  // NAME · CHANNEL · STAGE · LAST ACTIVITY · NEXT APPT · OPEN TASKS are the design's
  // spine — the Columns menu must not be able to switch them off.
  const optional = new Set<string>(OPTIONAL_COLUMNS.map((c) => c.key));
  for (const required of ['name', 'channel', 'stage', 'lastActivity', 'nextAppt', 'openTasks']) {
    assert.equal(optional.has(required), false, `${required} is not togglable`);
  }
});

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { blockSpanLabel } from '../../web/lib/siteCalendar.ts';

// Audit 23 Oct: an all-day absence read «00:00 · 1440 min · 00:00–23:59» / «00:00–00:00».
const TZ = 'America/Bogota';
test('a block reads «Todo el día» (with dates when several), else its hours', () => {
  assert.deepEqual(blockSpanLabel('2026-10-23T05:00:00.000Z', '2026-10-24T05:00:00.000Z', TZ), { allDay: true, text: 'Todo el día' });
  assert.deepEqual(blockSpanLabel('2026-10-23T05:00:00.000Z', '2026-10-27T05:00:00.000Z', TZ), { allDay: true, text: 'Todo el día · vie 23 oct → lun 26 oct' });
  assert.deepEqual(blockSpanLabel('2026-10-23T22:30:00.000Z', '2026-10-23T23:30:00.000Z', TZ), { allDay: false, text: '17:30–18:30' });
});

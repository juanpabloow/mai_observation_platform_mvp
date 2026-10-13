import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { handoffSendTile } from '../../web/lib/handoffSendMetrics.js';

/** Agent-send tile: execution success ≠ delivery. Denominator = every agent message. */
test('percentages use every agent send as the denominator, pending included', () => {
  const t = handoffSendTile({ total: 4, accepted: 2, failed: 1, pending: 1, failedByCode: [{ code: 'CHANNEL_ERROR', count: 1 }] }, 30);
  assert.equal(t.label, 'Agent sends · 30d');
  assert.equal(t.value, '4');
  assert.equal(t.sub, '2 accepted (50%) · 1 failed (25%) · 1 pending');
  assert.equal(t.failures, 'CHANNEL_ERROR 1');
  assert.match(t.note, /not confirmed delivered/);
});

test('an all-accepted range still says "accepted", never "delivered"', () => {
  const t = handoffSendTile({ total: 13, accepted: 13, failed: 0, pending: 0, failedByCode: [] }, 30);
  assert.equal(t.sub, '13 accepted (100%) · 0 failed (0%) · 0 pending');
  assert.equal(t.failures, null);
  assert.doesNotMatch(`${t.label} ${t.sub}`, /deliver/i);
});

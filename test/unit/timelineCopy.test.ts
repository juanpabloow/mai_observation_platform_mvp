import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { timelineCopy, TIMELINE_FILTERS } from '../../web/lib/timelineCopy.js';
import { contactDisplayName, agendaDateKey, type IdentityView } from '../../web/lib/contactShared.js';

/**
 * The C-4 unified-timeline COPY module + shared pure helpers. These are the one place
 * timeline wording + the source-bucketing live; a wrong bucket would break the API
 * filter push-down (a "Notes" filter must request only the 'note' source).
 */

test('timelineCopy maps every kind to its source bucket + a factual title', () => {
  assert.equal(timelineCopy('conversation').source, 'conversation');
  assert.equal(timelineCopy('note').source, 'note');
  for (const k of ['appointment_created', 'appointment_completed', 'appointment_no_show', 'appointment_cancelled']) {
    assert.equal(timelineCopy(k).source, 'appointment', `${k} → appointment source`);
  }
  // task_* AND the CRM facts all live in the single 'activity' API source.
  for (const k of ['task_created', 'task_completed', 'tag_added', 'tag_removed', 'owner_changed', 'stage_changed', 'contact_merged', 'consent_changed']) {
    assert.equal(timelineCopy(k).source, 'activity', `${k} → activity source`);
  }
  // Factual titles (no exclamation, sentence-ish, short).
  assert.equal(timelineCopy('appointment_created').title, 'Appointment booked');
  assert.equal(timelineCopy('appointment_no_show').title, 'No-show');
  assert.equal(timelineCopy('owner_changed').title, 'Owner changed');
});

test('timelineCopy weight: appointments/conversations/notes substantive; CRM facts quiet', () => {
  for (const k of ['conversation', 'note', 'appointment_created']) {
    assert.equal(timelineCopy(k).weight, 'substantive', `${k} substantive`);
  }
  for (const k of ['task_created', 'tag_added', 'owner_changed', 'consent_changed']) {
    assert.equal(timelineCopy(k).weight, 'quiet', `${k} quiet`);
  }
});

test('timelineCopy falls back safely for an unknown kind (never throws)', () => {
  const c = timelineCopy('something_new_from_the_future');
  assert.equal(c.source, 'activity');
  assert.ok(c.title.length > 0);
});

test('TIMELINE_FILTERS: All is null; each other chip pushes exactly one valid source', () => {
  const valid = new Set(['conversation', 'appointment', 'note', 'activity']);
  assert.equal(TIMELINE_FILTERS[0].label, 'All');
  assert.equal(TIMELINE_FILTERS[0].sources, null);
  const covered = new Set<string>();
  for (const f of TIMELINE_FILTERS.slice(1)) {
    assert.ok(Array.isArray(f.sources) && f.sources.length === 1, `${f.label} pushes exactly one source`);
    assert.ok(valid.has(f.sources![0]), `${f.label} → a real TimelineSource`);
    covered.add(f.sources![0]);
  }
  // Every API source is reachable from some chip.
  assert.deepEqual([...covered].sort(), ['activity', 'appointment', 'conversation', 'note']);
});

test('contactDisplayName: name → primary phone identity → fallback', () => {
  const phone: IdentityView = { kind: 'phone', value: '+573001112233', label: 'whatsapp' };
  const email: IdentityView = { kind: 'email', value: 'a@b.co', label: 'form' };
  assert.equal(contactDisplayName('Ana', [phone], 'ref'), 'Ana');
  assert.equal(contactDisplayName(null, [email, phone], 'ref'), '+573001112233', 'prefers a phone identity');
  assert.equal(contactDisplayName('  ', [email], 'ref'), 'a@b.co', 'blank name falls through to an identity');
  assert.equal(contactDisplayName(null, [], 'channel-ref'), 'channel-ref', 'else the fallback');
});

test('agendaDateKey returns the YYYY-MM-DD of an ISO instant', () => {
  assert.equal(agendaDateKey('2026-08-05T14:30:00.000Z'), '2026-08-05');
});

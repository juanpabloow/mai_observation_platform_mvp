import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { BOARD_STAGES, contactLabel, groupByStage, toBoardCard, whoSpokeLast, type BoardCard } from '../../web/lib/pipelineBoard.js';
import type { BoardOpportunityRow } from '../../src/db/repositories/pipeline.js';

test('BOARD_STAGES: five columns, only Pago disabled', () => {
  assert.deepEqual(BOARD_STAGES.map((s) => s.key), ['lead', 'qualified', 'booked', 'attended', 'paid']);
  assert.equal(BOARD_STAGES.find((s) => s.key === 'paid')?.disabled, true);
  assert.ok(BOARD_STAGES.slice(0, 4).every((s) => !s.disabled), 'the real funnel columns are enabled');
});

test('whoSpokeLast + contactLabel', () => {
  assert.equal(whoSpokeLast('user'), 'customer');
  assert.equal(whoSpokeLast('bot'), 'business');
  assert.equal(whoSpokeLast('human_agent'), 'business');
  assert.equal(whoSpokeLast(null), null);
  assert.equal(contactLabel('Ana', 'wa:x'), 'Ana');
  assert.equal(contactLabel(null, 'wa:x'), 'wa:x');
  assert.equal(contactLabel('  ', null), 'Contacto sin nombre');
});

test('toBoardCard maps origin (reuses the origin vocabulary), stage_since, and who spoke last', () => {
  const row: BoardOpportunityRow = {
    id: 'o1', contact_id: 'c1', conversation_id: 'cv1', status: 'open', stage: 'lead',
    created_at: new Date('2026-06-01'), stage_since: new Date('2026-06-01'), lost_reason: null, lost_note: null, closed_at: null,
    contact_name: 'Ana', contact_channel_user_id: 'wa:x', origin_kind: 'meta_ad',
    ad_name: 'Factos', ad_headline: 'H', ad_is_test: false, campaign_name: 'Camp',
    last_sender: 'user', last_message_at: new Date('2026-06-02'),
  };
  const c = toBoardCard(row);
  assert.equal(c.name, 'Ana');
  assert.equal(c.originChip.label, 'Anuncio');
  assert.equal(c.originDetail, 'Factos · Camp');
  assert.equal(c.spokeLast, 'customer');
  assert.equal(c.isTestAd, false);
  assert.ok(c.stageSince && c.lastMessageAt);
});

test('toBoardCard flags a test-ad origin', () => {
  const row = { contact_name: 'T', contact_channel_user_id: null, origin_kind: 'meta_ad', ad_name: null, ad_headline: 'x', ad_is_test: true, campaign_name: null, id: 'o', contact_id: 'c', conversation_id: null, status: 'open', stage: 'lead', created_at: new Date(), stage_since: null, lost_reason: null, lost_note: null, closed_at: null, last_sender: null, last_message_at: null } as BoardOpportunityRow;
  const c = toBoardCard(row);
  assert.equal(c.isTestAd, true);
  assert.equal(c.originDetail, 'Anuncio de prueba');
});

test('groupByStage buckets by stage with every column key present', () => {
  const mk = (id: string, stage: BoardCard['stage']): BoardCard => ({
    id, contactId: 'c', conversationId: null, stage, status: 'open', name: 'n',
    originChip: { label: 'Desconocido', tone: 'bg-chip text-muted' }, originDetail: null, isTestAd: false,
    stageSince: null, lastMessageAt: null, spokeLast: null, lostReason: null, lostNote: null,
  });
  const g = groupByStage([mk('a', 'lead'), mk('b', 'booked'), mk('c', 'lead')]);
  assert.equal(g.lead.length, 2);
  assert.equal(g.booked.length, 1);
  assert.equal(g.qualified.length, 0);
  assert.equal(g.attended.length, 0);
  assert.equal(g.paid.length, 0);
});

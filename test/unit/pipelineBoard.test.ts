import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  BOARD_STAGES,
  groupByStage,
  originLineOf,
  originTitleOf,
  sortByActivityDesc,
  spokeLastDisplay,
  toBoardCard,
  whoSpokeLast,
  type BoardCard,
} from '../../web/lib/pipelineBoard.js';
import type { BoardOpportunityRow } from '../../src/db/repositories/pipeline.js';

const PANEL = readFileSync(new URL('../../web/components/pipeline/PipelinePanel.tsx', import.meta.url), 'utf8');
const MENU = readFileSync(new URL('../../web/components/scheduling/ui/Menu.tsx', import.meta.url), 'utf8');

const mkCard = (over: Partial<BoardCard> = {}): BoardCard => ({
  id: 'o', contactId: 'c', conversationId: null, stage: 'lead', status: 'open', name: 'n',
  originChip: { label: 'Desconocido', tone: 'bg-chip text-muted' }, originDetail: null, adName: null,
  isTestAd: false, stageSince: null, lastMessageAt: null, spokeLast: null, lostReason: null, lostNote: null,
  ...over,
});

test('BOARD_STAGES: five columns, only Pago disabled', () => {
  assert.deepEqual(BOARD_STAGES.map((s) => s.key), ['lead', 'qualified', 'booked', 'attended', 'paid']);
  assert.equal(BOARD_STAGES.find((s) => s.key === 'paid')?.disabled, true);
  assert.ok(BOARD_STAGES.slice(0, 4).every((s) => !s.disabled), 'the real funnel columns are enabled');
});

test('whoSpokeLast', () => {
  assert.equal(whoSpokeLast('user'), 'customer');
  assert.equal(whoSpokeLast('bot'), 'business');
  assert.equal(whoSpokeLast('human_agent'), 'business');
  assert.equal(whoSpokeLast(null), null);
});

test('toBoardCard maps origin (reuses the origin vocabulary), ad name, stage_since, who spoke last', () => {
  const row: BoardOpportunityRow = {
    id: 'o1', contact_id: 'c1', conversation_id: 'cv1', status: 'open', stage: 'lead',
    created_at: new Date('2026-06-01'), stage_since: new Date('2026-06-01'), lost_reason: null, lost_note: null, closed_at: null,
    contact_name: 'Ana', contact_channel_user_id: 'wa:x', contact_phone_e164: null, origin_kind: 'meta_ad',
    ad_name: 'Factos', ad_headline: 'H', ad_is_test: false, campaign_name: 'Camp',
    last_sender: 'user', last_message_at: new Date('2026-06-02'),
  };
  const c = toBoardCard(row);
  assert.equal(c.name, 'Ana');
  assert.equal(c.originChip.label, 'Anuncio');
  assert.equal(c.originDetail, 'Factos · Camp');
  assert.equal(c.adName, 'Factos');
  assert.equal(c.spokeLast, 'customer');
  assert.equal(c.isTestAd, false);
  assert.ok(c.stageSince && c.lastMessageAt);
});

test('toBoardCard falls back to a masked phone when the stored name is junk', () => {
  const base = {
    id: 'o', contact_id: 'c', conversation_id: null, status: 'open', stage: 'lead',
    created_at: new Date(), stage_since: null, lost_reason: null, lost_note: null, closed_at: null,
    origin_kind: null, ad_name: null, ad_headline: null, ad_is_test: null, campaign_name: null,
    last_sender: null, last_message_at: null,
  };
  const junk = toBoardCard({ ...base, contact_name: '.', contact_channel_user_id: 'wa:x', contact_phone_e164: '+573120000220' } as BoardOpportunityRow);
  assert.equal(junk.name, '+57 312 ••• 0220', 'junk name "." → masked phone');
});

test('toBoardCard flags a test-ad origin', () => {
  const row = { contact_name: 'T', contact_channel_user_id: null, contact_phone_e164: null, origin_kind: 'meta_ad', ad_name: null, ad_headline: 'x', ad_is_test: true, campaign_name: null, id: 'o', contact_id: 'c', conversation_id: null, status: 'open', stage: 'lead', created_at: new Date(), stage_since: null, lost_reason: null, lost_note: null, closed_at: null, last_sender: null, last_message_at: null } as BoardOpportunityRow;
  const c = toBoardCard(row);
  assert.equal(c.isTestAd, true);
  assert.equal(c.originDetail, 'Anuncio de prueba');
  assert.equal(c.adName, 'Anuncio de prueba');
});

test('originLineOf / originTitleOf: ads show "Anuncio · <ad>" on the card, campaign in the tooltip', () => {
  const ad = mkCard({ originChip: { label: 'Anuncio', tone: 't' }, adName: 'Factos', originDetail: 'Factos · Presentación' });
  assert.equal(originLineOf(ad), 'Anuncio · Factos');
  assert.equal(originTitleOf(ad), 'Anuncio · Factos · Presentación');

  const organic = mkCard({ originChip: { label: 'Orgánico', tone: 't' }, adName: null, originDetail: 'WhatsApp' });
  assert.equal(originLineOf(organic), 'Orgánico', 'no ad → just the label (one line)');
  assert.equal(originTitleOf(organic), 'Orgánico · WhatsApp');

  const booking = mkCard({ originChip: { label: 'Página de reservas', tone: 't' }, adName: null, originDetail: null });
  assert.equal(originLineOf(booking), 'Página de reservas');
  assert.equal(originTitleOf(booking), 'Página de reservas');
});

test('spokeLastDisplay: the customer\'s turn is emphasised (needs a reply), the business\'s is not', () => {
  assert.deepEqual(spokeLastDisplay('customer'), { label: 'Cliente', emphasize: true });
  assert.deepEqual(spokeLastDisplay('business'), { label: 'Negocio', emphasize: false });
  assert.equal(spokeLastDisplay(null), null);
});

test('sortByActivityDesc: most recent activity first, stable by id, non-mutating', () => {
  const a = mkCard({ id: 'a', lastMessageAt: '2026-06-01T00:00:00.000Z' });
  const b = mkCard({ id: 'b', lastMessageAt: '2026-06-03T00:00:00.000Z' });
  const c = mkCard({ id: 'c', lastMessageAt: null, stageSince: '2026-06-02T00:00:00.000Z' });
  const d = mkCard({ id: 'd', lastMessageAt: null, stageSince: null }); // no activity → last
  const input = [a, c, d, b];
  const sorted = sortByActivityDesc(input);
  assert.deepEqual(sorted.map((x) => x.id), ['b', 'c', 'a', 'd']);
  assert.deepEqual(input.map((x) => x.id), ['a', 'c', 'd', 'b'], 'input not mutated');
});

test('groupByStage buckets by stage with every column key present', () => {
  const g = groupByStage([mkCard({ id: 'a', stage: 'lead' }), mkCard({ id: 'b', stage: 'booked' }), mkCard({ id: 'c', stage: 'lead' })]);
  assert.equal(g.lead.length, 2);
  assert.equal(g.booked.length, 1);
  assert.equal(g.qualified.length, 0);
  assert.equal(g.attended.length, 0);
  assert.equal(g.paid.length, 0);
});

test('PipelinePanel card: every action reachable from an accessible menu; no "Ganada" chip; stretched link', () => {
  // Reuses the house Menu (keyboard + touch: closes on Escape/outside click, real menuitem controls).
  assert.ok(/from "@\/components\/scheduling\/ui\/Menu"/.test(PANEL), 'reuses the accessible Menu');
  assert.ok(/MenuButton[\s\S]*Quitar calificación/.test(PANEL), 'menu: Quitar calificación');
  assert.ok(/MenuButton[\s\S]*Marcar perdida/.test(PANEL), 'menu: Marcar perdida');
  assert.ok(PANEL.includes('Abrir conversación'), 'menu: Abrir conversación');
  assert.ok(PANEL.includes('>Ver ficha<'), 'menu: Ver ficha');
  assert.ok(PANEL.includes('Calificar</button>'), 'Lead has a primary Calificar action');
  assert.ok(!/>\s*Ganada\s*<\/span>/.test(PANEL), 'no redundant "Ganada" chip on board cards');
  assert.ok(PANEL.includes('after:absolute after:inset-0'), 'the whole card body is a stretched link');
});

test('PipelinePanel board: independent per-column scroll + a slim Pagó column', () => {
  assert.ok(PANEL.includes('overflow-y-auto'), 'columns scroll on their own');
  assert.ok(PANEL.includes('snap-x'), 'the board scroll-snaps per column when it overflows');
  assert.ok(PANEL.includes('[writing-mode:vertical-rl]') && PANEL.includes('Llega con la fase de pagos'), 'Pagó is a slim column with the note in its tooltip');
});

test('card "⋯" menu is floating (portaled) so it is never clipped by the column scroll', () => {
  assert.ok(/<Menu\b[^>]*\bfloating\b/.test(PANEL), 'the card menu opts into the floating/portaled Menu');
});

test('Menu floating mode: portals to <body> and flips above the trigger when there is no room below', () => {
  assert.ok(/from "react-dom"/.test(MENU) && MENU.includes('createPortal'), 'floating list is portaled with createPortal');
  assert.ok(MENU.includes('createPortal(list, document.body)'), 'portals into <body>, outside the column scroll container');
  assert.ok(MENU.includes('position: fixed') || /\bfixed\b/.test(MENU), 'the portaled list is position: fixed');
  assert.ok(/const up =/.test(MENU) && MENU.includes('spaceBelow') && MENU.includes('spaceAbove'), 'flips up when there is more room above than below');
  assert.ok(MENU.includes("querySelector<HTMLElement>('[role=\"menuitem\"]')"), 'focus moves into the portaled list on open (keyboard stays reachable)');
  assert.ok(/if \(floating\) triggerRef\.current\?\.focus\(\)/.test(MENU), 'Escape returns focus to the trigger in floating mode');
});

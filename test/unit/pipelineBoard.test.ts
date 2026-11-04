import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  BOARD_STAGES,
  COHORT_SETTLING_DAYS,
  STALE_LEAD_MINUTES,
  STALE_QUALIFIED_HOURS,
  apptLineOf,
  apptWhenLine,
  cardUrgency,
  cohortFunnelSteps,
  cohortMonths,
  cohortPeriodRange,
  cohortTopLoss,
  contactAvatar,
  funnelSteps,
  resolveCohortPeriod,
  groupByStage,
  lossReasonCounts,
  originLineOf,
  originTitleOf,
  ownerInitials,
  qualificationLineOf,
  reminderText,
  sortBoardColumn,
  sortByActivityDesc,
  spokeLastDisplay,
  stageTotals,
  toBoardCard,
  whoSpokeLast,
  type BoardCard,
} from '../../web/lib/pipelineBoard.js';
import { siteLocalToUtc, todayAtSite } from '../../web/lib/siteCalendar.js';
import type { BoardOpportunityRow } from '../../src/db/repositories/pipeline.js';
import { SYSTEM_ROLE_PERMISSIONS } from '../../web/lib/permissions/catalog.js';

const PANEL = readFileSync(new URL('../../web/components/pipeline/PipelinePanel.tsx', import.meta.url), 'utf8');
const MENU = readFileSync(new URL('../../web/components/scheduling/ui/Menu.tsx', import.meta.url), 'utf8');
const PAGE = readFileSync(new URL('../../web/app/clients/[clientId]/pipeline/page.tsx', import.meta.url), 'utf8');
const DRAWER = readFileSync(new URL('../../web/components/pipeline/OpportunityDrawer.tsx', import.meta.url), 'utf8');
const ACTIONS = readFileSync(new URL('../../web/lib/pipelineActions.ts', import.meta.url), 'utf8');

const mkCard = (over: Partial<BoardCard> = {}): BoardCard => ({
  id: 'o', contactId: 'c', conversationId: null, stage: 'lead', status: 'open', name: 'n',
  originChip: { label: 'Desconocido', tone: 'bg-chip text-muted' }, originDetail: null, adName: null,
  isTestAd: false, stageSince: null, lastMessageAt: null, spokeLast: null, lostReason: null, lostNote: null,
  paidAmount: null, paidMethod: null,
  lastMessageText: null, qualService: null, qualTimeframe: null, qualifiedBy: null,
  apptStartAt: null, apptStatus: null, apptTz: null, apptListAmount: null, owner: null, stale: null,
  avatar: "·", nameMuted: false, apptId: null, apptService: null, apptStaffName: null, hasPayment: false,
  ...over,
});

/** A full BoardOpportunityRow with null defaults (JP-7 added many optional fields). */
const mkRow = (over: Partial<BoardOpportunityRow> & { id: string; contact_id: string; status: BoardOpportunityRow["status"]; stage: BoardOpportunityRow["stage"] }): BoardOpportunityRow => ({
  conversation_id: null, created_at: new Date(), stage_since: new Date(), lost_reason: null, lost_note: null, closed_at: null,
  contact_name: null, contact_channel_user_id: null, contact_phone_e164: null, origin_kind: null,
  ad_name: null, ad_headline: null, ad_is_test: null, campaign_name: null, last_sender: null, last_message_at: null,
  paid_total: null, paid_method: null, last_message_text: null, qualification_service: null, qualification_timeframe: null,
  qualified_by: null, qualified_by_name: null, appt_start_at: null, appt_status: null, appt_tz: null, appt_list_price: null,
  appt_id: null, appt_service: null, appt_staff_name: null,
  owner_user_id: null, owner_name: null,
  ...over,
});

test('JP-6 BOARD_STAGES: five real columns, none disabled (Pagó is live now that payments ship)', () => {
  assert.deepEqual(BOARD_STAGES.map((s) => s.key), ['lead', 'qualified', 'booked', 'attended', 'paid']);
  assert.ok(BOARD_STAGES.every((s) => !s.disabled), 'every funnel column, including Pagó, is a real column');
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
    last_sender: 'user', last_message_at: new Date('2026-06-02'), paid_total: null, paid_method: null,
    last_message_text: 'Quiero una cita', qualification_service: null, qualification_timeframe: null,
    qualified_by: null, qualified_by_name: null, appt_start_at: null, appt_status: null, appt_tz: null,
    appt_list_price: null, owner_user_id: null, owner_name: null,
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
    last_sender: null, last_message_at: null, paid_total: null, paid_method: null,
    last_message_text: null, qualification_service: null, qualification_timeframe: null, qualified_by: null,
    qualified_by_name: null, appt_start_at: null, appt_status: null, appt_tz: null, appt_list_price: null,
    owner_user_id: null, owner_name: null,
  };
  const junk = toBoardCard({ ...base, contact_name: '.', contact_channel_user_id: 'wa:x', contact_phone_e164: '+573120000220' } as BoardOpportunityRow);
  assert.equal(junk.name, '+57 312 ••• 0220', 'junk name "." → masked phone');
});

test('toBoardCard flags a test-ad origin', () => {
  const row = { contact_name: 'T', contact_channel_user_id: null, contact_phone_e164: null, origin_kind: 'meta_ad', ad_name: null, ad_headline: 'x', ad_is_test: true, campaign_name: null, id: 'o', contact_id: 'c', conversation_id: null, status: 'open', stage: 'lead', created_at: new Date(), stage_since: null, lost_reason: null, lost_note: null, closed_at: null, last_sender: null, last_message_at: null, paid_total: null, paid_method: null } as BoardOpportunityRow;
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

test('JP-9 card: opens the drawer; no "⋯" menu on the card; no "Ganada" chip; nameless → muted italic', () => {
  // Secondary actions (Perder / Quitar calificación / Reabrir / Ver ficha) live in the drawer now.
  assert.ok(!/<Menu\b/.test(PANEL), 'the card has no "⋯" menu — actions moved to the drawer');
  assert.ok(PANEL.includes('onClick={onOpen}') && PANEL.includes('after:absolute after:inset-0'), 'the whole card body opens the drawer');
  assert.ok(PANEL.includes('onOpen={() => setSelected(c)}'), 'board cards open the drawer');
  assert.ok(!/>\s*Ganada\s*<\/span>/.test(PANEL), 'no redundant "Ganada" chip');
  assert.ok(PANEL.includes('card.nameMuted') && PANEL.includes('italic text-muted'), 'a nameless contact shows muted italic "Sin nombre"');
});

test('JP-9 board: five fluid columns, per-column scroll + snap, paid shows method + neutral amount, no commission', () => {
  assert.ok(PANEL.includes('overflow-y-auto'), 'columns scroll on their own');
  assert.ok(PANEL.includes('snap-x') && PANEL.includes('grid-cols-[repeat(5,minmax(11rem,1fr))]'), 'five fluid columns, scroll-snap below 1280');
  assert.ok(PANEL.includes('card.paidMethod') && PANEL.includes('priceLabelCOP(card.paidAmount)'), 'paid card shows the method + amount');
  assert.ok(PANEL.includes('Cobro pendiente'), 'attended card is marked pending payment');
  assert.ok(!/commission_amount|commissionAmount|\.commission|comisión/.test(PANEL), 'the board card never references commission');
});

test('JP-6 toBoardCard carries the paid amount + method, and payments.view gates it', () => {
  const base = {
    id: 'p', contact_id: 'c', conversation_id: null, status: 'won', stage: 'paid',
    created_at: new Date(), stage_since: new Date(), lost_reason: null, lost_note: null, closed_at: new Date(),
    contact_name: 'Sofía', contact_channel_user_id: null, contact_phone_e164: null, origin_kind: null,
    ad_name: null, ad_headline: null, ad_is_test: null, campaign_name: null, last_sender: null, last_message_at: null,
    paid_total: '85000', paid_method: 'Efectivo',
  } as BoardOpportunityRow;
  const shown = toBoardCard(base);
  assert.equal(shown.paidAmount, '85000');
  assert.equal(shown.paidMethod, 'Efectivo');
  const hidden = toBoardCard(base, false); // a viewer without payments.view
  assert.equal(hidden.paidAmount, null, 'no amount without payments.view');
  assert.equal(hidden.paidMethod, null);
});

test('Menu floating mode: portals to <body> and flips above the trigger when there is no room below', () => {
  assert.ok(/from "react-dom"/.test(MENU) && MENU.includes('createPortal'), 'floating list is portaled with createPortal');
  assert.ok(MENU.includes('createPortal(list, document.body)'), 'portals into <body>, outside the column scroll container');
  assert.ok(MENU.includes('position: fixed') || /\bfixed\b/.test(MENU), 'the portaled list is position: fixed');
  assert.ok(/const up =/.test(MENU) && MENU.includes('spaceBelow') && MENU.includes('spaceAbove'), 'flips up when there is more room above than below');
  assert.ok(MENU.includes("querySelector<HTMLElement>('[role=\"menuitem\"]')"), 'focus moves into the portaled list on open (keyboard stays reachable)');
  assert.ok(/if \(floating\) triggerRef\.current\?\.focus\(\)/.test(MENU), 'Escape returns focus to the trigger in floating mode');
});

// ────────────────────────── JP-7: the richer board ──────────────────────────

const TZ = 'America/Bogota';
const atToday = (hhmm: string) => siteLocalToUtc(todayAtSite(TZ), hhmm, TZ)!.toISOString();

test('JP-7 computeStale: Lead (customer waited > 15 min), Calificado (> 24 h), Reservó (appt passed)', () => {
  const now = Date.now();
  // Lead: customer spoke last, long ago → stale.
  const leadStale = toBoardCard(mkRow({ id: 'a', contact_id: 'c', status: 'open', stage: 'lead', last_sender: 'user', last_message_at: new Date(now - 20 * 60_000) }), true, now);
  assert.ok(leadStale.stale && /15 min/.test(leadStale.stale.reason));
  // Lead but the BUSINESS spoke last → not stale (ball is in the customer's court).
  assert.equal(toBoardCard(mkRow({ id: 'a', contact_id: 'c', status: 'open', stage: 'lead', last_sender: 'bot', last_message_at: new Date(now - 60 * 60_000) }), true, now).stale, null);
  // Lead, recent → not stale.
  assert.equal(toBoardCard(mkRow({ id: 'a', contact_id: 'c', status: 'open', stage: 'lead', last_sender: 'user', last_message_at: new Date(now - 5 * 60_000) }), true, now).stale, null);
  // Calificado > 24 h → stale.
  const qStale = toBoardCard(mkRow({ id: 'b', contact_id: 'c', status: 'open', stage: 'qualified', stage_since: new Date(now - 30 * 3_600_000) }), true, now);
  assert.ok(qStale.stale && /24 h/.test(qStale.stale.reason));
  assert.equal(toBoardCard(mkRow({ id: 'b', contact_id: 'c', status: 'open', stage: 'qualified', stage_since: new Date(now - 2 * 3_600_000) }), true, now).stale, null);
  // Reservó whose appointment already passed, still not completed → stale; a future one → not.
  const bStale = toBoardCard(mkRow({ id: 'd', contact_id: 'c', status: 'open', stage: 'booked', appt_start_at: new Date(now - 3_600_000), appt_status: 'confirmed' }), true, now);
  assert.ok(bStale.stale && /ya pasó/.test(bStale.stale.reason));
  assert.equal(toBoardCard(mkRow({ id: 'd', contact_id: 'c', status: 'open', stage: 'booked', appt_start_at: new Date(now + 3_600_000), appt_status: 'confirmed' }), true, now).stale, null);
  // The thresholds are exported constants.
  assert.equal(STALE_LEAD_MINUTES, 15);
  assert.equal(STALE_QUALIFIED_HOURS, 24);
});

test('JP-7 qualificationLineOf: evidence + who qualified (Bot / first name)', () => {
  const bot = toBoardCard(mkRow({ id: 'a', contact_id: 'c', status: 'open', stage: 'qualified', qualification_service: 'Corte con barba', qualification_timeframe: 'el sábado', qualified_by: 'bot' }));
  assert.equal(qualificationLineOf(bot), 'Corte con barba · el sábado · Bot');
  const person = toBoardCard(mkRow({ id: 'a', contact_id: 'c', status: 'open', stage: 'qualified', qualification_service: 'Corte', qualification_timeframe: 'mañana', qualified_by: 'u1', qualified_by_name: 'Ana Ruiz' }));
  assert.equal(qualificationLineOf(person), 'Corte · mañana · Ana');
  assert.equal(qualificationLineOf(mkCard({ stage: 'qualified' })), null, 'no evidence → no line');
});

test('JP-7 apptLineOf: Hoy/Mañana + 12h time + confirmed state', () => {
  const now = Date.now();
  const today = toBoardCard(mkRow({ id: 'a', contact_id: 'c', status: 'open', stage: 'booked', appt_start_at: new Date(atToday('14:30')), appt_status: 'confirmed', appt_tz: TZ }), true, now);
  const line = apptLineOf(today)!;
  assert.ok(line.startsWith('Hoy · '), `expected "Hoy · …", got "${line}"`);
  assert.ok(line.includes('Confirmada'));
  const scheduled = toBoardCard(mkRow({ id: 'a', contact_id: 'c', status: 'open', stage: 'booked', appt_start_at: new Date(atToday('09:00')), appt_status: 'scheduled', appt_tz: TZ }), true, now);
  assert.ok(apptLineOf(scheduled)!.includes('Sin confirmar'));
  assert.equal(apptLineOf(mkCard({ stage: 'booked' })), null, 'no appointment → no line');
});

test('JP-7 stageTotals sums per stage and is 0 without payments.view', () => {
  const rows = [
    mkRow({ id: '1', contact_id: 'a', status: 'open', stage: 'booked', appt_list_price: '90000' }),
    mkRow({ id: '2', contact_id: 'b', status: 'won', stage: 'attended', appt_list_price: '45000' }),
    mkRow({ id: '3', contact_id: 'c', status: 'won', stage: 'paid', paid_total: '60000' }),
  ];
  const t = stageTotals(rows.map((r) => toBoardCard(r, true)));
  assert.deepEqual(t, { bookedExpected: 90000, attendedPending: 45000, paidCollected: 60000 });
  // Without payments.view the per-card amounts are null → totals collapse to 0 (and the page never
  // even builds totals for a Setter — see the revenue-gate test below).
  const hidden = stageTotals(rows.map((r) => toBoardCard(r, false)));
  assert.deepEqual(hidden, { bookedExpected: 0, attendedPending: 0, paidCollected: 0 });
});

test('JP-7 funnelSteps: counts + conversion % from the previous step', () => {
  const cards = [
    ...Array.from({ length: 10 }, (_, i) => mkCard({ id: `l${i}`, stage: 'lead' })),
    ...Array.from({ length: 5 }, (_, i) => mkCard({ id: `q${i}`, stage: 'qualified' })),
    ...Array.from({ length: 4 }, (_, i) => mkCard({ id: `b${i}`, stage: 'booked' })),
    ...Array.from({ length: 2 }, (_, i) => mkCard({ id: `a${i}`, stage: 'attended' })),
    mkCard({ id: 'p0', stage: 'paid' }),
  ];
  const f = funnelSteps(cards);
  assert.deepEqual(f.map((s) => s.count), [10, 5, 4, 2, 1]);
  assert.deepEqual(f.map((s) => s.convPct), [null, 50, 80, 50, 50]);
});

test('JP-7 lossReasonCounts + ownerInitials', () => {
  const lost = [mkCard({ id: '1', lostReason: 'precio' }), mkCard({ id: '2', lostReason: 'precio' }), mkCard({ id: '3', lostReason: 'no_asistio' })];
  assert.deepEqual(lossReasonCounts(lost), [{ reason: 'precio', count: 2 }, { reason: 'no_asistio', count: 1 }]);
  assert.equal(ownerInitials('Ana Ruiz'), 'AR');
  assert.equal(ownerInitials('Beto'), 'B');
  assert.equal(ownerInitials(null), '?');
});

test('JP-7 toBoardCard gates the appointment list price behind payments.view', () => {
  const row = mkRow({ id: 'a', contact_id: 'c', status: 'won', stage: 'attended', appt_list_price: '90000', owner_user_id: 'u1', owner_name: 'Ana' });
  assert.equal(toBoardCard(row, true).apptListAmount, '90000');
  assert.equal(toBoardCard(row, false).apptListAmount, null);
  assert.deepEqual(toBoardCard(row, true).owner, { userId: 'u1', name: 'Ana' });
});

test('JP-7 revenue totals are a Client-Owner/agency view — the Setter never gets them', () => {
  // The Setter's SYSTEM role lacks analytics.view (the revenue gate), so the page never builds totals.
  assert.ok(!SYSTEM_ROLE_PERMISSIONS.setter.has('analytics.view'), 'Setter has no analytics.view');
  assert.ok(SYSTEM_ROLE_PERMISSIONS.owner.has('analytics.view'), 'Owner has analytics.view');
  assert.ok(PAGE.includes('const canViewRevenue = can(scope, "analytics.view"'), 'the page gates on analytics.view');
  assert.ok(PAGE.includes('const moneyTotals = canViewRevenue ? stageTotals(cards) : null'), 'totals are null for a non-revenue viewer (payload carries none)');
});

test('JP-9 the board renders gated column money + the per-stage card lines + the Perdidos header', () => {
  assert.ok(PANEL.includes('columnMoney[col.key]') && PANEL.includes('moneyTotals'), 'column money shown only when totals are present (revenue only)');
  assert.ok(PANEL.includes('apptWhenLine') && PANEL.includes('qualificationLineOf') && PANEL.includes('Quiere '), 'per-stage lines: appointment / qualification evidence');
  assert.ok(PANEL.includes('Cobro pendiente') && PANEL.includes('Sin cobrar'), 'Asistió shows the pending / overdue state');
  assert.ok(PANEL.includes('Motivos de pérdida') && PANEL.includes('LOST_REASON_LABEL[reason]'), 'the Perdidos loss-reason header');
});

test('JP-9 header: Activos/Te esperan/Sin respuesta/Perdidos tabs, search, Más filtros, Tablero/Lista', () => {
  for (const t of ['Activos', 'Te esperan', 'Sin respuesta', 'Perdidos']) assert.ok(PANEL.includes(`label="${t}"`), `tab: ${t}`);
  assert.ok(PANEL.includes('attention') && PANEL.includes('bg-warn'), '"Te esperan" shows the attention dot');
  assert.ok(PANEL.includes("apply({ q: searchDraft.trim() })") && PANEL.includes('Nombre, teléfono o @usuario'), 'search submits ?q=');
  assert.ok(PANEL.includes('Más filtros') && PANEL.includes('label="Anuncio"') && PANEL.includes('label="Dueño"'), 'Anuncio + Dueño live in the Más filtros popover');
  assert.ok(PANEL.includes('useSyncExternalStore(viewPref.subscribe'), 'the Tablero/Lista choice is remembered per user, SSR-safe');
  assert.ok(PANEL.includes('function BoardListView') && PANEL.includes('aria-sort='), 'the sortable list view exists');
});

// ── JP-7b ────────────────────────────────────────────────────────────────────────────────

test('JP-7b §1 cohortFunnelSteps: monotonic reached counts, conversion never above 100%', () => {
  // A cohort where the OLD snapshot gave >100%: more are booked NOW than were ever qualified-column.
  // Cohort of 100 leads; 60 reached qualified, 50 booked, 20 attended, 10 paid.
  const steps = cohortFunnelSteps({ cohort: 100, reached_qualified: 60, reached_booked: 50, reached_attended: 20, reached_paid: 10, lost: 0, lost_precio: 0, lost_horario: 0, lost_no_respondio: 0, lost_no_asistio: 0, lost_otro: 0 });
  assert.deepEqual(steps.map((s) => s.reached), [100, 60, 50, 20, 10], 'reached is monotonic (Lead ≥ … ≥ Pagó)');
  assert.deepEqual(steps.map((s) => s.convPct), [null, 60, 83, 40, 50], 'conversion = reached(next) ÷ reached(prev)');
  for (const s of steps) if (s.convPct !== null) assert.ok(s.convPct <= 100, `${s.label} ≤ 100%`);
});

test('JP-7b §1 cohortFunnelSteps caps a degenerate ratio at 100% (never the old 150%/353%)', () => {
  // Even if the data were inconsistent (more booked than qualified), the % is clamped, not >100.
  const steps = cohortFunnelSteps({ cohort: 10, reached_qualified: 4, reached_booked: 9, reached_attended: 0, reached_paid: 0, lost: 0, lost_precio: 0, lost_horario: 0, lost_no_respondio: 0, lost_no_asistio: 0, lost_otro: 0 });
  const booked = steps.find((s) => s.stage === 'booked')!;
  assert.equal(booked.convPct, 100, 'clamped to 100%, never 225%');
});

test('JP-7b §1 cohortTopLoss: the most common loss reason (or null)', () => {
  assert.equal(cohortTopLoss({ cohort: 50, reached_qualified: 0, reached_booked: 0, reached_attended: 0, reached_paid: 0, lost: 0, lost_precio: 0, lost_horario: 0, lost_no_respondio: 0, lost_no_asistio: 0, lost_otro: 0 }), null, 'no losses → null');
  assert.deepEqual(cohortTopLoss({ cohort: 50, reached_qualified: 0, reached_booked: 0, reached_attended: 0, reached_paid: 0, lost: 7, lost_precio: 2, lost_horario: 5, lost_no_respondio: 0, lost_no_asistio: 0, lost_otro: 0 }), { reason: 'horario', count: 5 });
});

test('JP-9 cohort period: last-closed-month default, month range, custom cross-month, "en curso" rule', () => {
  const now = new Date('2026-11-04T12:00:00Z');
  assert.equal(resolveCohortPeriod(undefined).key.length, 7, 'default resolves to a YYYY-MM month (the last closed one)');
  const oct = cohortPeriodRange('2026-10', now);
  assert.equal(oct.fromIso, new Date(Date.UTC(2026, 9, 1)).toISOString(), 'October starts 1 Oct');
  assert.equal(oct.toIso, new Date(Date.UTC(2026, 10, 1)).toISOString(), 'and ends 1 Nov');
  assert.equal(oct.label, 'Leads de octubre');
  // October just closed → late-Oct leads still within the 14-day window on the 4th → "en curso".
  assert.equal(oct.inProgress, true);
  assert.equal(cohortPeriodRange('2026-10', new Date('2026-11-20T12:00:00Z')).inProgress, false, 'settled by late Nov');
  const custom = cohortPeriodRange('custom', now, '2026-10-15', '2026-11-10');
  assert.equal(custom.label, 'Leads del 15 oct al 10 nov', 'a custom cross-month range');
  assert.equal(custom.fromIso, new Date(Date.UTC(2026, 9, 15)).toISOString());
  assert.equal(custom.toIso, new Date(Date.UTC(2026, 10, 11)).toISOString(), 'inclusive end day');
  assert.equal(COHORT_SETTLING_DAYS, 14, 'the settling window is a reported constant');
});

test('JP-9 cohort month menu: current month "en curso", back to the earliest data month, most recent first', () => {
  const now = new Date('2026-11-04T12:00:00Z');
  const months = cohortMonths(new Date(Date.UTC(2026, 7, 1)), now); // earliest = August
  assert.equal(months[0].key, '2026-11');
  assert.ok(months[0].label.includes('(en curso)') && months[0].inProgress);
  assert.equal(months[months.length - 1].key, '2026-08', 'runs back to the earliest data month');
  // No data → still offers the current + last (closed, default) month.
  const bare = cohortMonths(null, now);
  assert.deepEqual(bare.map((m) => m.key), ['2026-11', '2026-10']);
});

test('JP-9 cohort strip: month selector + reached funnel + Conversión; no money, no current counts', () => {
  const strip = PANEL.slice(PANEL.indexOf('function CohortStrip'), PANEL.indexOf('function topLossPhrase'));
  assert.ok(strip.includes('step.reached') && strip.includes('step.convPct'), 'reached-count + conversion funnel');
  assert.ok(strip.includes('Conversión') && strip.includes('paid / size'), 'Conversión = reached Pagó ÷ cohort Lead');
  assert.ok(!strip.includes('priceLabelCOP') && !strip.includes('columnMoney'), 'no money in the strip');
  assert.ok(!strip.includes('groupBoard') && !strip.includes('colCards'), 'no current-column counts in the strip');
  assert.ok(PANEL.includes('<CohortSelector'), 'a month selector drives the cohort period');
});

test('JP-9 Lead preview is the CUSTOMER message only; business-last → "Esperando al cliente"', () => {
  assert.ok(PANEL.includes('card.spokeLast === "customer"') && PANEL.includes('card.lastMessageAt'), 'preview only when the customer spoke last');
  assert.ok(PANEL.includes('"Esperando al cliente"'), 'business-last shows a waiting note, never the bot/team text');
  assert.ok(PANEL.includes('Te escribió'), 'customer-waiting shows the attention line');
});

test('JP-9 one meaning per colour: urgent border, neutral "Cobro pendiente", neutral paid amount, attention tab', () => {
  assert.ok(PANEL.includes('border-[var(--warn-rule)]'), 'only urgent cards get the attention border');
  const attended = PANEL.slice(PANEL.indexOf('card.stage === "attended"'), PANEL.indexOf('// paid'));
  assert.ok(attended.includes('Cobro pendiente') && attended.includes('icon="clock"'), '"Cobro pendiente" is a muted clock line');
  assert.ok(!PANEL.includes('text-[var(--success)]'), 'paid amounts are neutral, not green (per the mockup)');
  assert.ok(PANEL.includes('tone === "attention" ? "text-warn"'), 'only the attention state uses the warn colour');
});

test('JP-9 clicking a card opens the drawer (board / list / Perdidos), keyed fresh', () => {
  assert.ok(PANEL.includes('onClick={onOpen}'), 'the card body opens the drawer');
  assert.ok(PANEL.includes('onOpen={() => setSelected(c)}'), 'the board wires the drawer open');
  assert.ok(PANEL.includes('onClick={() => onOpen(c)}'), 'a list row opens the drawer');
  assert.ok(PANEL.includes('onClick={() => setSelected(c)}'), 'a Perdidos row opens the drawer');
  assert.ok(PANEL.includes('<OpportunityDrawer') && PANEL.includes('key={selected.id}'), 'the drawer mounts fresh per selection');
  assert.ok(PANEL.includes('trapActive={modal === null}'), 'the drawer trap yields to a layered modal');
});

test('JP-9 cardUrgency + sortBoardColumn: customer-waiting / today-unconfirmed / overdue-unpaid; urgent first', () => {
  const now = new Date('2026-11-04T15:00:00Z');
  const leadWaiting = mkCard({ id: 'l', stage: 'lead', spokeLast: 'customer' });
  const leadCalm = mkCard({ id: 'lc', stage: 'lead', spokeLast: 'business' });
  assert.equal(cardUrgency(leadWaiting, now), 'lead_waiting');
  assert.equal(cardUrgency(leadCalm, now), null);
  const bookedToday = mkCard({ id: 'b', stage: 'booked', apptStartAt: now.toISOString(), apptTz: 'America/Bogota', apptStatus: 'scheduled' });
  assert.equal(cardUrgency(bookedToday, now), 'reservo_today_unconfirmed');
  assert.equal(cardUrgency({ ...bookedToday, apptStatus: 'confirmed' }, now), null, 'confirmed is not urgent');
  const overdue = mkCard({ id: 'a', stage: 'attended', hasPayment: false, stageSince: new Date(now.getTime() - 3 * 86_400_000).toISOString() });
  assert.equal(cardUrgency(overdue, now), 'asistio_overdue');
  assert.equal(cardUrgency({ ...overdue, stageSince: new Date(now.getTime() - 3_600_000).toISOString() }, now), null, '≤ 1 day is not overdue');
  assert.equal(cardUrgency({ ...overdue, hasPayment: true }, now), null, 'paid is never overdue');
  assert.equal(sortBoardColumn([leadCalm, leadWaiting], now)[0].id, 'l', 'urgent cards sort first');
});

test('JP-9 contactAvatar: initials for a real name, "#" for masked phone, "?" (muted) for nameless', () => {
  assert.deepEqual(contactAvatar('Daniel Felipe', null, null), { avatar: 'DF', nameMuted: false });
  assert.deepEqual(contactAvatar('☆DaX☆', null, null), { avatar: 'D', nameMuted: false }, 'leading symbols skipped');
  assert.deepEqual(contactAvatar('sergio pabon', null, null), { avatar: 'SP', nameMuted: false });
  assert.deepEqual(contactAvatar(null, '+573229990000', null), { avatar: '#', nameMuted: false });
  assert.deepEqual(contactAvatar('.', null, null), { avatar: '?', nameMuted: true });
});

test('JP-9 reminderText (Recordar): a ready reminder, never auto-sent', () => {
  const card = mkCard({ stage: 'booked', name: 'Kevin Steven', apptService: 'Corte', apptStaffName: 'Paola', apptStartAt: '2026-11-05T15:30:00.000Z', apptTz: 'America/Bogota' });
  const text = reminderText(card, new Date('2026-11-04T12:00:00Z'));
  assert.ok(text.startsWith('Hola Kevin Steven, te recordamos tu cita de corte'), 'personalised reminder');
  assert.ok(text.includes('con Paola'), 'names the barber');
  // The panel writes it to the composer draft key, then opens the conversation (no send).
  assert.ok(PANEL.includes('sessionStorage.setItem(`inbox-draft:') && PANEL.includes('reminderText('), 'Recordar pre-types the draft');
  assert.ok(!/send|enviar/i.test(PANEL.slice(PANEL.indexOf('const recordar'), PANEL.indexOf('const grouped'))), 'Recordar never sends');
});

test('JP-9 per-stage action buttons map to the right surfaces', () => {
  // The CardAction block wires each stage's button to the existing action/route.
  const action = PANEL.slice(PANEL.indexOf('function CardAction'), PANEL.indexOf('function urgencyReason'));
  assert.ok(action.includes('"Responder"') && action.includes('onResponder'), 'Lead urgent → Responder');
  assert.ok(action.includes('"Calificar"') && action.includes('onCalificar'), 'Lead calm → Calificar');
  assert.ok(action.includes('"Agendar"') && action.includes('"Escribir"'), 'Calificado → Agendar / Escribir');
  assert.ok(action.includes('"Confirmar"') && action.includes('"Recordar"'), 'Reservó → Confirmar / Recordar');
  assert.ok(action.includes('"Cobrar"'), 'Asistió → Cobrar');
  assert.ok(action.includes('aria: `Cobrar a ${name}`') || action.includes('`Cobrar a ${name}`'), 'the Cobrar button names the contact');
  // The handlers call the existing engine actions / routes.
  assert.ok(PANEL.includes('confirmAppointmentAction(clientId, c.apptId') && PANEL.includes('scheduling/agenda?appt=') && PANEL.includes('scheduling/agenda?book=') && PANEL.includes('inbox?c='), 'wired to confirm action, charge/agenda, new-cita, and the inbox');
});

test('JP-7 part 3: the drawer shows the sale in full and reuses the engine actions', () => {
  // Every section the brief asks for.
  for (const section of ['Progreso', 'Calificación', 'Pago', 'Últimos mensajes', 'Historial']) {
    assert.ok(DRAWER.includes(`title="${section}"`), `drawer section: ${section}`);
  }
  assert.ok(/title=\{data\.appointments\.length > 1 \? "Citas" : "Cita"\}/.test(DRAWER), 'the linked appointment(s)');
  assert.ok(DRAWER.includes('Abrir conversación') && DRAWER.includes('/inbox?c='), 'a link into the Inbox');
  assert.ok(DRAWER.includes('Ver ficha') && DRAWER.includes('/contacts/'), '"Ver ficha" → the contact record');
  // The actions are the SAME ones as the card — delegated to the parent (which calls the engine).
  for (const action of ['onQualify', 'onUnqualify', 'onLose', 'onReopen']) {
    assert.ok(DRAWER.includes(action), `drawer action: ${action}`);
  }
  // The reads load via the server action in an async effect (state only set in `.then` — lint-safe).
  assert.ok(DRAWER.includes('loadOpportunityDrawerAction(clientId, card.id).then('), 'the drawer loads via the action, async');
  // Motion answers the user's action and honours reduced motion (existing u-drawer-in utility, no new keyframes).
  assert.ok(DRAWER.includes('u-drawer-in'), 'the drawer uses the reduced-motion-safe slide-in');
});

test('JP-7 part 3: the drawer loader gates on pipeline.view, gates money on payments.view, and never reads commission', () => {
  assert.ok(ACTIONS.includes('export async function loadOpportunityDrawerAction'), 'the loader exists');
  assert.ok(/resolveClientModuleContext\(clientId, "crm", "pipeline\.view"\)/.test(ACTIONS), 'gated by pipeline.view under CRM');
  assert.ok(ACTIONS.includes('can(scope, "payments.view", clientId)'), 'the payment summary is gated by payments.view');
  // Actor tokens resolve to a human label (bot / system / a member name).
  assert.ok(ACTIONS.includes('"Sistema"') && ACTIONS.includes('"Bot"'), 'actor tokens resolve to plain words');
  // Money shown is amount + method only — the drawer read must never touch commission.
  assert.ok(!/commission/i.test(ACTIONS) && !/comisi[oó]n/i.test(ACTIONS), 'the drawer never reads commission');
});

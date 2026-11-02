import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  BOARD_STAGES,
  COHORT_SETTLING_DAYS,
  STALE_LEAD_MINUTES,
  STALE_QUALIFIED_HOURS,
  apptLineOf,
  cohortFunnelSteps,
  cohortPeriodRange,
  cohortTopLoss,
  funnelSteps,
  resolveCohortPeriod,
  groupByStage,
  lossReasonCounts,
  originLineOf,
  originTitleOf,
  ownerInitials,
  qualificationLineOf,
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
  ...over,
});

/** A full BoardOpportunityRow with null defaults (JP-7 added many optional fields). */
const mkRow = (over: Partial<BoardOpportunityRow> & { id: string; contact_id: string; status: BoardOpportunityRow["status"]; stage: BoardOpportunityRow["stage"] }): BoardOpportunityRow => ({
  conversation_id: null, created_at: new Date(), stage_since: new Date(), lost_reason: null, lost_note: null, closed_at: null,
  contact_name: null, contact_channel_user_id: null, contact_phone_e164: null, origin_kind: null,
  ad_name: null, ad_headline: null, ad_is_test: null, campaign_name: null, last_sender: null, last_message_at: null,
  paid_total: null, paid_method: null, last_message_text: null, qualification_service: null, qualification_timeframe: null,
  qualified_by: null, qualified_by_name: null, appt_start_at: null, appt_status: null, appt_tz: null, appt_list_price: null,
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

test('JP-6 PipelinePanel board: Pagó is a real column; paid cards show amount+method, attended shows "Cobro pendiente"', () => {
  assert.ok(PANEL.includes('overflow-y-auto'), 'columns scroll on their own');
  assert.ok(PANEL.includes('snap-x'), 'the board scroll-snaps per column when it overflows');
  // The placeholder is gone and Pagó renders like any other column.
  assert.ok(!PANEL.includes('Llega con la fase de pagos') && !PANEL.includes('[writing-mode:vertical-rl]'), 'the disabled placeholder is removed');
  assert.ok(!PANEL.includes('col.disabled'), 'no special-cased disabled column');
  // Money state on the card: paid shows the recorded amount + method; attended awaits a charge.
  assert.ok(PANEL.includes('card.stage === "paid"') && PANEL.includes('priceLabelCOP(card.paidAmount)') && PANEL.includes('card.paidMethod'), 'paid card shows amount + method');
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

test('JP-7 the panel renders gated column money, stage card lines, stale edge, and the Perdidos header', () => {
  assert.ok(PANEL.includes('columnMoney[col.key]') && PANEL.includes('moneyTotals'), 'column money shown only when totals are present (revenue only)');
  assert.ok(PANEL.includes('qualificationLineOf') && PANEL.includes('apptLineOf') && PANEL.includes('card.lastMessageText'), 'per-stage card lines');
  assert.ok(PANEL.includes('(lista)') && PANEL.includes('Cobro pendiente'), 'Asistió shows the pending list amount');
  assert.ok(PANEL.includes('card.stale') && PANEL.includes('--warn-rule'), 'a stale card gets a calm warn edge (never error red)');
  assert.ok(PANEL.includes('ownerInitials') && PANEL.includes('Dueño:'), 'the owner avatar + title');
  assert.ok(PANEL.includes('Motivos de pérdida') && PANEL.includes('LOST_REASON_LABEL[reason]'), 'the Perdidos loss-reason header');
});

test('JP-7 part 2: the panel offers search, owner filter, "waiting" toggle, and a Tablero/Lista view', () => {
  // Search is a form that writes ?q=; owner is a select (incl. "Sin dueño"); waiting is a client lens.
  assert.ok(PANEL.includes("apply({ q: searchDraft.trim() })"), 'search submits ?q=');
  assert.ok(PANEL.includes('label="Dueño"') && PANEL.includes('"unassigned"'), 'owner filter incl. unassigned');
  assert.ok(PANEL.includes('Esperan respuesta') && PANEL.includes('c.spokeLast === "customer"'), 'waiting lens filters to customer-last');
  // View toggle persisted per user (localStorage via an external store — no setState-in-effect).
  assert.ok(PANEL.includes('useSyncExternalStore(viewPref.subscribe') && PANEL.includes('localStorage.setItem(key'), 'the Tablero/Lista choice is remembered per user, SSR-safe');
  // List view: a sortable table with the required columns.
  assert.ok(PANEL.includes('function BoardListView'), 'the list view exists');
  for (const col of ['Contacto', 'Etapa', 'Origen / anuncio', 'Servicio', 'Cita', 'En etapa', 'Último mensaje', 'Dueño']) {
    assert.ok(PANEL.includes(`label="${col}"`) || PANEL.includes(`>${col}<`), `list column: ${col}`);
  }
  assert.ok(PANEL.includes('aria-sort='), 'columns are sortable (aria-sort)');
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

test('JP-7b §1 period presets: closed default + the "En curso" rule at the settling window', () => {
  const now = new Date('2026-11-02T12:00:00Z');
  const lastMonth = cohortPeriodRange('mes_pasado', now);
  assert.equal(lastMonth.fromIso, new Date(Date.UTC(2026, 9, 1)).toISOString(), 'Mes pasado starts 1 Oct');
  assert.equal(lastMonth.toIso, new Date(Date.UTC(2026, 10, 1)).toISOString(), 'and ends 1 Nov (a CLOSED month)');
  assert.equal(lastMonth.entrada, 'en octubre');
  // Early in November, late-October leads are still within the 14-day settling window → En curso.
  assert.equal(lastMonth.inProgress, true, 'the month just closed, so it is still settling');
  // By late November that same month has fully settled.
  assert.equal(cohortPeriodRange('mes_pasado', new Date('2026-11-20T12:00:00Z')).inProgress, false, 'by 20 Nov, October has settled');
  // "Últimos 30 días" ends today → inside the settling window → En curso.
  assert.equal(cohortPeriodRange('ultimos_30', now).inProgress, true);
  // "Hace 30–60 días" ends 30 days ago → settled.
  assert.equal(cohortPeriodRange('hace_30_60', now).inProgress, false);
  // An invalid/absent preset falls back to the closed default.
  assert.equal(resolveCohortPeriod('bogus').preset, 'mes_pasado');
  assert.equal(COHORT_SETTLING_DAYS, 14, 'the settling window is a reported constant');
});

test('JP-7b §2 the cohort strip shows no money and no current-column counts (numbers appear once)', () => {
  // The strip renders cohort reached-counts + conversion; it must NOT carry money or groupByStage counts.
  const strip = PANEL.slice(PANEL.indexOf('function CohortStrip'), PANEL.indexOf('function CohortPeriodControl'));
  assert.ok(strip.includes('step.reached') && strip.includes('step.convPct'), 'the strip shows reached + conversion');
  assert.ok(!strip.includes('priceLabelCOP') && !strip.includes('columnMoney'), 'no money in the strip');
  assert.ok(!strip.includes('groupByStage') && !strip.includes('colCards'), 'no current-column counts in the strip');
  assert.ok(PANEL.includes('que entraron ${period.entrada}'), 'the strip is titled with the cohort + its period');
});

test('JP-7b §4 the Lead preview is the CUSTOMER\'s message only; else "Esperando al cliente"', () => {
  assert.ok(PANEL.includes('card.spokeLast === "customer" && card.lastMessageText'), 'preview only when the customer spoke last');
  assert.ok(PANEL.includes('"Esperando al cliente"'), 'business-last shows a waiting note, never the bot/team text');
  assert.ok(PANEL.includes('QUALIFY_BTN') && PANEL.includes('border border-line-strong'), 'Calificar is a compact ghost button, not a solid black block');
});

test('JP-7b §5 one meaning per colour', () => {
  // Stale = the left edge only; the time text is NOT warn-coloured.
  assert.ok(PANEL.includes('border-l-[var(--warn-rule)]'), 'stale = the left edge (warn rule)');
  assert.ok(!/stale \? "font-medium text-warn"/.test(PANEL), 'the time is never re-coloured for stale');
  // "Cobro pendiente" is neutral text + an icon, not the warn colour.
  const attended = PANEL.slice(PANEL.indexOf('card.stage === "attended" ?'), PANEL.indexOf('card.stage === "paid" ?'));
  assert.ok(attended.includes('text-muted') && !attended.includes('text-warn'), '"Cobro pendiente" is neutral');
  assert.ok(attended.includes('<ClockIcon'), 'and carries a small icon');
  // Money collected stays success green; the Sin respuesta badge keeps the attention colour.
  assert.ok(PANEL.includes('text-[var(--success)]'), 'collected money = success green');
  assert.ok(PANEL.includes('countTone="warn"'), 'the Sin respuesta tab badge keeps the attention colour');
});

test('JP-7 part 3: clicking a card (board / list / Perdidos) opens the opportunity drawer — not a page change', () => {
  // The board card name is a BUTTON that opens the drawer; "Ver ficha" (the contact page) stays in the menu.
  assert.ok(PANEL.includes('onClick={onOpen}'), 'the card name opens the drawer');
  assert.ok(PANEL.includes('onOpen={() => setSelected(c)}'), 'the board wires the drawer open');
  assert.ok(PANEL.includes('onClick={() => onOpen(c)}'), 'a list row opens the drawer');
  assert.ok(PANEL.includes('<MenuLink href={contactHref}>Ver ficha</MenuLink>'), '"Ver ficha" still links to the contact record');
  // The drawer is rendered beside the board, keyed on the selected card so each selection mounts fresh.
  assert.ok(PANEL.includes('<OpportunityDrawer') && PANEL.includes('key={selected.id}'), 'the drawer mounts fresh per selection');
  // Its trap pauses while a Calificar/Perder modal is layered over it.
  assert.ok(PANEL.includes('trapActive={modal === null}'), 'the drawer trap yields to a layered modal');
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

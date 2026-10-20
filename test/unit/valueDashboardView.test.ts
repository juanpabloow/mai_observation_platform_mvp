import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  addBuckets,
  bucket,
  bucketState,
  computeEstimate,
  deltaOf,
  emptyLens,
  lensFromRows,
  pendingProposal,
  resolvePeriod,
  versionForDay,
  type AssumptionVersion,
  type UnitDay,
  type ValueDashboardData,
} from '../../src/analytics/valueDashboardModel.js';
import {
  channelRows,
  dailyBars,
  detailGroups,
  estimateView,
  evidenceCopy,
  fmtCOP,
  fmtRange,
  kpis,
  outOfHoursView,
  qualityRows,
  reservationNotes,
} from '../../web/lib/valueDashboardView.js';

/* ---------------------------------------------------------------- buckets -- */

test('a $0 saved price is a real price; no price is unknown; some missing is partial', () => {
  assert.deepEqual(bucket(0, 0, null), { count: 0, withPrice: 0, value: 0 }, 'empty group = measured 0');
  assert.equal(bucketState(bucket(2, 2, 0)), 'complete', 'two free appointments: $0, complete');
  assert.equal(bucket(2, 2, 0).value, 0);
  assert.equal(bucketState(bucket(2, 0, null)), 'unknown');
  assert.equal(bucket(2, 0, null).value, null, 'unknown is null, never 0');
  assert.equal(bucketState(bucket(3, 2, 100)), 'partial');
  const mixed = addBuckets(bucket(1, 1, 0), bucket(1, 0, null));
  assert.deepEqual(mixed, { count: 2, withPrice: 1, value: 0 }, 'free + unpriced: $0 of the priced one, 1 missing');
  assert.equal(bucketState(mixed), 'partial');
});

/* ----------------------------------------------------------------- periods -- */

test('periods in the business timezone; custom validated; comparison is the previous equal window', () => {
  const now = new Date('2026-10-19T03:00:00Z'); // still 18 oct in Bogotá
  const p7 = resolvePeriod({ key: '7' }, now, 'America/Bogota');
  assert.ok(p7.ok);
  assert.equal(p7.period.toDay, '2026-10-18');
  assert.equal(p7.period.fromDay, '2026-10-12');
  assert.equal(p7.period.prevFromDay, '2026-10-05');
  assert.equal(p7.period.prevToDay, '2026-10-11');
  assert.equal(p7.period.startUtc, '2026-10-12T05:00:00.000Z');
  assert.equal(p7.period.endUtc, '2026-10-19T05:00:00.000Z');
  const c = resolvePeriod({ key: 'custom', from: '2026-10-01', to: '2026-10-15' }, now, 'America/Bogota');
  assert.ok(c.ok && c.period.days === 15 && c.period.prevFromDay === '2026-09-16');
  for (const bad of [
    { from: '2026-10-15', to: '2026-10-01' },
    { from: '2026-10-01', to: '2026-10-25' },
    { from: '2026-02-30', to: '2026-03-01' },
    { from: '2026-01-01', to: '2026-10-01' },
  ])
    assert.equal(resolvePeriod({ key: 'custom', ...bad }, now, 'America/Bogota').ok, false, JSON.stringify(bad));
});

/* ----------------------------------------------------------------- deltas -- */

test('deltas: never from unknown or partial amounts; previous 0 is not a %', () => {
  const on = { available: true, reason: null };
  assert.deepEqual(deltaOf({ value: 120, exact: true }, { value: 100, exact: true }, 'x', on), { kind: 'pct', pct: 20, prevLabel: 'x' });
  assert.equal(deltaOf({ value: null, exact: false }, { value: 100, exact: true }, 'x', on).kind, 'unavailable');
  assert.equal(deltaOf({ value: 90, exact: false }, { value: 100, exact: true }, 'x', on).kind, 'unavailable');
  assert.equal(deltaOf({ value: 5, exact: true }, { value: 0, exact: true }, 'x', on).kind, 'no_prev_activity');
  assert.equal(deltaOf({ value: 5, exact: true }, { value: 3, exact: true }, 'x', { available: false, reason: 'r' }).kind, 'unavailable');
});

/* -------------------------------------------------------------- estimates -- */

const v = (o: Partial<AssumptionVersion>): AssumptionVersion => ({
  id: o.id ?? 'v',
  status: 'confirmed',
  methodVersion: 'v1',
  minConversacionAtendida: 3,
  minConversacionConCita: 8,
  minAgendarManual: 5,
  costoHora: 18000,
  effectiveFrom: '2026-10-01',
  proposedBy: 'agency',
  proposedAt: '2026-09-01T00:00:00Z',
  confirmedBy: 'owner',
  confirmedAt: '2026-09-02T00:00:00Z',
  basedOnId: null,
  ...o,
});
const days = (n: number, u: Partial<UnitDay> = {}): UnitDay[] =>
  Array.from({ length: n }, (_, i) => ({ day: `2026-10-${String(i + 1).padStart(2, '0')}`, u1: null, u2: null, u3: 1, ...u }));

test('estimate: no versions → not configured; only proposals → proposed (no figure)', () => {
  assert.equal(computeEstimate(days(3), [], false).state, 'not_configured');
  const p = computeEstimate(days(3), [v({ status: 'proposed', confirmedAt: null, confirmedBy: null })], false);
  assert.equal(p.state, 'proposed');
  assert.equal(p.minutes, null, 'a proposal never produces a number');
});

test('estimate: each day uses the version in effect; no silent retroactivity; public-only when conversations are off', () => {
  const units = days(10, { u1: 2, u2: 1, u3: 1 });
  const a = v({ id: 'a', effectiveFrom: '2026-10-04', confirmedAt: '2026-10-04T10:00:00Z' });
  const off = computeEstimate(units, [a], false);
  assert.equal(off.publicOnly, true);
  assert.equal(off.u1, null);
  assert.equal(off.coveredDays, 7, 'days before effective_from are not estimated');
  assert.equal(off.minutes, 7 * 5);
  const on = computeEstimate(units, [a], true);
  assert.equal(on.minutes, 7 * (2 * 3 + 1 * 8 + 5));
  assert.equal(on.value, Math.round((on.minutes! / 60) * 18000));
  // A later confirmation from the 8th supersedes only from the 8th.
  const b = v({ id: 'b', minAgendarManual: 10, effectiveFrom: '2026-10-08', confirmedAt: '2026-10-09T10:00:00Z' });
  const both = computeEstimate(units, [a, b], false);
  assert.equal(both.minutes, 4 * 5 + 3 * 10);
  assert.equal(both.u3!.perUnit, null, 'two rates → no single «× N min» claim');
  assert.equal(versionForDay([b, a], '2026-10-05')!.id, 'a');
  // A confirmation dated to the future does not apply to this period.
  assert.equal(computeEstimate(units, [v({ effectiveFrom: '2026-11-01' })], false).state, 'not_in_effect');
});

test('pending proposal = a proposal newer than the latest confirmation', () => {
  const conf = v({ confirmedAt: '2026-10-05T00:00:00Z' });
  const old = v({ id: 'p1', status: 'proposed', proposedAt: '2026-10-01T00:00:00Z', confirmedAt: null });
  const fresh = v({ id: 'p2', status: 'proposed', proposedAt: '2026-10-06T00:00:00Z', confirmedAt: null });
  assert.equal(pendingProposal([conf, old]), null);
  assert.equal(pendingProposal([conf, old, fresh])!.id, 'p2');
});

/* ------------------------------------------------------ presentation copy -- */

function fixture(over: Partial<ValueDashboardData> = {}): ValueDashboardData {
  const period = resolvePeriod({ key: '30' }, new Date('2026-10-19T17:00:00Z'), 'America/Bogota');
  if (!period.ok) throw new Error('period');
  return {
    generatedAt: '2026-10-19T17:00:00Z',
    tz: 'America/Bogota',
    client: { id: 'c', name: 'Negocio' },
    sites: [{ id: 's', name: 'Sede' }],
    viewer: 'owner',
    canPropose: true,
    canConfirm: true,
    period: period.period,
    schedulingSince: '2025-01-01T00:00:00Z',
    comparison: { available: true, reason: null },
    coverage: null,
    created: emptyLens(),
    dated: emptyLens(),
    prevCreated: emptyLens(),
    prevDated: emptyLens(),
    daily: [],
    outOfHours: { antes_de_abrir: 0, despues_de_cerrar: 0, dia_sin_atencion: 0, en_pausa: 0, dentro: 0, sin_horario: 0 },
    botActions: { rescheduled: 0, cancelled: 0, confirmed: 0 },
    cohort: { tracking: null, rows: [] },
    health: { executions: 0, errors: 0, workflows: [] },
    evidence: {
      habilitable: false,
      hasConversational: true,
      review: null,
      enabled: false,
      reason: 'contrast_insufficient',
      workflows: [],
      params: { ventana: '30 minutes', tolerancia: '2 minutes', umbral: 0.95, minimo: 50, methodVersion: 'v3.1' },
    },
    conversations: null,
    units: [],
    prevUnits: [],
    assumptions: { versions: [], people: {} },
    ...over,
  };
}

const BANNED = [/ahorr(o|ado)/i, /resuelt/i, /cobrad[oa]\b(?! )/i, /facturad/i, /verificad/i, /Completa el precio del servicio/i, /se habrían perdido(?! sin)/i];
function allText(d: ValueDashboardData): string {
  const ev = estimateView(d);
  const parts: unknown[] = [kpis(d, ev), qualityRows(d), outOfHoursView(d), evidenceCopy(d)];
  for (const lens of ['creadas', 'atendidas'] as const)
    for (const mode of ['count', 'value'] as const) parts.push(channelRows(d, lens, mode), reservationNotes(d, lens, mode));
  for (const m of ['res', 'val', 'comp', 'time'] as const) parts.push(detailGroups(d, m, ev));
  return JSON.stringify(parts);
}
function assertCopyRules(d: ValueDashboardData, label: string) {
  const t = allText(d);
  for (const re of BANNED) {
    // The two allowed phrasings that NEGATE the claim («no es dinero cobrado», «no significa resuelta»).
    const cleaned = t.replace(/no es dinero cobrado/gi, '').replace(/no equivale a dinero cobrado/gi, '').replace(/no dinero cobrado/gi, '');
    assert.ok(!re.test(cleaned), `${label}: banned wording ${re}`);
  }
}

test('copy: all prices missing → «Valor desconocido», never $0, and no backfill instruction', () => {
  const created = lensFromRows([
    { canal: 'n8n', estado: 'completed', count: 3, withPrice: 0, value: null },
    { canal: 'public', estado: 'scheduled', count: 2, withPrice: 0, value: null },
  ]);
  const d = fixture({ created, dated: created });
  const k = kpis(d, estimateView(d));
  assert.equal(k[1].value, 'Valor desconocido');
  assert.equal(k[2].value, 'Valor desconocido');
  assert.ok(!JSON.stringify(k).includes('$0'));
  assert.ok(reservationNotes(d, 'creadas', 'value').some((n) => n.text.includes('desconocido, no $0')));
  assertCopyRules(d, 'all unpriced');
});

test('copy: free appointments ($0 saved) → $0, explained as a real price, not as missing', () => {
  const created = lensFromRows([{ canal: 'public', estado: 'completed', count: 2, withPrice: 2, value: 0 }]);
  const d = fixture({ created, dated: created });
  const k = kpis(d, estimateView(d));
  assert.equal(k[1].value, '$0');
  assert.equal(k[1].note, 'Precio guardado en la cita, no dinero cobrado');
  const notes = reservationNotes(d, 'creadas', 'value');
  assert.ok(notes.some((n) => n.text.includes('$0 (servicios gratuitos)')));
  assert.ok(!notes.some((n) => n.warn), 'no missing-price warning');
  assertCopyRules(d, 'free');
});

test('copy: mix of priced and unpriced → partial value with the missing count', () => {
  const created = lensFromRows([
    { canal: 'n8n', estado: 'completed', count: 4, withPrice: 3, value: 150000 },
    { canal: 'n8n', estado: 'cancelled', count: 1, withPrice: 1, value: 50000 },
  ]);
  const d = fixture({ created, dated: created });
  const k = kpis(d, estimateView(d));
  assert.equal(k[1].value, fmtCOP(150000));
  assert.equal(k[1].note, '1 cita sin precio fuera del cálculo');
  const g = detailGroups(d, 'val', estimateView(d));
  assert.ok(!JSON.stringify(g).includes('Completa el precio'), 'removed backfill text');
  assertCopyRules(d, 'mix');
});

test('copy: no activity → measured zeros; estimate not configured has no number', () => {
  const d = fixture();
  const k = kpis(d, estimateView(d));
  assert.equal(k[0].value, '0');
  assert.equal(k[1].value, '$0');
  assert.equal(k[3].value, 'Configura tu estimación');
  assert.equal(outOfHoursView(d).pct, 'Sin reservas del bot en el periodo');
  assertCopyRules(d, 'empty');
});

test('copy: tracking mid-period and comparison unavailable are stated', () => {
  const d = fixture({
    comparison: { available: false, reason: 'Sin comparación: la agenda registra citas desde el 2026-10-02' },
    coverage: { coveredDays: 18, since: '2026-10-02' },
    cohort: { tracking: { startedAt: '2026-10-07T05:00:00Z', effectiveStart: '2026-10-07T05:00:00Z', partial: true }, rows: [] },
    created: lensFromRows([{ canal: 'n8n', estado: 'completed', count: 1, withPrice: 1, value: 1000 }]),
  });
  const k = kpis(d, estimateView(d));
  assert.equal(k[0].delta.text, 'Sin comparación disponible');
  const q = qualityRows(d);
  assert.ok(q.find((r) => r.label === 'Reservas')!.text.includes('18 de 30 días'));
  assert.ok(q.find((r) => r.label === 'Origen de clientes')!.status.startsWith('Desde'));
  assertCopyRules(d, 'partial tracking');
});

test('copy: estimate confirmed without conversations is labelled partial, page-only', () => {
  const d = fixture({ assumptions: { versions: [v({ effectiveFrom: '2000-01-01' })], people: {} } });
  d.units = Array.from({ length: 30 }, (_, i) => ({ day: `2026-10-${String(i + 1).padStart(2, '0')}`, u1: null, u2: null, u3: i % 2 }));
  const ev = estimateView(d);
  const k = kpis(d, ev);
  assert.equal(k[3].note, 'Estimación parcial: solo página de reservas');
  assert.equal(k[3].kind, 'estimate');
  assertCopyRules(d, 'estimate partial');
});

test('format: ranges in Spanish and exact pesos', () => {
  assert.equal(fmtRange('2026-09-19', '2026-10-18'), '19 sep – 18 oct 2026');
  assert.equal(fmtRange('2026-10-12', '2026-10-18'), '12 – 18 oct 2026');
  assert.equal(fmtRange('2025-12-20', '2026-01-18'), '20 dic 2025 – 18 ene 2026');
  assert.equal(fmtCOP(1234500), '$1.234.500');
  assert.equal(fmtCOP(500), '$500', 'no rounding to thousands');
});

test('tooltips: exact numbers per segment and per day; unknown stays unknown, never $0', () => {
  const created = lensFromRows([
    { canal: 'n8n', estado: 'completed', count: 3, withPrice: 2, value: 90000 },
    { canal: 'n8n', estado: 'cancelled', count: 1, withPrice: 1, value: 40000 },
    { canal: 'public', estado: 'scheduled', count: 2, withPrice: 0, value: null },
  ]);
  const d = fixture({ created, dated: created });
  const bot = channelRows(d, 'creadas', 'count').find((r) => r.channel === 'n8n')!;
  const done = bot.segments.find((x) => x.key === 'completed')!;
  assert.equal(done.tip.title, 'Bot de WhatsApp · Completadas');
  assert.deepEqual(done.tip.lines, ['3 citas · 75% del canal', '$90.000 · 1 cita sin precio']);
  const canc = bot.segments.find((x) => x.key === 'cancelled')!;
  assert.equal(canc.tip.lines[1], '$40.000 · no suma al valor');
  const page = channelRows(d, 'creadas', 'value').find((r) => r.channel === 'public')!;
  assert.ok(page.segments.find((x) => x.key === 'pending')!.tip.lines[0].startsWith('Valor desconocido'));

  d.daily = [
    { day: '2026-10-05', created: 2, reserved: { count: 2, withPrice: 0, value: null }, completed: { count: 0, withPrice: 0, value: 0 } },
  ];
  const ev = estimateView(d);
  const [val] = dailyBars(d, 'val', ev);
  assert.equal(val.v, null);
  assert.equal(val.tip.title, '5 oct 2026');
  assert.deepEqual(val.tip.lines, ['Valor desconocido: sin precio guardado', '2 citas vigentes']);
  const [res] = dailyBars(d, 'res', ev);
  assert.deepEqual(res.tip.lines, ['2 reservas automatizadas', 'Valor vigente desconocido: sin precio guardado']);
});

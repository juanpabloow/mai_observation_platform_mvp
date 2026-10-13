import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  freshaKey,
  localDay,
  planFreshaReconciliation,
  type FreshaSnapshot,
  type MaiSnapshot,
  type ReconcileMapping,
  type ReconcileTarget,
} from '../../src/scheduling/reconcile/freshaPlan.js';

/**
 * The Fresha → M_AI dry-run planner, on ANONYMISED fixtures shaped like the 12 Oct 2026
 * comparison at one barbershop with one site and two barbers. Ids are synthetic; no real
 * client, site, person or booking appears here.
 */
const TZ = 'America/Bogota';
const DAY = '2026-10-12';
const at = (hm: string, day = DAY) => `${day}T${hm}:00-05:00`;

const target: ReconcileTarget = { clientId: 'client-A', siteId: 'site-A', freshaLocationId: 'loc-1', days: [DAY] };

function fresha(over: Partial<FreshaSnapshot> = {}): FreshaSnapshot {
  return {
    locationId: 'loc-1',
    timezone: TZ,
    staff: [
      { id: 'f-barber-1', name: 'Barbero Uno (Fresha)' },
      { id: 'f-barber-2', name: 'Barbero Dos (Fresha)' },
      { id: 'f-other', name: 'Persona no reservable' },
    ],
    services: [
      { id: 'f-svc-cut', name: 'Corte estándar / Asesoría', durationMin: 55, price: 60000, description: 'Incluye asesoría', staffIds: ['f-barber-1', 'f-barber-2'] },
      { id: 'f-svc-sig', name: 'CORTE SIGNATURE', durationMin: 60, price: 100000, promotion: '2x1 martes' },
      { id: 'f-svc-new', name: 'Servicio sin par', durationMin: 30, price: 20000 },
    ],
    appointments: [{ id: 'f-a1', staffId: 'f-barber-1', serviceId: 'f-svc-cut', serviceName: 'Corte 2x1', start: at('11:45'), end: at('12:30'), status: 'booked' }],
    blocks: [
      // Barber 1: day blocked, no online booking.
      { id: 'f-b1', staffId: 'f-barber-1', kind: 'block', start: at('10:00'), end: at('20:00'), recurrence: null, allowsOnlineBooking: false, verified: true },
      // Barber 2: an unverified pause and a verified evening block.
      { id: 'f-b2', staffId: 'f-barber-2', kind: 'pause', start: at('12:25'), end: at('13:25'), recurrence: null, allowsOnlineBooking: false, verified: false },
      { id: 'f-b3', staffId: 'f-barber-2', kind: 'block', start: at('17:00'), end: at('20:00'), recurrence: null, allowsOnlineBooking: false, verified: true },
    ],
    ...over,
  };
}

function mai(over: Partial<MaiSnapshot> = {}): MaiSnapshot {
  const appt = (id: string, staffId: string, from: string, to: string, extra: Partial<MaiSnapshot['appointments'][number]> = {}) => ({
    id,
    siteId: 'site-A',
    clientId: 'client-A',
    staffId,
    serviceId: 'm-svc-cut',
    serviceNameSnapshot: 'Corte',
    durationMinSnapshot: 50,
    priceSnapshot: 60000,
    start: at(from),
    end: at(to),
    status: 'scheduled' as const,
    idempotencyKey: null,
    ...extra,
  });
  return {
    clientId: 'client-A',
    siteId: 'site-A',
    timezone: TZ,
    staff: [
      { id: 'm-barber-1', siteId: 'site-A', name: 'Barbero Uno', active: true, takesBookings: true },
      { id: 'm-barber-2', siteId: 'site-A', name: 'Barbero Dos', active: true, takesBookings: true },
    ],
    services: [
      { id: 'm-svc-cut', name: 'Corte', durationMin: 50, price: 60000, description: null, active: true },
      { id: 'm-svc-sig', name: 'Corte Signature', durationMin: 70, price: 100000, description: null, active: true },
    ],
    appointments: [
      appt('m-a1', 'm-barber-1', '12:00', '12:50'),
      appt('m-a2', 'm-barber-1', '14:00', '14:50', { markedTest: true }),
      appt('m-a3', 'm-barber-1', '15:00', '15:50', { markedTest: true }),
    ],
    exceptions: [],
    ...over,
  };
}

const mapping: ReconcileMapping = {
  staff: { 'f-barber-1': 'm-barber-1', 'f-barber-2': 'm-barber-2' },
  services: { 'f-svc-cut': { maiServiceId: 'm-svc-cut', confirmed: false }, 'f-svc-sig': { maiServiceId: 'm-svc-sig', confirmed: false } },
};

const plan = (f = fresha(), m = mai(), map = mapping) => planFreshaReconciliation({ target, fresha: f, mai: m, mapping: map });
const ofKind = (p: ReturnType<typeof plan>, kind: string) => p.actions.filter((a) => a.kind === kind);

test('it is a dry run: no action writes, and every action carries a stable key', () => {
  const p = plan();
  assert.equal(p.dryRun, true);
  assert.deepEqual(p.errors, []);
  for (const a of p.actions) assert.ok(a.key.length > 0, a.kind);
  // Deterministic: the same input gives the same plan (idempotent to compute and apply).
  assert.deepEqual(plan(), p);
});

test('identity is explicit: an unmapped Fresha person is ignored, never created', () => {
  const ignored = ofKind(plan(), 'ignore_unmapped_staff');
  assert.equal(ignored.length, 1);
  assert.equal(ignored[0].key, freshaKey('loc-1', 'staff', 'f-other'));
  assert.equal(ignored[0].needsDecision, false);
});

test('isolation: a snapshot from another business or site refuses to plan', () => {
  assert.match(plan(fresha(), mai({ clientId: 'client-B' })).errors.join(' '), /client/);
  assert.match(plan(fresha(), mai({ siteId: 'site-B' })).errors.join(' '), /site/);
  const leaked = mai();
  leaked.appointments.push({ ...leaked.appointments[0], id: 'm-x', siteId: 'site-B' });
  const p = plan(fresha(), leaked);
  assert.match(p.errors.join(' '), /m-x belongs to another site/);
  assert.equal(p.actions.length, 0, 'no actions when isolation fails');
  assert.match(plan(fresha({ locationId: 'loc-2' })).errors.join(' '), /location/);
});

test('mapping must point at real, distinct professionals of this site', () => {
  assert.match(plan(fresha(), mai(), { ...mapping, staff: { 'f-barber-1': 'm-ghost', 'f-barber-2': 'm-barber-2' } }).errors.join(' '), /m-ghost/);
  assert.match(plan(fresha(), mai(), { ...mapping, staff: { 'f-barber-1': 'm-barber-1', 'f-barber-2': 'm-barber-1' } }).errors.join(' '), /same M_AI staff/);
});

test('a dated block becomes ONE dated exception, with an idempotency key; conflicts are listed, never cancelled', () => {
  const p = plan();
  const create = ofKind(p, 'create_exception').find((a) => a.key === freshaKey('loc-1', 'block', 'f-b1'))!;
  assert.ok(create);
  assert.deepEqual((create.evidence as any).write, {
    table: 'schedule_exceptions',
    staff_id: 'm-barber-1',
    starts_at: at('10:00'),
    ends_at: at('20:00'),
    idempotencyKey: 'fresha:loc-1:block:f-b1',
  });
  assert.equal(create.needsDecision, true, 'barber 1 has bookings inside the block');
  const conflicts = ofKind(p, 'block_conflicts_with_appointments').find((a) => a.key.startsWith('fresha:loc-1:block:f-b1'))!;
  const listed = (conflicts.evidence as any).appointments.map((x: any) => x.id).sort();
  assert.deepEqual(listed, ['m-a1', 'm-a2', 'm-a3']);
  assert.deepEqual((conflicts.evidence as any).appointments.filter((x: any) => x.markedTest).map((x: any) => x.id).sort(), ['m-a2', 'm-a3'], 'test bookings are flagged, not removed');
  // The evening block for barber 2 has no conflicts: a clean, high-confidence create.
  const evening = ofKind(p, 'create_exception').find((a) => a.key === freshaKey('loc-1', 'block', 'f-b3'))!;
  assert.equal(evening.confidence, 'high');
  assert.equal(evening.needsDecision, false);
});

test('an unverified pause is held back; a recurring rule is only proposed as weekly hours', () => {
  const held = ofKind(plan(), 'hold_unverified');
  assert.equal(held.length, 1);
  assert.equal(held[0].key, freshaKey('loc-1', 'block', 'f-b2'));
  const f = fresha();
  f.blocks.push({ id: 'f-b4', staffId: 'f-barber-2', kind: 'pause', start: at('13:00'), end: at('14:00'), recurrence: 'weekly:mon', allowsOnlineBooking: false, verified: true });
  const p = plan(f);
  const weekly = ofKind(p, 'propose_weekly_rule');
  assert.equal(weekly.length, 1);
  assert.equal(weekly[0].needsDecision, true);
  assert.equal(ofKind(p, 'create_exception').some((a) => a.key.endsWith(':f-b4')), false, 'a recurring pause never becomes a dated exception');
});

test('re-running after the exception exists is a no-op for it (idempotent apply)', () => {
  const m = mai({ exceptions: [{ id: 'm-e1', siteId: 'site-A', staffId: 'm-barber-2', start: at('17:00'), end: at('20:00'), reason: 'fresha:loc-1:block:f-b3' }] });
  const p = plan(fresha(), m);
  assert.equal(ofKind(p, 'create_exception').some((a) => a.key.endsWith(':f-b3')), false);
  assert.equal(ofKind(p, 'exception_already_present').length, 1);
  // A partial overlap is a decision, not a second insert.
  const m2 = mai({ exceptions: [{ id: 'm-e2', siteId: 'site-A', staffId: 'm-barber-2', start: at('18:00'), end: at('19:00'), reason: null }] });
  assert.equal(ofKind(plan(fresha(), m2), 'exception_partial_overlap').length, 1);
});

test('appointments: overlap on the same professional is a MISMATCH with the diff, not a silent match', () => {
  const p = plan();
  const mm = ofKind(p, 'appointment_mismatch');
  assert.equal(mm.length, 1);
  const ev = mm[0].evidence as any;
  assert.deepEqual(ev.diffs, ['time']);
  assert.equal(ev.fresha.at, '2026-10-12 11:45–12:30');
  assert.equal(ev.mai.at, '2026-10-12 12:00–12:50');
  assert.equal(ev.mai.durationMinSnapshot, 50, 'the booking snapshot is shown, never rewritten');
  // The two M_AI bookings with no Fresha counterpart are reported, not cancelled.
  const extra = ofKind(p, 'appointment_missing_in_fresha');
  assert.deepEqual(extra.map((a) => (a.evidence as any).mai.id).sort(), ['m-a2', 'm-a3']);
  assert.ok(extra.every((a) => (a.evidence as any).markedTest === true));
});

test('an idempotency-key match wins over a time guess, and a Fresha cancellation is only proposed', () => {
  const m = mai();
  m.appointments[0].idempotencyKey = 'fresha:loc-1:appointment:f-a1';
  const matched = ofKind(plan(fresha(), m), 'appointment_mismatch')[0];
  assert.equal((matched.evidence as any).matchedBy, 'idempotency_key');
  assert.equal(matched.confidence, 'high');
  const f = fresha();
  f.appointments[0].status = 'cancelled';
  const cancel = ofKind(plan(f, m), 'appointment_cancelled_in_fresha');
  assert.equal(cancel.length, 1);
  assert.equal(cancel[0].needsDecision, true);
});

test('services: duration/price/description/promotion diffs, candidate confidence, bookings untouched', () => {
  const p = plan();
  const cut = ofKind(p, 'service_diff').find((a) => a.key.endsWith(':f-svc-cut'))!;
  assert.deepEqual((cut.evidence as any).diffs.durationMin, { fresha: 55, mai: 50 });
  assert.ok((cut.evidence as any).diffs.description);
  assert.equal((cut.evidence as any).diffs.price, undefined, 'same price is not a diff');
  assert.equal(cut.confidence, 'low', 'an unconfirmed pairing is a candidate only');
  assert.equal((cut.evidence as any).existingBookingsUnaffected, 3);
  const sig = ofKind(p, 'service_diff').find((a) => a.key.endsWith(':f-svc-sig'))!;
  assert.deepEqual((sig.evidence as any).diffs.durationMin, { fresha: 60, mai: 70 });
  assert.match(String((sig.evidence as any).diffs.promotion.mai), /no promotion field/);
  assert.equal(ofKind(p, 'service_unmapped').length, 1);
});

test('days are local to the site: 21:30 Bogotá on the 12th is still the 12th (02:30Z on the 13th)', () => {
  assert.equal(localDay('2026-10-13T02:30:00Z', TZ), '2026-10-12');
  const f = fresha({ blocks: [{ id: 'f-late', staffId: 'f-barber-2', kind: 'block', start: '2026-10-13T02:00:00Z', end: '2026-10-13T03:00:00Z', recurrence: null, allowsOnlineBooking: false, verified: true }] });
  assert.equal(ofKind(plan(f), 'create_exception').length, 1);
  const g = fresha({ blocks: [{ id: 'f-next', staffId: 'f-barber-2', kind: 'block', start: at('10:00', '2026-10-13'), end: at('11:00', '2026-10-13'), recurrence: null, allowsOnlineBooking: false, verified: true }] });
  assert.equal(ofKind(plan(g), 'create_exception').length, 0, 'outside the compared day');
});

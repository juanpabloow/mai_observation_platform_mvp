import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { computeAvailability } from '../../src/scheduling/availability.js';
import { explainAvailability, explainStaffStatus, type ExplainException, type PublicAbsenceReason } from '../../src/scheduling/availabilityExplain.js';
import { zonedPartsToUtc } from '../../src/scheduling/timezone.js';
import type { AvailabilityRequest, StaffAvailabilityInput, WeeklyHours } from '../../src/scheduling/types.js';
import { dayCustomerMessage, projectDay, rangeSummary } from '../../web/lib/availabilityExplanation.js';
import { parsePublicReason, publicReasonPreview, publicReasonsFor } from '../../web/lib/publicAbsenceReason.js';

/**
 * The availability EXPLAINER on synthetic fixtures (a Gallery-93-like site; names are
 * fixtures, not data). Site Mon–Sat 09:00–19:00, closed Sunday. "Federico" inherits the
 * site hours; "Falla" works 10:00–14:00 and 15:00–19:00 (lunch break). 60-min service,
 * 30-min grid, 120-min notice, 30-day horizon. "Now" = Mon 2026-11-02 08:00 Bogotá.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');
const TZ = 'America/Bogota';
const at = (day: number, h: number, m = 0) => zonedPartsToUtc(2026, 11, day, h, m, TZ);
const SITE_HOURS: WeeklyHours = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((d) => [d, [{ start: '09:00', end: '19:00' }]]));
const FALLA_HOURS: WeeklyHours = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((d) => [d, [{ start: '10:00', end: '14:00' }, { start: '15:00', end: '19:00' }]]));
const T60 = { duration_min: 60, buffer_before_min: 0, buffer_after_min: 0 };
const NOW = at(2, 8);

function staff(id: string, over: Partial<StaffAvailabilityInput> = {}): StaffAvailabilityInput {
  return { id, working_hours: {}, timing: T60, busy: [], exceptions: [], ...over };
}

interface Fixture {
  from: Date;
  to: Date;
  staff?: StaffAvailabilityInput[];
  siteExc?: ExplainException[];
  staffExc?: Record<string, ExplainException[]>;
  now?: Date;
  cfg?: Partial<AvailabilityRequest['site']['scheduling_config']>;
}

function run(f: Fixture, explainIds = ['falla']) {
  const staffExc = new Map(Object.entries(f.staffExc ?? {}));
  const list = (f.staff ?? [staff('falla', { working_hours: FALLA_HOURS }), staff('federico')]).map((s) => ({
    ...s,
    exceptions: (staffExc.get(s.id) ?? []).map((e) => ({ from: e.from, until: e.until })),
  }));
  const request: AvailabilityRequest = {
    site: {
      id: 'gallery-93',
      timezone: TZ,
      opening_hours: SITE_HOURS,
      scheduling_config: { slot_interval_min: 30, min_notice_min: 120, booking_horizon_days: 30, default_buffer_before_min: 0, default_buffer_after_min: 0, ...f.cfg },
    },
    staff: list,
    siteExceptions: (f.siteExc ?? []).map((e) => ({ from: e.from, until: e.until })),
    from: f.from,
    to: f.to,
    now: f.now ?? NOW,
  };
  const slots = computeAvailability(request);
  const days = explainAvailability({ request, slots, staffIds: explainIds, siteExceptions: f.siteExc ?? [], staffExceptions: staffExc });
  return { slots, days };
}
const exc = (from: Date, until: Date, public_reason: PublicAbsenceReason | null = null): ExplainException => ({ from, until, public_reason });
const wholeDay = (day: number) => ({ from: at(day, 0), to: at(day + 1, 0) });

// ── Absences ────────────────────────────────────────────────────────────────────

test('full-day vacation with a confirmed public reason → "está de vacaciones en esa fecha"', () => {
  const { days } = run({ ...wholeDay(4), staffExc: { falla: [exc(at(4, 0), at(5, 0), 'vacation')] } });
  assert.equal(days.length, 1);
  const d = days[0];
  assert.equal(d.status, 'unavailable');
  assert.equal(d.summary, 'absence');
  assert.equal(d.public_reason, 'vacation');
  assert.equal(dayCustomerMessage(d, 'Falla'), 'Falla está de vacaciones en esa fecha.');
});

test('multi-day vacation → one summary for the range, per-day entries kept', () => {
  const { days } = run({ from: at(4, 0), to: at(7, 0), staffExc: { falla: [exc(at(4, 0), at(7, 0), 'vacation')] } });
  assert.deepEqual(days.map((d) => [d.date, d.summary, d.public_reason]), [
    ['2026-11-04', 'absence', 'vacation'],
    ['2026-11-05', 'absence', 'vacation'],
    ['2026-11-06', 'absence', 'vacation'],
  ]);
  const r = rangeSummary(days, 'Falla');
  assert.equal(r.status, 'unavailable');
  assert.equal(r.customer_message, 'Falla está de vacaciones en esas fechas.');
});

test('a block WITHOUT public reason never becomes "vacaciones": neutral message', () => {
  const { days } = run({ ...wholeDay(4), staffExc: { falla: [exc(at(4, 0), at(5, 0), null)] } });
  assert.equal(days[0].summary, 'absence');
  assert.equal(days[0].public_reason, null);
  assert.equal(dayCustomerMessage(days[0], 'Falla'), 'Falla no tiene disponibilidad para ese horario.');
});

test('mixed public reasons behind one absence → not confirmed (null)', () => {
  const { days } = run({ ...wholeDay(4), staffExc: { falla: [exc(at(4, 0), at(4, 14), 'vacation'), exc(at(4, 14), at(5, 0), 'unavailable')] } });
  assert.equal(days[0].summary, 'absence');
  assert.equal(days[0].public_reason, null);
});

test('a one-hour block does NOT make the day an absence: the day stays available', () => {
  const { days } = run({ ...wholeDay(4), staffExc: { falla: [exc(at(4, 11), at(4, 12), 'vacation')] } });
  const d = days[0];
  assert.equal(d.status, 'available');
  assert.equal(d.summary, 'available');
  assert.equal(d.public_reason, null);
  const absence = d.causes.find((c) => c.code === 'absence');
  assert.deepEqual([absence?.coverage, absence?.minutes, absence?.covers_whole_working_day], ['part', 60, false]);
});

test('asking exactly inside a partial block → absence for THAT interval, "en ese horario"', () => {
  const { days } = run({ from: at(4, 11), to: at(4, 12), staffExc: { falla: [exc(at(4, 11), at(4, 12), 'vacation')] } });
  const d = days[0];
  assert.equal(d.summary, 'absence');
  assert.equal(d.public_reason, 'vacation');
  assert.equal(dayCustomerMessage(d, 'Falla'), 'Falla está de vacaciones en ese horario.');
});

// ── Shift, site, bookings ────────────────────────────────────────────────────────

test('outside the shift and during the break → off_shift (not an absence)', () => {
  const lunch = run({ from: at(4, 14), to: at(4, 15) });
  assert.equal(lunch.days[0].summary, 'off_shift');
  assert.equal(dayCustomerMessage(lunch.days[0], 'Falla'), 'Falla no trabaja en ese horario.');
  const early = run({ from: at(4, 9), to: at(4, 10) });
  assert.equal(early.days[0].summary, 'off_shift');
});

test('a professional with no shift that weekday → "no trabaja ese día"', () => {
  const hours: WeeklyHours = { ...FALLA_HOURS };
  delete hours.wed;
  const { days } = run({ ...wholeDay(4), staff: [staff('falla', { working_hours: hours })] });
  assert.equal(days[0].summary, 'off_shift');
  assert.equal(dayCustomerMessage(days[0], 'Falla'), 'Falla no trabaja ese día.');
});

test('site closed: regular closed weekday vs. a site closure block with its public reason', () => {
  const sunday = run(wholeDay(8));
  assert.equal(sunday.days[0].summary, 'site_closed_day');
  assert.equal(dayCustomerMessage(sunday.days[0], 'Falla'), 'La sede no abre ese día.');
  const closure = run({ ...wholeDay(4), siteExc: [exc(at(4, 0), at(5, 0), 'site_closed')] });
  assert.equal(closure.days[0].summary, 'site_closure');
  assert.equal(closure.days[0].public_reason, 'site_closed');
  assert.equal(dayCustomerMessage(closure.days[0], 'Falla'), 'La sede está cerrada en esa fecha.');
  const outside = run({ from: at(4, 20), to: at(4, 22) });
  assert.equal(outside.days[0].summary, 'outside_site_hours');
});

test('fully booked shift → booked, no appointment detail carried', () => {
  const busy = [{ from: at(4, 10), until: at(4, 14) }, { from: at(4, 15), until: at(4, 19) }];
  const { days } = run({ ...wholeDay(4), staff: [staff('falla', { working_hours: FALLA_HOURS, busy })] });
  assert.equal(days[0].summary, 'booked');
  assert.equal(dayCustomerMessage(days[0], 'Falla'), 'Falla ya tiene ocupado ese horario.');
  const booked = days[0].causes.find((c) => c.code === 'booked');
  assert.deepEqual(Object.keys(booked ?? {}).sort(), ['code', 'coverage', 'minutes', 'public_reason'], 'only code/share — no appointment field');
});

test('free gaps shorter than the service → service_does_not_fit', () => {
  // 10:00–14:00 booked except 11:00–11:30; afternoon booked fully.
  const busy = [{ from: at(4, 10), until: at(4, 11) }, { from: at(4, 11, 30), until: at(4, 14) }, { from: at(4, 15), until: at(4, 19) }];
  const { days } = run({ ...wholeDay(4), staff: [staff('falla', { working_hours: FALLA_HOURS, busy })] });
  assert.equal(days[0].summary, 'multiple', 'booked AND does-not-fit — not collapsed into one');
  assert.ok(days[0].causes.some((c) => c.code === 'service_does_not_fit'));
  assert.ok(days[0].causes.some((c) => c.code === 'booked'));
  // Asking only for the 30-minute gap: the service does not fit THERE.
  const gap = run({ from: at(4, 11), to: at(4, 11, 30), staff: [staff('falla', { working_hours: FALLA_HOURS, busy })] });
  assert.equal(gap.days[0].summary, 'service_does_not_fit');
});

test('a service that would run past the requested interval → no_valid_start_in_window', () => {
  const { days } = run({ from: at(4, 10), to: at(4, 10, 30) });
  assert.equal(days[0].summary, 'no_valid_start_in_window');
});

test('booking rules: minimum notice, horizon, past', () => {
  // Falla starts at 10:00; a 10:00 start is inside the window but within the 120-min notice.
  const soon = run({ from: at(2, 9), to: at(2, 11), now: at(2, 9) });
  assert.equal(soon.days[0].summary, 'min_notice', 'the off-shift hour before 10:00 is context, not the cause');
  assert.ok(soon.days[0].causes.some((c) => c.code === 'off_shift' && c.coverage === 'part'));
  // A 60-min service cannot end inside 10:00–10:30.
  const short = run({ from: at(2, 9), to: at(2, 10, 30), now: at(2, 9) });
  assert.equal(short.days[0].summary, 'no_valid_start_in_window');
  const soonFed = run({ from: at(2, 9), to: at(2, 11), now: at(2, 9) }, ['federico']);
  assert.equal(soonFed.days[0].summary, 'min_notice');
  assert.equal(dayCustomerMessage(soonFed.days[0], 'Federico'), 'Ese horario ya no se puede reservar con tan poca anticipación.');
  const far = run({ from: zonedPartsToUtc(2026, 12, 15, 0, 0, TZ), to: zonedPartsToUtc(2026, 12, 16, 0, 0, TZ) }, ['federico']);
  assert.equal(far.days[0].summary, 'beyond_booking_horizon');
  const past = run({ from: at(2, 9), to: at(2, 11), now: at(2, 18) }, ['federico']);
  assert.equal(past.days[0].summary, 'in_the_past');
});

test('several causes at once → multiple, each listed with its share', () => {
  const busy = [{ from: at(4, 15), until: at(4, 19) }];
  const { days } = run({
    ...wholeDay(4),
    staff: [staff('falla', { working_hours: FALLA_HOURS, busy }), staff('federico')],
    staffExc: { falla: [exc(at(4, 10), at(4, 14), 'vacation')] },
  });
  const d = days[0];
  assert.equal(d.summary, 'multiple');
  assert.equal(d.public_reason, null, 'no reason claimed for the whole day');
  assert.deepEqual(d.causes.map((c) => [c.code, c.coverage, c.minutes]), [
    ['off_shift', 'part', 120],
    ['absence', 'part', 240],
    ['booked', 'part', 240],
  ]);
  assert.equal(dayCustomerMessage(d, 'Falla'), 'Falla no tiene disponibilidad para ese horario.');
});

test('the explanation never changes the slots and only explains the requested professional', () => {
  const f: Fixture = { ...wholeDay(4), staffExc: { falla: [exc(at(4, 0), at(5, 0), 'vacation')] } };
  const a = run(f);
  const b = run(f, ['falla', 'federico']);
  assert.deepEqual(a.slots, b.slots);
  assert.ok(a.slots.length > 0 && a.slots.every((s) => s.available_staff_ids.join() === 'federico'), 'Federico still has slots');
  assert.deepEqual(a.days.map((d) => d.staff_id), ['falla']);
  assert.equal(b.days.find((d) => d.staff_id === 'federico')?.status, 'available', "Falla's block does not leak onto Federico");
});

test('projection: codes and labels only — no internal text field exists', () => {
  const { days } = run({ ...wholeDay(4), staffExc: { falla: [exc(at(4, 0), at(5, 0), 'vacation')] } });
  const j = projectDay(days[0], 'Falla');
  assert.deepEqual(Object.keys(j).sort(), ['causes', 'customer_message', 'date', 'public_reason', 'public_reason_label', 'slot_count', 'status', 'summary']);
  assert.equal(j.public_reason_label, 'Vacaciones');
});

// ── Status without a service ───────────────────────────────────────────────────────

test('status without a service: working, partly, absent with reason, day off, closed', () => {
  const dates = [2, 3, 4, 5, 8].map((day) => ({ year: 2026, month: 11, day }));
  const st = explainStaffStatus({
    site: { timezone: TZ, opening_hours: SITE_HOURS },
    staff: { id: 'falla', working_hours: { ...FALLA_HOURS, thu: [] } },
    dates,
    siteExceptions: [],
    staffExceptions: [exc(at(3, 10), at(3, 12), null), exc(at(4, 0), at(5, 0), 'vacation')],
  });
  assert.deepEqual(st.map((d) => [d.date, d.status, d.summary, d.public_reason]), [
    ['2026-11-02', 'working', 'working', null],
    ['2026-11-03', 'partly_working', 'absence', null],
    ['2026-11-04', 'not_working', 'absence', 'vacation'],
    ['2026-11-05', 'not_working', 'off_shift', null],
    ['2026-11-08', 'not_working', 'site_closed_day', null],
  ]);
  assert.equal(st[1].shift.length, 2, 'what is left of the shift on the partial day');
});

// ── Public reason input rules ────────────────────────────────────────────────────

test('public reason: controlled list per scope, default none, nothing else accepted', () => {
  assert.deepEqual(publicReasonsFor('staff'), ['vacation', 'unavailable']);
  assert.deepEqual(publicReasonsFor('site'), ['site_closed', 'unavailable']);
  assert.deepEqual(parsePublicReason(undefined, 'staff'), { ok: true, value: null });
  assert.deepEqual(parsePublicReason('', 'staff'), { ok: true, value: null });
  assert.deepEqual(parsePublicReason('vacation', 'staff'), { ok: true, value: 'vacation' });
  for (const bad of ['medical', 'Vacaciones', 'incapacidad', 42]) assert.equal(parsePublicReason(bad, 'staff').ok, false, String(bad));
  assert.equal(parsePublicReason('site_closed', 'staff').ok, false);
  assert.equal(parsePublicReason('vacation', 'site').ok, false);
  assert.equal(publicReasonPreview(null, 'Falla'), '«Falla no tiene disponibilidad para ese horario.»');
});

test('wiring: forms never prefill the public reason from the internal one; the API never reads `reason`', () => {
  const logic = read('web/components/scheduling/mobile/config/logic.ts');
  assert.ok(logic.includes('reason: "", publicReason: null, tpl: null'), 'mobile default is none');
  assert.ok(!/case "Vacaciones":[^\n]*publicReason/.test(logic), 'the Vacaciones template does not set it');
  const form = read('web/components/scheduling/timeoff/TimeOffForm.tsx');
  assert.ok(form.includes('publicReason: null as PublicAbsenceReason | null'), 'new block → none');
  assert.ok(!/setPublicReason\([^)]*reason\b/.test(form));
  const build = read('web/lib/availabilityExplainBuild.ts');
  const status = read('web/app/api/scheduling/v1/staff/status/route.ts');
  for (const src of [build, status, read('web/lib/availabilityExplanation.ts')]) {
    assert.ok(!/\.reason\b/.test(src), 'no internal reason property is touched');
  }
});

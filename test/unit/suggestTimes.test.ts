import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spreadNearest, MAX_SUGGESTIONS, SUGGESTION_SPREAD_MS } from '../../web/lib/suggestTimes.ts';

/**
 * The 409 "that time isn't available" suggestions must be REAL alternatives, not the first
 * six consecutive 15-minute steps of the day. spreadNearest picks a small set NEAREST to the
 * requested time, spread ≥30 min apart, on both sides.
 */
const BASE = new Date('2026-08-26T09:00:00-05:00').getTime(); // 09:00 America/Bogota
const at = (mins: number): Date => new Date(BASE + mins * 60_000);
const mins = (d: Date): number => Math.round((d.getTime() - BASE) / 60_000);
// A full working day of 15-minute starts: 09:00 (0) … 17:30 (510) → 35 slots.
const fullDay: Date[] = [];
for (let m = 0; m <= 510; m += 15) fullDay.push(at(m));

test('a requested time AFTER the last slot → the LATEST times (near the request), not the day start', () => {
  const picks = spreadNearest(fullDay, at(555)); // 18:15 — after the last slot (17:30)
  const got = picks.map(mins);
  assert.deepEqual(got, [390, 420, 450, 480, 510], '15:30, 16:00, 16:30, 17:00, 17:30 — nearest to 18:15');
  assert.ok(!got.some((m) => m <= 60), 'the misleading early-morning steps (09:00–10:15) are gone');
});

test('a MID-DAY request straddles the time on BOTH sides, spread apart', () => {
  const picks = spreadNearest(fullDay, at(240)).map(mins); // 13:00
  assert.equal(picks.length, MAX_SUGGESTIONS);
  assert.ok(picks.some((m) => m < 240) && picks.some((m) => m > 240), 'options before AND after the requested time');
  assert.ok(picks.includes(240), 'the requested time itself is offered when free');
});

test('never two CONSECUTIVE 15-minute steps — every pick is ≥ the spread apart', () => {
  for (const around of [at(0), at(240), at(555)]) {
    const picks = spreadNearest(fullDay, around).map((d) => d.getTime());
    for (let i = 1; i < picks.length; i++) {
      assert.ok(picks[i] - picks[i - 1] >= SUGGESTION_SPREAD_MS, 'consecutive-step truncation is gone');
    }
  }
});

test('at most MAX_SUGGESTIONS are returned, in chronological order', () => {
  const picks = spreadNearest(fullDay, at(300));
  assert.ok(picks.length <= MAX_SUGGESTIONS);
  const times = picks.map((d) => d.getTime());
  assert.deepEqual(times, [...times].sort((a, b) => a - b), 'chronological for display');
});

test('every pick is a member of the input (a strict subset of availability)', () => {
  const set = new Set(fullDay.map((d) => d.getTime()));
  for (const d of spreadNearest(fullDay, at(555))) assert.ok(set.has(d.getTime()));
});

test('fewer slots than the cap → all, still spread (near-duplicates dropped)', () => {
  const picks = spreadNearest([at(0), at(15), at(120)], at(60)).map(mins);
  assert.deepEqual(picks, [15, 120], '09:15 (nearest) kept; 09:00 dropped as within 30 min; 11:00 kept');
});

// ── SOURCE CONTRACT: nearestTimesHint is server-only (can't import here), so guard its wiring ──
const web = (rel: string): string => readFileSync(fileURLToPath(new URL(`../../web/${rel}`, import.meta.url)), 'utf8');

test('nearestTimesHint builds from the CANONICAL availability path, spread + labelled + staff-named', () => {
  const src = web('lib/semanticParams.ts');
  const fn = src.slice(src.indexOf('export async function nearestTimesHint'));
  assert.ok(fn.includes('loadAvailability('), 'uses the same loadAvailability as GET /availability');
  assert.ok(fn.includes('staffId,'), 'passes the SAME staff filter into availability');
  assert.ok(fn.includes('now: new Date()'), 'excludes past / min-notice times, like availability');
  assert.ok(fn.includes('spreadNearest('), 'spreads instead of truncating');
  assert.equal(/\.slice\(0,\s*\d/.test(fn), false, 'no first-N truncation');
  assert.ok(fn.includes('localStartFields(') && fn.includes('.start_label'), 'renders spoken labels, not raw HH:MM');
  assert.ok(fn.includes('getStaffById(') && fn.includes('with ${st.name}'), 'names the requested staff member');
  assert.ok(fn.includes('any staff'), 'and says "any staff" when no staff filter was in play');
});

test('both callers pass the resolved staff AND the locale to nearestTimesHint', () => {
  const book = web('app/api/scheduling/v1/appointments/route.ts');
  assert.ok(/nearestTimesHint\(auth\.auth, site\.site\.id, svc\.value, stf\.value, startAt, site\.site\.timezone, labels\.locale\)/.test(book), 'booking passes stf.value + labels.locale');
  const resched = web('app/api/scheduling/v1/appointments/[id]/reschedule/route.ts');
  assert.ok(/nearestTimesHint\(auth\.auth, appt\.site_id, appt\.service_id, stf\.value, start\.value, siteTz, labels\.locale\)/.test(resched), 'reschedule passes stf.value + labels.locale');
});

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * HANDLER-ORDER CONTRACT TEST (source-level, no DB).
 *
 * WHY this shape: the public booking route handlers import server-only modules
 * and use the web app's `@/` and `@worker/` path aliases, so they can't be
 * imported and invoked from the root test runner. The REAL resolver semantics
 * (what the gate returns for disabled/default/inactive/foreign) are proven by the
 * PostgreSQL integration test (publicBookingGate.test.ts). THIS test guards the
 * one thing that integration test can't reach: that each handler GATES on
 * getPublicBookingSiteBySlug BEFORE it reads/parses/validates any body or query
 * input — so a disabled site returns the generic 404 even for invalid input,
 * never a 400/422 that would leak that the slug exists.
 *
 * It is a regression guard on source order, explicitly NOT a claim that it
 * executes the endpoints.
 */

const bookingApiDir = fileURLToPath(new URL('../../web/app/api/booking/[slug]/', import.meta.url));

function read(rel: string): string {
  return readFileSync(`${bookingApiDir}${rel}`, 'utf8');
}

/** Assert `before` (the gate) appears earlier in the source than `after` (the
 * first input read) — both must be present, or the test fails. */
function assertGateBefore(src: string, after: string, label: string): void {
  const gate = src.indexOf('getPublicBookingSiteBySlug(');
  const input = src.indexOf(after);
  assert.ok(gate >= 0, `${label}: getPublicBookingSiteBySlug( not found`);
  assert.ok(input >= 0, `${label}: input token ${JSON.stringify(after)} not found`);
  assert.ok(gate < input, `${label}: the site gate must run BEFORE ${JSON.stringify(after)}`);
}

test('POST gates on the resolver before parsing the request body', () => {
  const src = read('route.ts');
  assertGateBefore(src, 'req.json()', 'POST /api/booking/[slug]');
});

test('staff GET gates on the resolver before reading service_id', () => {
  const src = read('staff/route.ts');
  assertGateBefore(src, '.get("service_id")', 'GET /api/booking/[slug]/staff');
});

test('availability GET gates on the resolver before reading params / parsing dates', () => {
  const src = read('availability/route.ts');
  assertGateBefore(src, '.get("service_id")', 'GET /api/booking/[slug]/availability (params)');
  assertGateBefore(src, 'parseIsoDate(', 'GET /api/booking/[slug]/availability (dates)');
});

test('services GET already gates on the resolver before any service-scoped read', () => {
  // Services has no query/body input to leak through, but keep the invariant
  // uniform so a future edit can't regress it.
  const src = read('services/route.ts');
  const gate = src.indexOf('getPublicBookingSiteBySlug(');
  const use = src.indexOf('listServicesForSite(');
  assert.ok(gate >= 0 && use >= 0);
  assert.ok(gate < use, 'the site gate must run before listServicesForSite');
});

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * SOURCE-LEVEL CONTRACT TEST (no HTTP, no DB). The v1 route handlers use
 * server-only + `@/`/`@worker/` aliases and can't be invoked from the root
 * runner, so the REAL security semantics are proven by the PostgreSQL
 * machineScope + domain gate tests. THIS guards the wiring those can't reach:
 *  - every handler calls authenticateScheduling BEFORE it reads body/query, so a
 *    request without valid credentials never gets body/query validation errors;
 *  - every data route propagates the RESOLVED scope (auth.auth.clientId /
 *    auth.auth.workflowRef) instead of trusting the request.
 * It is a wiring/order regression guard — NOT a claim that it executes the routes.
 */

const v1 = fileURLToPath(new URL('../../web/app/api/scheduling/v1/', import.meta.url));
const read = (rel: string): string => readFileSync(`${v1}${rel}`, 'utf8');

/** Per-handler segments (one per `export async function GET/POST`). */
function handlerSegments(src: string): string[] {
  return src.split(/export async function /).slice(1);
}

const INPUT_TOKENS = ['req.json(', 'req.url', '.searchParams'];

/** In every handler that reads body/query, authenticateScheduling must come first. */
function assertAuthBeforeInput(rel: string): void {
  for (const seg of handlerSegments(read(rel))) {
    const auth = seg.indexOf('authenticateScheduling(');
    assert.ok(auth >= 0, `${rel}: a handler is missing authenticateScheduling`);
    for (const tok of INPUT_TOKENS) {
      const i = seg.indexOf(tok);
      if (i >= 0) assert.ok(auth < i, `${rel}: authenticateScheduling must precede ${JSON.stringify(tok)}`);
    }
  }
}

function assertContains(rel: string, needle: string): void {
  assert.ok(read(rel).includes(needle), `${rel}: expected to contain ${JSON.stringify(needle)}`);
}
function assertAbsent(rel: string, needle: string): void {
  assert.ok(!read(rel).includes(needle), `${rel}: must NOT contain ${JSON.stringify(needle)}`);
}

const ALL = [
  'sites/route.ts',
  'services/route.ts',
  'staff/route.ts',
  'availability/route.ts',
  'appointments/route.ts',
  'appointments/[id]/cancel/route.ts',
  'appointments/[id]/confirm/route.ts',
  'appointments/[id]/complete/route.ts',
  'appointments/[id]/no-show/route.ts',
  'appointments/[id]/reschedule/route.ts',
];

test('every v1 handler authenticates before reading body/query', () => {
  for (const rel of ALL) assertAuthBeforeInput(rel);
});

test('sites lists ONLY the resolved client', () => {
  assertContains('sites/route.ts', 'clientId: auth.auth.clientId');
});

test('services/staff/availability resolve the site as OWNED by the client', () => {
  for (const rel of ['services/route.ts', 'staff/route.ts', 'availability/route.ts']) {
    assertContains(rel, 'resolveOwnedSite(auth.auth');
  }
});

test('appointments GET forces the client filter; POST pins scope + uses header workflowRef, never a body field', () => {
  const rel = 'appointments/route.ts';
  assertContains(rel, 'clientId: auth.auth.clientId'); // GET mandatory filter
  assertContains(rel, 'scopeClientId: auth.auth.clientId'); // POST scope
  assertContains(rel, 'workflowRef: auth.auth.workflowRef'); // POST provenance = header
  // No BODY provenance: neither a schema field nor a read of it (a prose comment
  // mentioning the removed field is fine — we check the code shapes precisely).
  assertAbsent(rel, 'workflow_ref:'); // not a zod schema field
  assertAbsent(rel, '.workflow_ref'); // not read off the parsed body
});

test('every transition/reschedule route pins scopeClientId to the resolved client', () => {
  for (const rel of [
    'appointments/[id]/cancel/route.ts',
    'appointments/[id]/confirm/route.ts',
    'appointments/[id]/complete/route.ts',
    'appointments/[id]/no-show/route.ts',
    'appointments/[id]/reschedule/route.ts',
  ]) {
    assertContains(rel, 'scopeClientId: auth.auth.clientId');
  }
});

/** Assert `a` precedes `b` in the source (both must be present). */
function assertBefore(rel: string, a: string, b: string): void {
  const src = read(rel);
  const ia = src.indexOf(a);
  const ib = src.indexOf(b);
  assert.ok(ia >= 0, `${rel}: expected ${JSON.stringify(a)}`);
  assert.ok(ib >= 0, `${rel}: expected ${JSON.stringify(b)}`);
  assert.ok(ia < ib, `${rel}: ${JSON.stringify(a)} must precede ${JSON.stringify(b)}`);
}

test('confirm/complete/no-show validate the id (isUuid) BEFORE calling the domain', () => {
  // These have no semantic alternative, so the id must still be a UUID validated up front.
  assertBefore('appointments/[id]/confirm/route.ts', 'isUuid(id)', 'transitionStatus(');
  assertBefore('appointments/[id]/complete/route.ts', 'isUuid(id)', 'transitionStatus(');
  assertBefore('appointments/[id]/no-show/route.ts', 'isUuid(id)', 'transitionStatus(');
});

test('cancel and reschedule resolve the appointment target (UUID or by-time) BEFORE the domain', () => {
  // E-1 §3: the id may be a UUID OR `by-time` (identity+day+time in the body), so the
  // target is resolved (and its failure returned) before any mutation.
  for (const [rel, domain] of [
    ['appointments/[id]/cancel/route.ts', 'transitionStatus('],
    ['appointments/[id]/reschedule/route.ts', 'rescheduleAppointment('],
  ] as const) {
    assertBefore(rel, 'resolveAppointmentTarget(', domain);
    assertBefore(rel, 'if (!target.ok) return target.response', domain);
  }
});

test('staff/availability resolve service/staff (id OR name) before the engine', () => {
  // E-1: shape + membership + name resolution now live in the shared resolveServiceParam/
  // resolveStaffParam (which enforce the enabled-at-site / active-staff checks), and run
  // before the engine call.
  assertContains('availability/route.ts', 'resolveServiceParam(');
  assertContains('availability/route.ts', 'resolveStaffParam(');
  assertBefore('availability/route.ts', 'resolveServiceParam(', 'loadAvailability(');
  assertContains('staff/route.ts', 'resolveServiceParam(');
  assertBefore('staff/route.ts', 'resolveServiceParam(', 'listStaffForService(');
});

// ── C-7 wiring guards (the handler can't run here; guard the source shapes) ──────

test('appointments GET rejects unknown + empty params instead of silently dropping a filter', () => {
  const rel = 'appointments/route.ts';
  // The over-return bug: an unrecognized or empty-valued param used to widen the
  // query to the whole client. Both must now be LOUD 400s.
  assertContains(rel, 'unknown_parameter');
  assertContains(rel, 'empty_parameter');
  // The allowlist gate + the empty-value gate both run BEFORE listAppointments.
  assertBefore(rel, 'unknown_parameter', 'listAppointments(');
  assertBefore(rel, 'empty_parameter', 'listAppointments(');
});

test('appointments GET resolves identity filters through the C-2 spine (never trusts a raw filter)', () => {
  const rel = 'appointments/route.ts';
  // phone/email/external_id resolve to a contact-id SET; an empty set → 0 rows.
  assertContains(rel, 'findContactIdsByIdentity(');
  assertContains(rel, 'contactIds');
  // resolution feeds the mandatory-client list (clientId is still forced).
  assertBefore(rel, 'findContactIdsByIdentity(', 'listAppointments(');
  assertContains(rel, 'clientId: auth.auth.clientId');
});

test('every appointment-returning route projects the contact identity + staff_name (Task 2 / E-4)', () => {
  // The list builds the contact inline from its join (and passes r.staff_name); the
  // single-appointment routes go through projectSingleAppointment, which resolves the
  // contact card AND the staff name in one lookup each. Either way the caller gets both.
  assertContains('appointments/route.ts', 'primary_identity');
  for (const rel of [
    'appointments/[id]/cancel/route.ts',
    'appointments/[id]/confirm/route.ts',
    'appointments/[id]/complete/route.ts',
    'appointments/[id]/no-show/route.ts',
    'appointments/[id]/reschedule/route.ts',
  ]) {
    assertContains(rel, 'projectSingleAppointment(');
  }
  // Create also uses it; the list passes the row's staff_name (no per-row lookup).
  assertContains('appointments/route.ts', 'projectSingleAppointment(auth.auth, result.value');
  assertContains('appointments/route.ts', 'r.staff_name');
});

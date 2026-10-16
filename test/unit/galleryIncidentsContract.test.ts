import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Source-level guarantees for the Gallery incident fixes (behaviour is covered by
 *  test/integration/galleryIncidents.test.ts against an isolated database). */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

test('the bot lists only bookable services; the agenda/settings list is unchanged', () => {
  const route = read('web/app/api/scheduling/v1/services/route.ts');
  assert.match(route, /listBookableServicesForSite\(auth\.auth\.tenantId, owned\.site\.id\)/);
  assert.doesNotMatch(route, /listServicesForSite\(/);
  for (const rel of ['web/app/clients/[clientId]/scheduling/agenda/page.tsx', 'web/app/clients/[clientId]/scheduling/admin/page.tsx']) {
    assert.match(read(rel), /listServicesForSite\(/, `${rel} keeps the full list`);
  }
});

test('takes_bookings is enforced where every surface books: the engine and the bot staff list', () => {
  assert.match(read('src/db/repositories/scheduling/availabilityData.ts'), /s\.active = true AND s\.takes_bookings = true/);
  assert.match(read('src/db/repositories/scheduling/staff.ts'), /AND s\.takes_bookings = true/);
  assert.match(read('src/db/repositories/scheduling/publicCatalog.ts'), /AND st\.takes_bookings = true/);
});

test('reschedule passes the snapshot timing to the availability check', () => {
  assert.match(read('src/scheduling/booking.ts'), /timingOverride: \{\s*durationMin: current\.duration_min_snapshot,/);
});

test('admin actions stay inside the URL client', () => {
  const actions = read('web/lib/schedulingAdminActions.ts');
  assert.match(actions, /deleteStaffCertification\(auth\.tenantId, staffId, id\)/);
  // MF-1 item 7: the staff-belongs-to-site guard for time-off blocks moved to the single
  // writer (writeTimeOff); schedulingAdminActions.createException now delegates to it.
  assert.match(read('web/lib/timeOffActions.ts'), /if \(!st \|\| st\.site_id !== input\.siteId\) return \{ ok: false, error: FOREIGN \};/);
  assert.match(read('src/db/repositories/scheduling/staffCertifications.ts'), /WHERE id = \$1 AND tenant_id = \$2 AND staff_id = \$3/);
});

test('retry goes through the atomic claim, after the webhook guard', () => {
  const s = read('web/lib/sendActions.ts');
  const body = s.slice(s.indexOf('export async function retrySendAction'));
  assert.ok(body.indexOf('resolveEnabledWebhook(') < body.indexOf('claimFailedMessageForRetry('), 'guard first, then claim');
  assert.doesNotMatch(body.slice(0, body.indexOf('// ── private helpers')), /getHandoffMessage\(/);
  assert.match(read('src/db/repositories/handoff.ts'), /AND sender = 'human_agent' AND status = 'failed'/);
});

test('the persisted Inbox workflow filter is visible in the list and clears like the header switcher', () => {
  const w = read('web/components/ClientInboxWorkspace.tsx');
  assert.match(w, /\{scope !== "all" \? <ActiveWorkflowFilter /);
  assert.match(w, /Mostrando solo el flujo/);
  assert.match(w, /setScope\(clientId, "all"\);\s*const p = new URLSearchParams\(searchParams\.toString\(\)\);\s*p\.delete\("workflow"\);/);
});

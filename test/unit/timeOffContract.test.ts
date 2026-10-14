import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * SOURCE CONTRACT for Time Off + staff editing. The web guards import next/* and can't be
 * driven headless, so the permission matrix + wiring is pinned at the source (the runtime
 * behaviour that CAN run lives in test/integration/timeOff.test.ts + staffEdit.test.ts).
 *
 * Matrix pinned:
 *   STAFF time off  (create/edit/delete) → canAccessClient (owner + setter + agency; NOT staff)
 *   SITE closures   (create/edit/delete) → canManageClient (owner + agency only)
 *   See blocks / reason in the agenda     → all operators; a STAFF login only its own + site
 */

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (p: string) => readFileSync(`${root}${p}`, 'utf8');

test('timeOffActions: site closures gate on canManageClient, staff blocks on canAccessClient', () => {
  const a = read('web/lib/timeOffActions.ts');
  assert.match(a, /const allowed = siteWide \? canManageClient\(scope, clientId\) : canAccessClient\(scope, clientId\)/);
  // create/update/delete all funnel through the gate.
  assert.match(a, /createTimeOffAction[\s\S]{0,1400}requireTimeOff\(input\.clientId, siteWide\)/);
  assert.match(a, /updateTimeOffAction[\s\S]{0,1600}requireTimeOff\(clientId, siteWide\)/);
  assert.match(a, /deleteTimeOffAction[\s\S]{0,1200}requireTimeOff\(clientId, block\.staff_id === null\)/);
  // Local wall-clock anchored to the SITE tz via the one tz system; reason normalized.
  assert.match(a, /localWallClockToUtc\(shape\.startLocal, site\.timezone\)/);
  assert.match(a, /reason: normalizeReason\(/);
});

test('timeOffActions: the conflict flow surfaces overlapping appointments and never auto-cancels', () => {
  const a = read('web/lib/timeOffActions.ts');
  // Unless confirmed, overlapping appointments are RETURNED (not created, not cancelled).
  assert.match(a, /if \(!input\.confirm\) \{[\s\S]{0,260}listActiveAppointmentsOverlapping[\s\S]{0,200}return \{ ok: false, conflicts:/);
  // No cancel/transition call anywhere in the time-off writer.
  assert.doesNotMatch(a, /cancelAppointment|transitionAppointment|setStatus/);
});

test('timeOffActions: past blocks are read-only history', () => {
  const a = read('web/lib/timeOffActions.ts');
  assert.match(a, /updateTimeOffAction[\s\S]{0,2500}block\.ends_at\.getTime\(\) <= Date\.now\(\)/);
  assert.match(a, /deleteTimeOffAction[\s\S]{0,1600}block\.ends_at\.getTime\(\) <= Date\.now\(\)/);
});

test('agenda page: block perms + a staff login sees only its own blocks (+ site closures)', () => {
  const p = read('web/app/clients/[clientId]/scheduling/agenda/page.tsx');
  assert.match(p, /const canBlockStaff = canAccessClient\(scope, client\.id\)/);
  assert.match(p, /const canBlockSite = hasFullAccess\(scope\) \|\| isClientOwner\(scope, client\.id\)/);
  assert.match(p, /\.filter\(\(b\) => !isStaff \|\| b\.staff_id === null \|\| b\.staff_id === myStaffId\)/);
});

test('the machine API can never expose the reason (availability only reads the time bounds)', () => {
  const av = read('src/db/repositories/scheduling/availabilityData.ts');
  // The engine's exceptions read selects ONLY staff_id + the time window — not `reason`.
  assert.match(av, /SELECT staff_id, starts_at, ends_at\s*\n\s*FROM schedule_exceptions/);
  // No read of schedule_exceptions selects the INTERNAL `reason` column. (The explainer's
  // read selects `public_reason` — the separate, explicitly chosen customer-facing code.)
  assert.doesNotMatch(av, /SELECT[^;]*(?<!public_)\breason\b[^;]*FROM schedule_exceptions/);
  assert.match(av, /SELECT staff_id, starts_at, ends_at, public_reason\s*\n\s*FROM schedule_exceptions/);
});

test('staff name uniqueness is enforced server-side (active, per site, case-insensitive)', () => {
  const a = read('web/lib/schedulingAdminActions.ts');
  assert.match(a, /createStaffAction[\s\S]{0,1000}activeStaffNameTaken\(auth\.tenantId, input\.siteId, name\)/);
  assert.match(a, /resultingActive && \(await activeStaffNameTaken\(auth\.tenantId, current\.site_id, resultingName, id\)\)/);
  // The repo check binds ACTIVE staff only, case-folded.
  const repo = read('src/db/repositories/scheduling/staff.ts');
  assert.match(repo, /active = true\s*\n\s*AND lower\(btrim\(name\)\) = lower\(btrim\(\$3\)\)/);
});

test('agenda tokens: a distinct time-off hatch exists in both themes', () => {
  const css = read('web/app/globals.css');
  assert.match(css, /--timeoff-bg:/);
  assert.match(css, /--timeoff-stripe:/);
  assert.match(css, /\.u-timeoff-hatch \{/);
  assert.match(css, /\.u-timeoff-hatch-site \{/);
  // Defined for the dark theme too.
  assert.match(css, /\.dark \{[\s\S]{0,2000}--timeoff-bg:/);
});

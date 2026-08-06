import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * SOURCE-LEVEL CONTRACT (no HTTP/DB) for the deactivation fix. The disappearing-appointments
 * bug and the one-way-door bug both live in server-only pages / client components that this
 * runner can't execute; the data-layer guarantees are proven in
 * test/integration/deactivationLifecycle.test.ts. THIS guards the wiring those can't reach:
 *   - the agenda gives an inactive staff member a lane WHEN they have appointments (so history
 *     never vanishes) but never offers them for NEW bookings;
 *   - the admin panel has an ACTIVATE inverse for every deactivate (no one-way door) and a
 *     guarded deactivate.
 */

const web = (rel: string): string => readFileSync(fileURLToPath(new URL(`../../web/${rel}`, import.meta.url)), 'utf8');

test('agenda page loads inactive staff and builds lanes as active ∪ has-appointment', () => {
  const src = web('app/clients/[clientId]/scheduling/agenda/page.tsx');
  assert.ok(src.includes('includeInactive: true'), 'staff loaded with includeInactive');
  // Lanes = active OR appearing in the day\'s appointments.
  assert.ok(/apptStaffIds\s*=\s*new Set\(appts\.map/.test(src), 'derives the set of staff ids that have appointments');
  assert.ok(/allStaff\.filter\(\(s\)\s*=>\s*s\.active\s*\|\|\s*apptStaffIds\.has\(s\.id\)\)/.test(src), 'lane union: active OR has-appointment');
  assert.ok(/active:\s*s\.active/.test(src), 'passes the active flag to AgendaView');
});

test('AgendaView shows an inactive lane chip but offers only active staff for new bookings', () => {
  const src = web('components/scheduling/AgendaView.tsx');
  assert.ok(/active:\s*boolean/.test(src), 'StaffOpt carries active');
  assert.ok(src.includes('inactive'), 'renders an inactive marker');
  assert.ok(/props\.staff\.filter\(\(s\)\s*=>\s*s\.active\)/.test(src), 'the booking dropdown filters to active staff');
});

test('AdminPanel has an Activate inverse + guarded deactivate for site/service/staff (no one-way door)', () => {
  const src = web('components/scheduling/AdminPanel.tsx');
  // The state-reflecting toggle replaces the old `active ? <Deactivate/> : null` one-way door.
  for (const kind of ['site', 'service', 'staff']) {
    assert.ok(src.includes(`kind="${kind}"`), `ActiveToggle rendered for ${kind}`);
  }
  assert.ok(!/deactivate\w+Action\(clientId,[^)]*\)\)}>Deactivate<\/button>\s*:\s*null/.test(src), 'the old one-way `? Deactivate : null` is gone');
  assert.ok(src.includes('Activate'), 'an Activate affordance exists');
  assert.ok(src.includes('countUpcomingAppointmentsAction'), 'deactivate is guarded by the upcoming-count');
});

test('schedulingAdminActions exports an activate inverse for every scheduling deactivate + the guard', () => {
  const src = web('lib/schedulingAdminActions.ts');
  for (const fn of ['activateSiteAction', 'activateServiceAction', 'activateStaffAction', 'countUpcomingAppointmentsAction']) {
    assert.ok(src.includes(`export async function ${fn}`), `exports ${fn}`);
  }
  // The guard never blocks/cancels — it only counts (read path). Sanity: it calls the repo count.
  assert.ok(src.includes('countUpcomingAppointmentsForResource'), 'guard uses the read-only count');
});

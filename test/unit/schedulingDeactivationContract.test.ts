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

test('every deactivate has an inverse: site/service in AdminPanel, staff on the Staff roster', () => {
  const src = web('components/scheduling/AdminPanel.tsx');
  // The state-reflecting toggle replaces the old `active ? <Deactivate/> : null` one-way door.
  // STAFF moved to SCHEDULING → Staff; its inverse is asserted below.
  for (const kind of ['site', 'service']) {
    assert.ok(src.includes(`kind="${kind}"`), `ActiveToggle rendered for ${kind}`);
  }
  assert.ok(!/deactivate\w+Action\(clientId,[^)]*\)\)}>Deactivate<\/button>\s*:\s*null/.test(src), 'the old one-way `? Deactivate : null` is gone');
  assert.ok(src.includes('Activate'), 'an Activate affordance exists');
  // Deactivating a barber must stay reversible wherever the control lives. On the
  // Staff roster it is a CHECKBOX bound to the same `active` flag, so the same patch
  // turns it off and on — there is no separate, irreversible "deactivate" path.
  // The flag lives in the barber's OWN PANEL now — the Status section of the Details
  // tab — not in a separate editor. That move is what makes it a single write path, and
  // reversibility has to hold at the new home.
  const panel = web('components/scheduling/staff/StaffTab.tsx');
  assert.ok(panel.includes('checked={profile.active}'), 'the control reflects the stored state');
  assert.ok(
    panel.includes('onChange={(v) => setProfile((d) => ({ ...d, active: v }))}'),
    'and can set it either way — the same field turns it off and back on',
  );
  assert.ok(
    /onChange=\{\(e\) => onChange\(e\.target\.checked\)\}/.test(panel),
    'the CheckRow it routes through reads the checkbox, not a toggle guess',
  );
  // It rides the panel's ONE unsaved bar, through the same patch as every other field.
  assert.ok(/'takesBookings' \|\| k === 'active'|"takesBookings" \|\| k === "active"/.test(panel), 'carried by profilePatch');
  assert.ok(panel.includes('Object.assign(patch, profilePatch(profile, dirtyFields))'), 'saved through updateStaffAction');
  // Deactivation is forward-looking: the barber keeps their history and their lane.
  assert.ok(panel.includes('keeps their history and lane'), 'the consequence is spelled out');
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

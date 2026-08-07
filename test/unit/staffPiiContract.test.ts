import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * SOURCE CONTRACT for employee PII on `staff`.
 *
 * The 1783200000000 migration put phone, email and the emergency contact on a table
 * that the PUBLIC booking API and machine-API tokens read. There is no per-column
 * grant in Postgres here and no field-level ACL in the app, so the restriction is
 * structural: the default projection cannot name those columns, and only the two
 * `...Admin` reads can. That is easy to undo by accident with one `SELECT *`, so it
 * is asserted here rather than left to review.
 */
const root = (rel: string): string => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

const PII = ['phone', 'email', 'emergency_contact_name', 'emergency_contact_phone'];
const STAFF_REPO = 'src/db/repositories/scheduling/staff.ts';

test('the staff repository never selects or returns *', () => {
  const src = root(STAFF_REPO);
  // Strip comments — the header explains the rule and would match its own regex.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/SELECT\s+s?\.?\*/i.test(code), 'no SELECT * / SELECT s.* — the projection is the permission');
  assert.ok(!/RETURNING\s+\*/i.test(code), 'no RETURNING * — an INSERT/UPDATE must not hand PII back either');
});

test('the default projection omits every PII column; only the admin reads add them', () => {
  const src = root(STAFF_REPO);
  const cols = /const STAFF_COLS = `([\s\S]*?)`;/.exec(src);
  assert.ok(cols, 'STAFF_COLS exists');
  for (const c of PII) {
    assert.ok(!cols![1].includes(c), `STAFF_COLS must not select ${c}`);
  }
  const pii = /const STAFF_PII_COLS = `([\s\S]*?)`;/.exec(src);
  assert.ok(pii, 'STAFF_PII_COLS exists');
  for (const c of PII) {
    assert.ok(pii![1].includes(c), `STAFF_PII_COLS selects ${c}`);
  }
  // STAFF_PII_COLS may appear ONLY inside the two admin reads.
  const uses = src.split('STAFF_PII_COLS').length - 1;
  assert.equal(uses, 3, 'STAFF_PII_COLS is declared once and used by exactly the two ...Admin queries');
  assert.ok(src.includes('export async function listStaffAdmin'), 'listStaffAdmin exists');
  assert.ok(src.includes('export async function getStaffByIdAdmin'), 'getStaffByIdAdmin exists');
});

test('StaffRow (the type every route holds) has no PII fields', () => {
  const src = root(STAFF_REPO);
  const body = /export interface StaffRow \{([\s\S]*?)\n\}/.exec(src);
  assert.ok(body, 'StaffRow exists');
  for (const c of PII) {
    assert.ok(!new RegExp(`^\\s*${c}\\??:`, 'm').test(body![1]), `StaffRow must not declare ${c}`);
  }
  assert.ok(/export interface StaffAdminRow extends StaffRow/.test(src), 'the PII shape is a separate type');
});

/** Walk the API surface and prove nothing there imports a PII read. */
function filesUnder(dir: string): string[] {
  const abs = fileURLToPath(new URL(`../../${dir}`, import.meta.url));
  const out: string[] = [];
  const walk = (p: string): void => {
    for (const entry of readdirSync(p)) {
      const full = `${p}/${entry}`;
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith('.ts') || full.endsWith('.tsx')) out.push(full);
    }
  };
  walk(abs);
  return out;
}

test('no API route reads staff PII (public booking, machine API)', () => {
  for (const dir of ['web/app/api/booking', 'web/app/api/scheduling']) {
    for (const file of filesUnder(dir)) {
      const src = readFileSync(file, 'utf8');
      assert.ok(
        !/listStaffAdmin|getStaffByIdAdmin|StaffAdminRow/.test(src),
        `${file} must not reach for a staff PII read — those are owner/admin surfaces only`,
      );
    }
  }
});

test('the Team page is the ONLY page that reads staff PII, and it is owner/admin gated', () => {
  const readers = filesUnder('web/app')
    .filter((f) => /listStaffAdmin|getStaffByIdAdmin/.test(readFileSync(f, 'utf8')))
    .map((f) => f.replace(/.*\/web\/app\//, ''));
  assert.deepEqual(readers, ['clients/[clientId]/team/page.tsx'], 'exactly one page reads the PII');

  const page = root('web/app/clients/[clientId]/team/page.tsx');
  assert.ok(page.includes('requireFullAccessOrLand()'), 'behind the owner/admin gate');
  // The other loaders on the same page must NOT have been switched over with it.
  assert.ok(!/\blistStaff\(/.test(page), 'the admin read replaced listStaff here rather than sitting beside it');

  // Agenda and availability keep the PII-free read.
  assert.ok(
    root('web/app/clients/[clientId]/scheduling/agenda/page.tsx').includes('listStaff('),
    'the agenda still uses the operational read',
  );
});

test('NO CHAIR is derived from takes_bookings, not from active', () => {
  const src = root('web/components/team/StaffTab.tsx');
  assert.ok(/if \(!s\.takesBookings\) key = "no_chair";/.test(src), 'no_chair comes from takes_bookings');
  assert.ok(
    !/if \(!s\.active\) key = "no_chair";/.test(src),
    'active must not stand in for it — "no longer works here" and "holds no chair" are different facts',
  );
});

test('the service form can set a category (so a bad classification is correctable)', () => {
  const src = root('web/components/scheduling/AdminPanel.tsx');
  assert.ok(src.includes('const CATEGORY_OPTIONS'), 'the closed set is declared once');
  for (const v of ['color', 'grooming', 'cut', 'feature']) {
    assert.ok(new RegExp(`value: "${v}"`).test(src), `the form offers ${v}`);
  }
  assert.ok(/value: "",\s*label: "Unclassified"/.test(src), 'clearing back to unclassified is offered');
  // Both the create and the edit path must send it.
  assert.equal(src.split('category: category === "" ? null : category').length - 1, 2, 'create AND edit send it');
});

test('services.category is the primary source of the colour family; keywords are the fallback', () => {
  const src = root('web/lib/agendaCategory.ts');
  assert.ok(
    /export function serviceCategory\(serviceName: string, category\?: string \| null\)/.test(src),
    'serviceCategory takes the stored category',
  );
  assert.ok(/const stored = fromColumn\(category\);\n\s*if \(stored\) return stored;/.test(src), 'the stored value wins');
  assert.ok(src.includes('serviceCategory(appt.service_name, appt.service_category)'), 'apptCategory passes it through');
  // The TODO this column was added to remove must be gone.
  assert.ok(!/TODO\(agenda\):\s*services have no `category` column/.test(src), 'the "no category column" TODO is removed');
});

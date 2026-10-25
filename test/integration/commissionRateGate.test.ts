import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, mock, test } from 'node:test';
import { query } from '../../src/db/client.js';
import { cleanupTenant, closeDb, seedMember, seedScenario } from './fixtures.js';

/**
 * FIX-1 §3 — the commission-rate gate.
 *  READ  (commissions.view): the staff page serializes a professional's commission rates ONLY to a
 *        viewer who holds commissions.view. A custom role with team.manage (it manages the roster)
 *        but without commissions.view reaches the page yet never RECEIVES the numbers.
 *  EDIT  (payments.settings): updateStaffCommissionAction refuses a viewer without payments.settings,
 *        even one who can read the rates.
 * Both are hit directly — the page's server component for the read, the server action for the edit.
 */
let CURRENT: { id: string; email: string } | null = null;
mock.module('../../web/lib/session.ts', {
  namedExports: { getServerSession: async () => (CURRENT ? { user: { id: CURRENT.id, email: CURRENT.email }, session: {} } : null) },
});
const reqFromWeb = createRequire(pathToFileURL(resolvePath(process.cwd(), 'web/lib/access.ts')));
const urlOf = (spec: string) => pathToFileURL(reqFromWeb.resolve(spec)).href;

// The page's JSX compiles to the classic React.createElement runtime under the root tsx config, but the
// page (a server component) never imports React, and react lives in web/node_modules. Resolve it through
// the web context and put it on the global so the element is constructed and we can read el.props.staff.
// createElement exists in server React; only createContext (the client path) does not.
const ReactMod = await import(urlOf('react'));
(globalThis as Record<string, unknown>).React = (ReactMod as { default?: unknown }).default ?? ReactMod;
mock.module(urlOf('next/navigation'), { namedExports: { redirect: () => { throw new Error('redirect'); }, notFound: () => { throw new Error('notFound'); } } });
mock.module(urlOf('next/headers'), { namedExports: { headers: async () => new Headers(), cookies: async () => ({ get: () => undefined, getAll: () => [] }) } });
mock.module(urlOf('next/cache'), { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } });
mock.module(urlOf('next/server'), { namedExports: { connection: async () => {} } });
// The page renders a 'use client' component; importing it under --conditions=react-server pulls in
// next's router context (React.createContext), which server React does not expose. Stub it — the page
// only uses it as a JSX element TYPE, so the real `staff` data still rides through on el.props.staff.
mock.module(pathToFileURL(resolvePath(process.cwd(), 'web/components/scheduling/staff/StaffWorkspace.tsx')).href, {
  namedExports: { StaffWorkspace: () => null },
});
const asUser = (id: string) => { CURRENT = { id, email: `${id.slice(0, 8)}@test.local` }; };

const { updateStaffCommissionAction } = await import('../../web/lib/paymentActions.js');
const StaffPageMod = await import('../../web/app/clients/[clientId]/scheduling/staff/page.js');
const StaffPage = StaffPageMod.default as (p: {
  params: Promise<{ clientId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) => Promise<{ props: { staff: { members: Array<{ id: string; commissionPctServices: string; commissionPctProducts: string }>; canViewCommissions?: boolean; canManagePayments?: boolean } | null } }>;

const tenants: string[] = [];
after(async () => { CURRENT = null; for (const t of tenants) await cleanupTenant(t); await closeDb(); });
const one = async <T>(sql: string, p: unknown[]): Promise<T> => (await query<T>(sql, p)).rows[0];
type S = Awaited<ReturnType<typeof seedScenario>>;

/** A CUSTOM role (its PERMISSIONS decide, never its name) on a fresh login of this client. */
async function customLogin(s: S, permissions: string[]): Promise<string> {
  const userId = await seedMember(s.tenantId, { role: 'member', clientId: s.clientId, clientRole: 'setter' });
  const role = await one<{ id: string }>(`INSERT INTO access_roles (tenant_id, client_id, name, description) VALUES ($1,$2,$3,'test') RETURNING id`, [s.tenantId, s.clientId, `Rol ${randomUUID().slice(0, 6)}`]);
  for (const k of permissions) await query(`INSERT INTO access_role_permissions (role_id, permission_key) VALUES ($1,$2)`, [role.id, k]);
  await query(`UPDATE tenant_members SET client_role = 'custom', access_role_id = $3 WHERE tenant_id = $1 AND user_id = $2`, [s.tenantId, userId, role.id]);
  return userId;
}

const rateOf = (s: S) => one<{ c: string }>(`SELECT commission_pct_services AS c FROM staff WHERE id = $1`, [s.staffA]).then((r) => r.c);
async function serializedRate(s: S, userId: string): Promise<string | undefined> {
  asUser(userId);
  const el = await StaffPage({ params: Promise.resolve({ clientId: s.clientId }), searchParams: Promise.resolve({}) });
  const staff = el.props.staff;
  assert.ok(staff, 'the page returned a roster');
  return staff.members.find((m) => m.id === s.staffA)?.commissionPctServices;
}

test('READ gate: only a viewer with commissions.view receives the rates in the page data', async () => {
  const s = await seedScenario({ enableScheduling: true }); tenants.push(s.tenantId);
  await query(`UPDATE staff SET commission_pct_services = '15.00', commission_pct_products = '8.00' WHERE id = $1`, [s.staffA]);

  // commissions.view requires payments.view requires agenda.view (the requirement chain is enforced
  // fail-closed: a key whose requirements are absent is dropped), so a reader carries the whole chain.
  const READ = ['team.manage', 'agenda.view', 'payments.view', 'commissions.view'];

  // team.manage ONLY — manages the roster, cannot see money. Must NOT receive the rate.
  const blind = await customLogin(s, ['team.manage']);
  assert.equal(await serializedRate(s, blind), '', 'team.manage alone gets no rate');

  // team.manage + commissions.view (read) — receives the rate, cannot edit.
  const reader = await customLogin(s, READ);
  assert.equal(await serializedRate(s, reader), '15.00', 'commissions.view receives the rate');

  // team.manage + read + payments.settings (edit) — receives the rate too.
  const manager = await customLogin(s, [...READ, 'payments.settings']);
  assert.equal(await serializedRate(s, manager), '15.00', 'a manager receives the rate');
});

test('EDIT gate: updateStaffCommissionAction needs payments.settings, not merely commissions.view', async () => {
  const s = await seedScenario({ enableScheduling: true }); tenants.push(s.tenantId);
  await query(`UPDATE staff SET commission_pct_services = '10.00', commission_pct_products = '5.00' WHERE id = $1`, [s.staffA]);

  const READ = ['team.manage', 'agenda.view', 'payments.view', 'commissions.view'];
  const reader = await customLogin(s, READ); // read, no edit
  asUser(reader);
  assert.equal((await updateStaffCommissionAction(s.clientId, s.staffA, 30, 20)).ok, false, 'a reader cannot edit');
  assert.equal(await rateOf(s), '10.00', 'rate unchanged');

  const blind = await customLogin(s, ['team.manage']); // neither read nor edit
  asUser(blind);
  assert.equal((await updateStaffCommissionAction(s.clientId, s.staffA, 30, 20)).ok, false, 'team.manage alone cannot edit');
  assert.equal(await rateOf(s), '10.00', 'rate still unchanged');

  const manager = await customLogin(s, [...READ, 'payments.settings']);
  asUser(manager);
  assert.equal((await updateStaffCommissionAction(s.clientId, s.staffA, 30, 20)).ok, true, 'payments.settings edits');
  assert.equal(await rateOf(s), '30.00', 'rate updated');
});

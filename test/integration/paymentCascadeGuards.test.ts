import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, mock, test } from 'node:test';
import { query } from '../../src/db/client.js';
import { cleanupTenant, closeDb, seedContact, seedMember, seedScenario } from './fixtures.js';

/**
 * FIX-1 §2 — money history is never deleted by a cascade.
 *  (A) A recorded payment blocks deleting its appointment (payments.appointment_id = NO ACTION).
 *  (B) Tenant teardown still removes a tenant that has payments (NO ACTION, not RESTRICT).
 *  (C) The contact hard-delete is refused when the contact has payments or opportunities.
 */
let CURRENT: { id: string; email: string } | null = null;
mock.module('../../web/lib/session.ts', {
  namedExports: { getServerSession: async () => (CURRENT ? { user: { id: CURRENT.id, email: CURRENT.email }, session: {} } : null) },
});
const reqFromWeb = createRequire(pathToFileURL(resolvePath(process.cwd(), 'web/lib/access.ts')));
const urlOf = (spec: string) => pathToFileURL(reqFromWeb.resolve(spec)).href;
mock.module(urlOf('next/navigation'), { namedExports: { redirect: () => { throw new Error('redirect'); }, notFound: () => { throw new Error('notFound'); } } });
mock.module(urlOf('next/headers'), { namedExports: { headers: async () => new Headers(), cookies: async () => ({ get: () => undefined, getAll: () => [] }) } });
mock.module(urlOf('next/cache'), { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } });
const asUser = (id: string) => { CURRENT = { id, email: `${id.slice(0, 8)}@test.local` }; };

const { deleteContactAction } = await import('../../web/lib/contactActions.js');
const tenants: string[] = [];
after(async () => { CURRENT = null; for (const t of tenants) await cleanupTenant(t); await closeDb(); });

const one = async <T>(sql: string, p: unknown[]): Promise<T> => (await query<T>(sql, p)).rows[0];
type S = Awaited<ReturnType<typeof seedScenario>>;
const count = (sql: string, p: unknown[]) => one<{ n: string }>(sql, p).then((r) => r.n);

let slot = 0;
async function seedAppt(s: S, contactId: string): Promise<string> {
  const h = 24 + slot++ * 2;
  const r = await one<{ id: string }>(
    `INSERT INTO appointments (tenant_id, client_id, site_id, staff_id, service_id, start_at, service_end_at, blocked_from, blocked_until,
        service_name_snapshot, duration_min_snapshot, price_snapshot, buffer_before_min_snapshot, buffer_after_min_snapshot, status, origin, created_by_type, contact_id)
     VALUES ($1,$2,$3,$4,$5, now()+make_interval(hours=>$6::int), now()+make_interval(hours=>$6::int)+interval '60 min',
        now()+make_interval(hours=>$6::int), now()+make_interval(hours=>$6::int)+interval '60 min','Haircut',60,'50000',0,0,'completed','n8n','n8n',$7) RETURNING id`,
    [s.tenantId, s.clientId, s.siteId, s.staffA, s.serviceHaircut, h, contactId],
  );
  return r.id;
}
const seedPayment = (s: S, apptId: string, contactId: string) =>
  one<{ id: string }>(`INSERT INTO payments (tenant_id, client_id, appointment_id, contact_id, status, method_key, total, recorded_by) VALUES ($1,$2,$3,$4,'recorded','efectivo','50000.00','u') RETURNING id`, [s.tenantId, s.clientId, apptId, contactId]).then((r) => r.id);
const seedOpp = (s: S, contactId: string) =>
  query(`INSERT INTO opportunities (tenant_id, client_id, contact_id, status, stage, lead_at) VALUES ($1,$2,$3,'open','lead',now())`, [s.tenantId, s.clientId, contactId]);

test('A: a recorded payment blocks deleting its appointment (NO ACTION — money never cascade-deleted)', async () => {
  const s = await seedScenario({ enableScheduling: true }); tenants.push(s.tenantId);
  const c = await seedContact(s.tenantId, s.clientId, { channelUserId: `wa:${randomUUID().slice(0, 8)}` });
  const appt = await seedAppt(s, c);
  const pay = await seedPayment(s, appt, c);
  await assert.rejects(
    query(`DELETE FROM appointments WHERE id = $1`, [appt]),
    (e: { code?: string }) => e.code === '23503',
    'deleting the appointment is refused by the FK',
  );
  assert.equal(await count(`SELECT count(*)::text n FROM payments WHERE id=$1`, [pay]), '1', 'payment survives');
});

test('B: tenant teardown removes a tenant that has payments (NO ACTION, not RESTRICT)', async () => {
  const s = await seedScenario({ enableScheduling: true }); // deleted in-test, not via after()
  const c = await seedContact(s.tenantId, s.clientId, { channelUserId: `wa:${randomUUID().slice(0, 8)}` });
  await seedPayment(s, await seedAppt(s, c), c);
  await query(`DELETE FROM tenants WHERE id = $1`, [s.tenantId]); // must NOT throw
  assert.equal(await count(`SELECT count(*)::text n FROM payments WHERE tenant_id=$1`, [s.tenantId]), '0', 'payments cascaded away with the tenant');
});

test('C: deleteContactAction refuses a contact with payments or opportunities, allows a clean one', async () => {
  const s = await seedScenario({ enableCrm: true, enableScheduling: true }); tenants.push(s.tenantId);
  asUser(await seedMember(s.tenantId, { role: 'owner' })); // agency holds contacts.delete

  const withPay = await seedContact(s.tenantId, s.clientId, { channelUserId: `wa:${randomUUID().slice(0, 8)}` });
  await seedPayment(s, await seedAppt(s, withPay), withPay);
  const r1 = await deleteContactAction(s.clientId, withPay);
  assert.equal(r1.ok, false, 'refused: has a payment');
  assert.match(r1.ok ? '' : r1.error, /historial|archív|fusión/i);
  assert.equal(await count(`SELECT count(*)::text n FROM contacts WHERE id=$1`, [withPay]), '1', 'contact + payment kept');

  const withOpp = await seedContact(s.tenantId, s.clientId, { channelUserId: `wa:${randomUUID().slice(0, 8)}` });
  await seedOpp(s, withOpp);
  assert.equal((await deleteContactAction(s.clientId, withOpp)).ok, false, 'refused: has an opportunity');
  assert.equal(await count(`SELECT count(*)::text n FROM contacts WHERE id=$1`, [withOpp]), '1');

  const clean = await seedContact(s.tenantId, s.clientId, { channelUserId: `wa:${randomUUID().slice(0, 8)}` });
  assert.equal((await deleteContactAction(s.clientId, clean)).ok, true, 'clean contact deletes');
  assert.equal(await count(`SELECT count(*)::text n FROM contacts WHERE id=$1`, [clean]), '0');
});

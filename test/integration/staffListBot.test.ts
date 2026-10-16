import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { query } from '../../src/db/client.js';
import { issueToken } from '../../src/db/repositories/handoffTokens.js';
import { cleanupTenant, closeDb, seedScenario, seedSiteForClient, seedWorkflow, type Scenario } from './fixtures.js';

/**
 * ST-1 — GET /api/scheduling/v1/staff for the bot: bookable filter, public fields, one order.
 * Token-authed machine route; scheduling.read + x-workflow-ref, same as the other v1 reads.
 */
after(closeDb);

const { GET } = await import('../../web/app/api/scheduling/v1/staff/route.js');

interface Ctx extends Scenario { wfRef: string; token: string; }
async function setup(): Promise<Ctx> {
  const s = await seedScenario({ enableScheduling: true });
  const wfRef = `wf-${s.tenantId.slice(0, 8)}`;
  const { connectionId } = await seedWorkflow(s.tenantId, s.clientId, wfRef);
  const { rawToken } = await issueToken(s.tenantId, connectionId, ['scheduling.read']);
  return { ...s, wfRef, token: rawToken };
}
async function addStaff(
  s: Ctx,
  opts: { name: string; takesBookings?: boolean; active?: boolean; publicTitle?: string | null; publicBio?: string | null },
): Promise<string> {
  const r = await query<{ id: string }>(
    `INSERT INTO staff (tenant_id, site_id, name, working_hours, active, takes_bookings, public_title, public_bio)
       VALUES ($1,$2,$3,'{}'::jsonb,$4,$5,$6,$7) RETURNING id`,
    [s.tenantId, s.siteId, opts.name, opts.active ?? true, opts.takesBookings ?? true, opts.publicTitle ?? null, opts.publicBio ?? null],
  );
  return r.rows[0].id;
}
const perform = (s: Ctx, staffId: string, serviceId: string) =>
  query(`INSERT INTO staff_services (tenant_id, staff_id, service_id) VALUES ($1,$2,$3)`, [s.tenantId, staffId, serviceId]);

async function listNames(s: Ctx, qs = ''): Promise<{ status: number; names: string[]; staff: Record<string, unknown>[] }> {
  const res = await GET(new Request(`http://t/api/scheduling/v1/staff?site_id=${s.siteId}${qs}`, {
    headers: { Authorization: `Bearer ${s.token}`, 'x-workflow-ref': s.wfRef },
  }));
  if (res.status !== 200) return { status: res.status, names: [], staff: [] };
  const body = (await res.json()) as { staff: Record<string, unknown>[] };
  return { status: 200, names: body.staff.map((x) => x.name as string), staff: body.staff };
}

test('ST-1: bookable=true excludes takes_bookings=false on the no-service path; default includes it', async () => {
  const s = await setup();
  try {
    await addStaff(s, { name: 'Álvaro' });
    await addStaff(s, { name: 'Mostrador', takesBookings: false }); // front desk — holds no chair
    const def = await listNames(s);
    assert.ok(def.names.includes('Mostrador'), 'default still returns the non-bookable member (unchanged)');
    const bookable = await listNames(s, '&bookable=true');
    assert.ok(!bookable.names.includes('Mostrador'), 'bookable=true drops the non-bookable member');
    assert.ok(['Álvaro', 'Ana', 'Beto'].every((n) => bookable.names.includes(n)), 'bookable staff remain');
  } finally {
    await cleanupTenant(s.tenantId);
  }
});

test('ST-1: the service path never returns non-bookable staff (with or without bookable)', async () => {
  const s = await setup();
  try {
    const alvaro = await addStaff(s, { name: 'Álvaro' });
    const mostrador = await addStaff(s, { name: 'Mostrador', takesBookings: false });
    await perform(s, alvaro, s.serviceHaircut);
    await perform(s, mostrador, s.serviceHaircut); // performs it, but holds no chair → must be excluded
    for (const qs of ['&service=Haircut', '&service=Haircut&bookable=true']) {
      const { names } = await listNames(s, qs);
      assert.ok(!names.includes('Mostrador'), `service path excludes non-bookable (${qs})`);
      assert.deepEqual(names, ['Álvaro', 'Ana', 'Beto'], `service-qualified, ordered (${qs})`);
    }
  } finally {
    await cleanupTenant(s.tenantId);
  }
});

test('ST-1: inactive staff are never returned (default or bookable)', async () => {
  const s = await setup();
  try {
    await addStaff(s, { name: 'Zzz Inactivo', active: false });
    assert.ok(!(await listNames(s)).names.includes('Zzz Inactivo'), 'default excludes inactive');
    assert.ok(!(await listNames(s, '&bookable=true')).names.includes('Zzz Inactivo'), 'bookable excludes inactive');
  } finally {
    await cleanupTenant(s.tenantId);
  }
});

test('ST-1: an invalid bookable value → 400 invalid_request', async () => {
  const s = await setup();
  try {
    for (const bad of ['false', '1', 'yes', '']) {
      const res = await GET(new Request(`http://t/api/scheduling/v1/staff?site_id=${s.siteId}&bookable=${bad}`, {
        headers: { Authorization: `Bearer ${s.token}`, 'x-workflow-ref': s.wfRef },
      }));
      assert.equal(res.status, 400, `bookable=${JSON.stringify(bad)} → 400`);
      assert.equal((await res.json()).error.code, 'invalid_request');
    }
  } finally {
    await cleanupTenant(s.tenantId);
  }
});

test('ST-1: each item has EXACTLY {id, name, site_id, public_title, public_bio}; public fields null when empty', async () => {
  const s = await setup();
  try {
    // Ana gets a published title; her bio stays unpublished (the DB CHECK already forbids an
    // empty string, so "" never reaches here — unpublished is null).
    await query(`UPDATE staff SET public_title='Barbero senior' WHERE tenant_id=$1 AND name='Ana'`, [s.tenantId]);
    const { staff } = await listNames(s);
    for (const item of staff) {
      assert.deepEqual(Object.keys(item).sort(), ['id', 'name', 'public_bio', 'public_title', 'site_id'], 'exact key set');
    }
    const ana = staff.find((x) => x.name === 'Ana')!;
    assert.equal(ana.public_title, 'Barbero senior');
    assert.equal(ana.public_bio, null, 'unpublished bio is null');
    const beto = staff.find((x) => x.name === 'Beto')!;
    assert.equal(beto.public_title, null, 'unpublished title is null');
  } finally {
    await cleanupTenant(s.tenantId);
  }
});

test('ST-1: one order — name, case- and accent-insensitive, identical on both paths', async () => {
  const s = await setup();
  try {
    const alvaro = await addStaff(s, { name: 'Álvaro' }); // accent → sorts as "alvaro"
    await addStaff(s, { name: 'bruno' }); // lowercase → sorts after "Beto"
    await perform(s, alvaro, s.serviceHaircut);
    // No-service (all bookable+active): alvaro < ana < beto < bruno.
    assert.deepEqual((await listNames(s, '&bookable=true')).names, ['Álvaro', 'Ana', 'Beto', 'bruno']);
    // Service path (the haircut subset) is ordered the SAME way.
    assert.deepEqual((await listNames(s, '&service=Haircut')).names, ['Álvaro', 'Ana', 'Beto']);
  } finally {
    await cleanupTenant(s.tenantId);
  }
});

test('ST-1: isolation unchanged — a foreign/unknown site_id → 404, and another client\'s site → 404', async () => {
  const s = await setup();
  try {
    // Unknown site id.
    const unknown = await GET(new Request(`http://t/api/scheduling/v1/staff?site_id=${randomUUID()}`, {
      headers: { Authorization: `Bearer ${s.token}`, 'x-workflow-ref': s.wfRef },
    }));
    assert.equal(unknown.status, 404);
    // A real site owned by ANOTHER client in the same tenant → still 404 for this token's client.
    const other = await seedSiteForClient(s.tenantId, s.otherClientId);
    const foreign = await GET(new Request(`http://t/api/scheduling/v1/staff?site_id=${other.siteId}`, {
      headers: { Authorization: `Bearer ${s.token}`, 'x-workflow-ref': s.wfRef },
    }));
    assert.equal(foreign.status, 404, 'cross-client site is not visible');
  } finally {
    await cleanupTenant(s.tenantId);
  }
});

import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, mock, test } from 'node:test';
import { query } from '../../src/db/client.js';
import { cleanupTenant, closeDb, seedMember, seedScenario } from './fixtures.js';

/**
 * PÁGINA DE RESERVAS — public contact, through the REAL updateSiteAction and PostgreSQL.
 * A value the server rejects names its field (so the form marks that input aria-invalid
 * and points it at the message); nothing is written; the corrected value then saves.
 * The business rules (E.164 WhatsApp, Google Maps https links) are unchanged.
 */

let CURRENT: string | null = null;
mock.module('../../web/lib/session.ts', {
  namedExports: { getServerSession: async () => (CURRENT ? { user: { id: CURRENT, email: `${CURRENT.slice(0, 8)}@test.local` }, session: {} } : null) },
});
const reqFromWeb = createRequire(pathToFileURL(resolvePath(process.cwd(), 'web/lib/access.ts')));
const urlOf = (spec: string) => pathToFileURL(reqFromWeb.resolve(spec)).href;
mock.module(urlOf('next/navigation'), {
  namedExports: {
    redirect: () => { throw new Error('refused: redirect()'); },
    notFound: () => { throw new Error('refused: notFound()'); },
  },
});
mock.module(urlOf('next/headers'), {
  namedExports: { headers: async () => new Headers(), cookies: async () => ({ get: () => undefined, getAll: () => [] }) },
});
mock.module(urlOf('next/cache'), { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } });

const { updateSiteAction } = await import('../../web/lib/schedulingAdminActions.js');

const tenants: string[] = [];
after(async () => {
  for (const t of tenants) await cleanupTenant(t);
  await closeDb();
});

const contactOf = async (siteId: string) =>
  (await query<{ public_whatsapp: string | null; public_maps_url: string | null }>(
    `SELECT public_whatsapp, public_maps_url FROM sites WHERE id = $1`,
    [siteId],
  )).rows[0];

test('a rejected WhatsApp names its field, writes nothing, and the corrected value saves', async () => {
  const s = await seedScenario({ enableScheduling: true });
  tenants.push(s.tenantId);
  CURRENT = await seedMember(s.tenantId, { role: 'member', clientId: s.clientId, clientRole: 'owner' });
  const before = await contactOf(s.siteId);

  const bad = await updateSiteAction(s.clientId, s.siteId, { publicWhatsapp: '12', publicMapsUrl: '' });
  assert.equal(bad.ok, false);
  assert.ok(!bad.ok && bad.field === 'publicWhatsapp', 'the WhatsApp input is the one to mark');
  assert.ok(!bad.ok && /Revisa el número de WhatsApp/.test(bad.error), 'the same business message as before');
  assert.deepEqual(await contactOf(s.siteId), before, 'nothing was written');

  const badMaps = await updateSiteAction(s.clientId, s.siteId, { publicWhatsapp: '', publicMapsUrl: 'https://example.com/mapa' });
  assert.ok(!badMaps.ok && badMaps.field === 'publicMapsUrl', 'a bad Maps link names its own field');
  assert.deepEqual(await contactOf(s.siteId), before);

  // Corrected and retried: saved, normalised to E.164 as always.
  const ok = await updateSiteAction(s.clientId, s.siteId, { publicWhatsapp: '+57 300 123 4567', publicMapsUrl: '' });
  assert.equal(ok.ok, true);
  assert.equal(ok.ok && ok.contact?.publicWhatsapp, '+573001234567', 'the action answers with the stored (normalised) value');
  assert.equal((await contactOf(s.siteId)).public_whatsapp, '+573001234567');
});

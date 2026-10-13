import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { runServiceSave, type ActionResult, type PersistedService, type ServiceSaveActions, type ServiceSaveInput } from '../../web/lib/serviceSave.js';

/**
 * BEHAVIOUR of the service editor's save sequence with fake server actions that fail
 * on demand. The point: a retry after ANY failure finishes the job without creating the
 * service twice and without repeating writes that already happened.
 */

function fakeServer(failOnce: Partial<Record<'create' | 'update' | 'setSite' | 'setStaff' | 'featured', string>> = {}) {
  const calls: string[] = [];
  const services = new Map<string, { sites: Set<string>; staff: Set<string>; featured: boolean }>();
  let n = 0;
  const failing = { ...failOnce };
  const maybeFail = (k: keyof typeof failing): ActionResult | null => {
    const msg = failing[k];
    if (!msg) return null;
    delete failing[k];
    return { ok: false, error: msg };
  };
  const actions: ServiceSaveActions = {
    async create(_fields, siteIds) {
      calls.push(`create(${siteIds.join(',')})`);
      const f = maybeFail('create');
      if (f) return f; // atomic: nothing persisted
      const id = `svc-${++n}`;
      services.set(id, { sites: new Set(siteIds), staff: new Set(), featured: false });
      return { ok: true, id };
    },
    async update(id, patch) {
      const isFeaturedOnly = Object.keys(patch).length === 1 && patch.featured !== undefined;
      calls.push(isFeaturedOnly ? `featured(${id})` : `update(${id})`);
      const f = maybeFail(isFeaturedOnly ? 'featured' : 'update');
      if (f) return f;
      if (patch.featured !== undefined) services.get(id)!.featured = patch.featured;
      return { ok: true, id };
    },
    async setSite(siteId, id, on) {
      calls.push(`site(${siteId},${on})`);
      const f = maybeFail('setSite');
      if (f) return f;
      services.get(id)!.sites[on ? 'add' : 'delete'](siteId);
      return { ok: true };
    },
    async setStaff(staffId, id, on) {
      calls.push(`staff(${staffId},${on})`);
      const f = maybeFail('setStaff');
      if (f) return f;
      services.get(id)!.staff[on ? 'add' : 'delete'](staffId);
      return { ok: true };
    },
  };
  return { actions, calls, services };
}

const input = (over: Partial<ServiceSaveInput> = {}): ServiceSaveInput => ({
  fields: { name: 'Corte', description: '', durationMin: 30, price: 40000, bufferBeforeMin: 0, bufferAfterMin: 0, category: 'cut' },
  featured: false,
  siteIds: ['norte'],
  staffIds: ['ana', 'beto'],
  allSiteIds: ['norte', 'sur'],
  allStaffIds: ['ana', 'beto', 'caro'],
  ...over,
});
const fresh = (): PersistedService => ({ id: null, siteIds: [], staffIds: [] });

test('a new service saves create(+sites) then its professionals', async () => {
  const srv = fakeServer();
  const out = await runServiceSave(fresh(), input(), srv.actions);
  assert.deepEqual(out, { ok: true, id: 'svc-1' });
  assert.deepEqual(srv.calls, ['create(norte)', 'staff(ana,true)', 'staff(beto,true)'], 'sites go WITH the create, not after');
});

test('a professional assignment fails after the create: the retry UPDATES, never creates again', async () => {
  const srv = fakeServer({ setStaff: 'Profesional no encontrado.' });
  const persisted = fresh();
  const first = await runServiceSave(persisted, input(), srv.actions);
  assert.deepEqual(first, { ok: false, error: 'Profesional no encontrado.', partial: true }, 'it says part was saved');
  assert.equal(persisted.id, 'svc-1', 'the created id is remembered');
  srv.calls.length = 0;
  const retry = await runServiceSave(persisted, input(), srv.actions);
  assert.deepEqual(retry, { ok: true, id: 'svc-1' });
  assert.deepEqual(srv.calls, ['update(svc-1)', 'staff(ana,true)', 'staff(beto,true)'], 'no second create; only the missing staff');
  assert.equal(srv.services.size, 1, 'exactly one service exists');
  assert.deepEqual([...srv.services.get('svc-1')!.staff], ['ana', 'beto']);
});

test('featured fails after the create: the retry sets it through the update, once', async () => {
  const srv = fakeServer({ featured: 'Sin conexión.' });
  const persisted = fresh();
  const first = await runServiceSave(persisted, input({ featured: true }), srv.actions);
  assert.equal(first.ok, false);
  assert.equal(first.ok === false && first.partial, true);
  srv.calls.length = 0;
  const retry = await runServiceSave(persisted, input({ featured: true }), srv.actions);
  assert.equal(retry.ok, true);
  assert.ok(!srv.calls.some((c) => c.startsWith('create')), 'never re-created');
  assert.equal(srv.services.size, 1);
  assert.equal(srv.services.get('svc-1')!.featured, true);
});

test('the create itself fails (atomic, nothing persisted): the retry creates — still exactly one service', async () => {
  const srv = fakeServer({ create: 'Not found for this client.' });
  const persisted = fresh();
  const first = await runServiceSave(persisted, input(), srv.actions);
  assert.deepEqual(first, { ok: false, error: 'Not found for this client.', partial: false }, 'nothing was saved, and it says so');
  assert.equal(persisted.id, null);
  const retry = await runServiceSave(persisted, input(), srv.actions);
  assert.equal(retry.ok, true);
  assert.equal(srv.services.size, 1);
});

test('editing: a site toggle fails midway; the retry only redoes what is still pending', async () => {
  const srv = fakeServer({ setStaff: 'Error temporal.' });
  srv.services.set('svc-9', { sites: new Set(['norte']), staff: new Set(['ana']), featured: false });
  const persisted: PersistedService = { id: 'svc-9', siteIds: ['norte'], staffIds: ['ana'] };
  const edit = input({ siteIds: ['norte', 'sur'], staffIds: ['caro'] }); // +sur, -ana, +caro
  const first = await runServiceSave(persisted, edit, srv.actions);
  assert.equal(first.ok, false);
  assert.deepEqual(persisted.siteIds, ['norte', 'sur'], 'the site that WAS written is recorded');
  srv.calls.length = 0;
  const retry = await runServiceSave(persisted, edit, srv.actions);
  assert.equal(retry.ok, true);
  assert.deepEqual(srv.calls, ['update(svc-9)', 'staff(ana,false)', 'staff(caro,true)'], 'no repeated site write');
  assert.deepEqual([...srv.services.get('svc-9')!.staff], ['caro']);
});

test('a thrown action (network) is reported, not swallowed into success', async () => {
  const actions: ServiceSaveActions = {
    create: async () => {
      throw new Error('fetch failed');
    },
    update: async () => ({ ok: true }),
    setSite: async () => ({ ok: true }),
    setStaff: async () => ({ ok: true }),
  };
  assert.deepEqual(await runServiceSave(fresh(), input(), actions), { ok: false, error: 'fetch failed', partial: false });
});

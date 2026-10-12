import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import {
  archiveProduct,
  createProduct,
  getProductById,
  listActiveProducts,
  listProducts,
  restoreProduct,
  setProductStock,
  updateProduct,
} from '../../src/db/repositories/catalog/products.js';
import { issueToken } from '../../src/db/repositories/handoffTokens.js';
import { priceLabelCOP } from '../../web/lib/money.js';
import { cleanupTenant, closeDb, seedProduct, seedScenario, seedWorkflow } from './fixtures.js';

after(closeDb);

const is23514 = (e: unknown) => (e as { code?: string }).code === '23514';
const is23505 = (e: unknown) => (e as { code?: string }).code === '23505';

async function catalogGet(
  tenantId: string,
  clientId: string,
  rawToken: string,
  wfRef: string,
  queryString = '',
): Promise<{ status: number; body: { products?: Array<Record<string, unknown>>; truncated?: boolean; error?: { code: string } } }> {
  const { GET } = await import('../../web/app/api/catalog/v1/products/route.js');
  const req = new Request(`http://t/api/catalog/v1/products${queryString}`, {
    headers: { Authorization: `Bearer ${rawToken}`, 'x-workflow-ref': wfRef },
  });
  const res = await GET(req);
  return { status: res.status, body: (await res.json()) as never };
}

test('products repo: CRUD + archive/restore, duplicate-name rules, DB CHECKs', async () => {
  const s = await seedScenario({ enableCatalog: true });
  try {
    // CREATE / READ / UPDATE.
    const p = await createProduct({
      tenantId: s.tenantId,
      clientId: s.clientId,
      name: 'Cera mate',
      description: 'Fijación fuerte, acabado seco.',
      price: 42000,
      category: 'Peinado',
    });
    assert.equal(p.in_stock, true, 'defaults to in stock');
    assert.equal(p.is_active, true, 'defaults to active');
    assert.equal((await getProductById(s.tenantId, s.clientId, p.id))?.price, '42000.00');
    const upd = await updateProduct(s.tenantId, s.clientId, p.id, { price: 45000, description: null });
    assert.equal(upd?.price, '45000.00');
    assert.equal(upd?.description, null, 'description cleared → null');

    // in_stock toggle (the Setter path at the repo level).
    assert.equal(await setProductStock(s.tenantId, s.clientId, p.id, false), true);
    assert.equal((await getProductById(s.tenantId, s.clientId, p.id))?.in_stock, false);

    // ARCHIVE / RESTORE (soft delete; never hard delete).
    assert.equal(await archiveProduct(s.tenantId, s.clientId, p.id), true);
    assert.equal((await getProductById(s.tenantId, s.clientId, p.id))?.is_active, false);
    assert.equal(await archiveProduct(s.tenantId, s.clientId, p.id), false, 'already archived → no-op');
    assert.equal(await restoreProduct(s.tenantId, s.clientId, p.id), true);
    assert.equal((await getProductById(s.tenantId, s.clientId, p.id))?.is_active, true);

    // DUPLICATE name within a client is refused CASE-INSENSITIVELY…
    await assert.rejects(
      createProduct({ tenantId: s.tenantId, clientId: s.clientId, name: 'CERA MATE', price: 1000 }),
      is23505,
      'a case-folded duplicate active name is refused',
    );
    // …but the SAME name in ANOTHER client is allowed.
    const other = await createProduct({ tenantId: s.tenantId, clientId: s.otherClientId, name: 'Cera mate', price: 1000 });
    assert.ok(other.id, 'same name under a different client is fine');
    // Archiving frees the name for a new active product in the same client.
    await archiveProduct(s.tenantId, s.clientId, p.id);
    const reborn = await createProduct({ tenantId: s.tenantId, clientId: s.clientId, name: 'Cera mate', price: 2000 });
    assert.ok(reborn.id, 'name reusable once the prior product is archived');

    // DB CHECKs: price > 0, description ≤500 & non-blank, name non-blank.
    await assert.rejects(createProduct({ tenantId: s.tenantId, clientId: s.clientId, name: 'Zero', price: 0 }), is23514, 'price 0 refused');
    await assert.rejects(createProduct({ tenantId: s.tenantId, clientId: s.clientId, name: 'Neg', price: -5 }), is23514, 'negative price refused');
    await assert.rejects(
      createProduct({ tenantId: s.tenantId, clientId: s.clientId, name: 'Long', price: 10, description: 'a'.repeat(501) }),
      is23514,
      '501-char description refused',
    );
    await assert.rejects(
      createProduct({ tenantId: s.tenantId, clientId: s.clientId, name: 'Blank', price: 10, description: '   ' }),
      is23514,
      'blank/whitespace description refused (must be NULL)',
    );
    await assert.rejects(createProduct({ tenantId: s.tenantId, clientId: s.clientId, name: '   ', price: 10 }), is23514, 'blank name refused');

    // CROSS-CLIENT repo guard: client A's id is invisible under client B's scope.
    assert.equal(await getProductById(s.tenantId, s.otherClientId, reborn.id), null, 'a product is not visible under another client');
    assert.equal(await setProductStock(s.tenantId, s.otherClientId, reborn.id, false), false, 'cannot toggle another client product');
  } finally {
    await cleanupTenant(s.tenantId);
  }
});

test('catalog machine API: active-only, out-of-stock, accent search, category, empty, isolation, capability, module gate, price parity', async () => {
  const s = await seedScenario({ enableScheduling: true, enableCatalog: true });
  try {
    // Seed a catalogue for client A, including an out-of-stock and an archived product.
    const balsamo = await seedProduct(s.tenantId, s.clientId, { name: 'Bálsamo para barba', price: 30, category: 'Barba' });
    const oleo = await seedProduct(s.tenantId, s.clientId, { name: 'Óleo nocturno', price: 52000, category: 'Barba', inStock: false });
    await seedProduct(s.tenantId, s.clientId, { name: 'Shampoo sólido', price: 18000, category: 'Cabello' });
    const archived = await seedProduct(s.tenantId, s.clientId, { name: 'Descontinuado', price: 9999 });
    await archiveProduct(s.tenantId, s.clientId, archived);
    // Client B has its OWN product — must never leak into A's listing.
    const bProduct = await seedProduct(s.tenantId, s.otherClientId, { name: 'Secreto de B', price: 1 });

    const wfRef = `wf-${s.tenantId.slice(0, 6)}`;
    const { connectionId } = await seedWorkflow(s.tenantId, s.clientId, wfRef);
    const { rawToken } = await issueToken(s.tenantId, connectionId, ['catalog.read']);

    // Full listing: 3 active products (archived excluded), out-of-stock present with in_stock=false.
    const all = await catalogGet(s.tenantId, s.clientId, rawToken, wfRef);
    assert.equal(all.status, 200);
    assert.equal(all.body.truncated, false, 'truncated flag present and false for a small catalogue');
    const ids = (all.body.products ?? []).map((p) => p.id);
    assert.equal(ids.length, 3, 'only the 3 ACTIVE products are returned');
    assert.ok(!ids.includes(archived), 'archived product is never returned');
    assert.ok(!ids.includes(bProduct), 'another client product never leaks');
    const oleoRow = (all.body.products ?? []).find((p) => p.id === oleo);
    assert.equal(oleoRow?.in_stock, false, 'out-of-stock product IS returned with in_stock=false');

    // Shape: id, name, description(null), price, price_label, category, in_stock — nothing else.
    const bal = (all.body.products ?? []).find((p) => p.id === balsamo)!;
    assert.deepEqual(Object.keys(bal).sort(), ['category', 'description', 'id', 'in_stock', 'name', 'price', 'price_label'].sort());
    assert.equal(bal.description, null, 'empty description is null');

    // PRICE PARITY: a product and a service at the same price (30) format identically.
    // A SEPARATE token carries scheduling.read (the catalog token deliberately lacks it).
    const { GET: ServicesGET } = await import('../../web/app/api/scheduling/v1/services/route.js');
    const { rawToken: schedToken } = await issueToken(s.tenantId, connectionId, ['scheduling.read']);
    const sReq = new Request(`http://t/api/scheduling/v1/services?site_id=${s.siteId}`, {
      headers: { Authorization: `Bearer ${schedToken}`, 'x-workflow-ref': wfRef },
    });
    const sRes = await ServicesGET(sReq);
    const sBody = (await sRes.json()) as { services: Array<{ id: string; price_label: string | null }> };
    const haircut = sBody.services.find((x) => x.id === s.serviceHaircut);
    assert.equal(bal.price_label, priceLabelCOP('30'), 'product label uses the shared money helper');
    assert.equal(bal.price_label, haircut?.price_label, 'a product and a service at price 30 read identically');

    if (process.env.PRINT_API_SAMPLE) {
      // Give one product a description so the doc sample shows both a filled and a null one,
      // plus the out-of-stock row. (Later assertions only key off ids, so this is safe.)
      await updateProduct(s.tenantId, s.clientId, balsamo, {
        description: 'Hidrata y da forma a la barba sin apelmazar.',
      });
      const sample = await catalogGet(s.tenantId, s.clientId, rawToken, wfRef);
      console.error('CATALOG_API_SAMPLE', JSON.stringify(sample.body, null, 2));
    }

    // ACCENT- and case-insensitive name search: "balsamo" finds "Bálsamo".
    const q = await catalogGet(s.tenantId, s.clientId, rawToken, wfRef, '?q=balsamo');
    assert.deepEqual((q.body.products ?? []).map((p) => p.id), [balsamo]);
    const qNone = await catalogGet(s.tenantId, s.clientId, rawToken, wfRef, '?q=noexiste');
    assert.deepEqual(qNone.body.products, [], 'no match → empty list, not an error');

    // CATEGORY filter (case-insensitive exact).
    const byCat = await catalogGet(s.tenantId, s.clientId, rawToken, wfRef, '?category=barba');
    assert.deepEqual((byCat.body.products ?? []).map((p) => p.id).sort(), [balsamo, oleo].sort());

    // ISOLATION: client B's token sees only B's product (never A's catalogue).
    const bWf = `wfb-${s.tenantId.slice(0, 6)}`;
    const { connectionId: bConn } = await seedWorkflow(s.tenantId, s.otherClientId, bWf, connectionId);
    const { rawToken: bToken } = await issueToken(s.tenantId, bConn, ['catalog.read']);
    const bList = await catalogGet(s.tenantId, s.otherClientId, bToken, bWf);
    assert.deepEqual((bList.body.products ?? []).map((p) => p.id), [bProduct], "B sees only B's product");

    // CAPABILITY: a token WITHOUT catalog.read is refused with the standard 401 body.
    const noCapGet = await catalogGet(s.tenantId, s.clientId, schedToken, wfRef); // scheduling.read only
    assert.equal(noCapGet.status, 401);
    assert.equal(noCapGet.body.error?.code, 'unauthorized');
  } finally {
    await cleanupTenant(s.tenantId);
  }
});

test('catalog machine API: empty catalogue → [], module OFF → 403 module_disabled', async () => {
  // enableCatalog defaults OFF — proves module gating independently.
  const s = await seedScenario({ enableCatalog: true });
  try {
    const wfRef = `wf-${s.tenantId.slice(0, 6)}`;
    const { connectionId } = await seedWorkflow(s.tenantId, s.clientId, wfRef);
    const { rawToken } = await issueToken(s.tenantId, connectionId, ['catalog.read']);

    const empty = await catalogGet(s.tenantId, s.clientId, rawToken, wfRef);
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body.products, []);
    assert.equal(empty.body.truncated, false);

    // The DEFAULT client can't have modules → module_disabled, even with a valid token.
    const defWf = `wfd-${s.tenantId.slice(0, 6)}`;
    const { connectionId: defConn } = await seedWorkflow(s.tenantId, s.defaultClientId, defWf, connectionId);
    const { rawToken: defToken } = await issueToken(s.tenantId, defConn, ['catalog.read']);
    const def = await catalogGet(s.tenantId, s.defaultClientId, defToken, defWf);
    assert.equal(def.status, 403);
    assert.equal(def.body.error?.code, 'module_disabled');
  } finally {
    await cleanupTenant(s.tenantId);
  }
});

test('catalog machine API: catalog module disabled for a real client → 403', async () => {
  const s = await seedScenario({ enableCatalog: false }); // catalog OFF for both clients
  try {
    const wfRef = `wf-${s.tenantId.slice(0, 6)}`;
    const { connectionId } = await seedWorkflow(s.tenantId, s.clientId, wfRef);
    const { rawToken } = await issueToken(s.tenantId, connectionId, ['catalog.read']);
    const res = await catalogGet(s.tenantId, s.clientId, rawToken, wfRef);
    assert.equal(res.status, 403);
    assert.equal(res.body.error?.code, 'module_disabled');
  } finally {
    await cleanupTenant(s.tenantId);
  }
});

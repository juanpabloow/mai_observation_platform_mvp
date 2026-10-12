import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * SOURCE CONTRACT for the PRODUCT CATALOG permission model + capability wiring. The web
 * guards import next/* and can't be driven headless (access.ts is server-only), so the
 * authorization matrix is pinned at the source — the same way the Setter/role contracts
 * are. The RUNTIME behaviour that CAN be exercised (the machine API capability/module/
 * isolation, the DB CHECKs, repo scoping) lives in test/integration/catalog.test.ts.
 *
 * Matrix being pinned:
 *   View / toggle in_stock → canReadCatalog  (= canAccessClient: owner + setter + agency; NOT staff)
 *   Create/edit/archive/restore/reorder → canManageCatalog (= canManageClient: owner + agency only)
 *   Enable/disable the module → agency only (requireFullAccessForAction, shared action)
 */

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (path: string) => readFileSync(`${root}${path}`, 'utf8');

test('access.ts: canReadCatalog delegates to canAccessClient; canManageCatalog to canManageClient', () => {
  const access = read('web/lib/access.ts');
  assert.match(access, /export function canReadCatalog\(scope: AccessScope, clientId: string\): boolean \{\s*return canAccessClient\(scope, clientId\);/);
  assert.match(access, /export function canManageCatalog\(scope: AccessScope, clientId: string\): boolean \{\s*return canManageClient\(scope, clientId\);/);
});

test('catalogActions: MANAGE tier guards create/edit/archive/restore; READ tier guards in_stock toggle', () => {
  const a = read('web/lib/catalogActions.ts');
  // The two gates resolve the module FIRST, then the role predicate.
  assert.match(a, /requireCatalogManager[\s\S]{0,260}resolveClientModuleContext\(clientId, "catalog"\)[\s\S]{0,120}canManageCatalog/);
  assert.match(a, /requireCatalogReader[\s\S]{0,260}resolveClientModuleContext\(clientId, "catalog"\)[\s\S]{0,120}canReadCatalog/);
  // Write/name/price actions are MANAGE-gated.
  for (const fn of ['createProductAction', 'updateProductAction', 'archiveProductAction', 'restoreProductAction']) {
    assert.match(a, new RegExp(`${fn}[\\s\\S]{0,420}requireCatalogManager`), `${fn} is manage-gated`);
  }
  // The in_stock toggle is the one mutation a Setter may run.
  assert.match(a, /setProductStockAction[\s\S]{0,320}requireCatalogReader/);
  // Create writes the VALIDATED route client, never a form selector.
  assert.match(a, /clientId: input\.clientId, \/\/ the VALIDATED route client/);
});

test('catalog page gates on the module AND canReadCatalog (Staff 404s)', () => {
  const page = read('web/app/clients/[clientId]/catalog/page.tsx');
  assert.match(page, /requireClientModulePage\(clientId, "catalog"\)/);
  assert.match(page, /if \(!canReadCatalog\(scope, clientId\)\) notFound\(\)/);
  // canManage decides which controls render; it never substitutes for the server gate.
  assert.match(page, /canManageCatalog\(scope, clientId\)/);
});

test('machine route + wrapper: catalog.read capability, module gate, identical refusal shapes', () => {
  const route = read('web/app/api/catalog/v1/products/route.ts');
  assert.match(route, /authenticateCatalog\(req, "catalog\.read"\)/);
  // READ-ONLY: no write verbs are exported.
  assert.doesNotMatch(route, /export async function (POST|PATCH|PUT|DELETE)/);

  const api = read('web/lib/catalogApi.ts');
  assert.match(api, /isClientModuleEnabled\(tenantId, wf\.client_id, "catalog"\)/);
  // Byte-identical refusal bodies to the CRM/scheduling families.
  assert.match(api, /catalogError\(400, "workflow_ref_required", "X-Workflow-Ref header is required\."\)/);
  assert.match(api, /catalogError\(404, "not_found", "Workflow not found\."\)/);
  assert.match(api, /catalogError\(403, "module_disabled", "Catalog module is disabled for this client\."\)/);
  assert.match(api, /Response\.json\(\{ error: \{ code, message \} \}, \{ status \}\)/);
});

test('sidebar shows Productos only when the module is on, to general-access roles (not Staff)', () => {
  const src = read('web/components/AppSidebar.tsx');
  assert.match(src, /moduleKeys\.includes\("catalog"\) && canSeeGeneral/);
  assert.match(src, /label: "Productos"/);
});

test('capability vocabulary: catalog.read is a known capability but NOT auto-granted to legacy tokens', () => {
  const h = read('src/db/repositories/handoffTokens.ts');
  // In the canonical vocabulary (so isCapability/issueToken accept it)…
  assert.match(h, /ALL_CAPABILITIES = \[[\s\S]{0,160}'catalog\.read',[\s\S]{0,40}\] as const/);
  // …but never backfilled onto existing tokens.
  assert.match(h, /LEGACY_CAPABILITIES: Capability\[\] = \['handoff', 'scheduling\.read', 'scheduling\.write'\]/);
  assert.doesNotMatch(h, /LEGACY_CAPABILITIES[^\n]*catalog/);

  // The token UI exposes the checkbox but does NOT pre-check it for new tokens.
  const ui = read('web/components/MachineTokens.tsx');
  assert.match(ui, /key: "catalog\.read", label: "Read the product catalog"/);
  assert.match(ui, /DEFAULT_CAPS = \["handoff", "scheduling\.read", "scheduling\.write"\]/);
  assert.doesNotMatch(ui, /DEFAULT_CAPS[^\n]*catalog/);
});

test('module registry + modules UI know the catalog key', () => {
  assert.match(read('src/modules/registry.ts'), /CLIENT_MODULE_KEYS = \[[\s\S]{0,120}"catalog"\] as const/);
  assert.match(read('web/components/ClientModulesPanel.tsx'), /catalog: \{\s*name: "Productos"/);
});

test('migration CATALOG-2: price > 0, description ≤500 non-blank, partial unique on active name', () => {
  const m = read('migrations/1798000000001_products.ts');
  assert.match(m, /price numeric\(10, 2\) NOT NULL CHECK \(price > 0\)/);
  assert.match(m, /char_length\(description\) <= 500 AND btrim\(description\) <> ''/);
  assert.match(m, /CREATE UNIQUE INDEX products_client_active_name_unique[\s\S]{0,160}lower\(btrim\(name\)\)\)\s*WHERE is_active/);
  // Composite FK forbids a cross-tenant client.
  assert.match(m, /FOREIGN KEY \(client_id, tenant_id\)\s*REFERENCES clients \(id, tenant_id\)/);
});

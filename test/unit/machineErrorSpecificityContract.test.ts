import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * SOURCE-LEVEL CONTRACT (no HTTP/DB — the machine routes are server-only + aliased and
 * can't run in this runner; live behavior is smoke-tested against a built server). This
 * guards the error-specificity wiring:
 *   - AUTH-stage failures stay byte-identical (401 unauthorized; 404 "Workflow not found.");
 *   - POST-auth resource errors are SPECIFIC + actionable (site/service/staff/contact/
 *     appointment_not_found, site_inactive);
 *   - malformed ids → 400 (never 404), so a fabricated id fails loudly;
 *   - the appointments LIST resolves its site WITHOUT requireActive (inactive-site history
 *     stays listable) and rejects a nonexistent contact/staff filter instead of returning [].
 */

const web = (rel: string): string => readFileSync(fileURLToPath(new URL(`../../web/${rel}`, import.meta.url)), 'utf8');

test('AUTH-stage responses are untouched (byte-identical reconnaissance resistance)', () => {
  // The handoff 401 is the single indistinguishable auth failure.
  assert.ok(web('lib/handoffApi.ts').includes('"unauthorized"'), 'handoff 401 unauthorized preserved');
  // Unknown/foreign workflow_ref stays the generic 404 "Workflow not found." on BOTH families.
  assert.ok(web('lib/schedulingApi.ts').includes('schedulingError(404, "not_found", "Workflow not found.")'), 'scheduling workflow 404 preserved');
  assert.ok(web('lib/crmApi.ts').includes('crmError(404, "not_found", "Workflow not found.")'), 'crm workflow 404 preserved');
});

test('resolveOwnedSite: malformed→400, unknown→site_not_found (404), inactive+requireActive→site_inactive (409)', () => {
  const src = web('lib/schedulingApi.ts');
  assert.ok(src.includes('schedulingError(400, "invalid_request", "site_id must be a valid UUID.")'), 'malformed site_id → 400');
  assert.ok(src.includes('"site_not_found"'), 'unknown/foreign site → site_not_found');
  assert.ok(src.includes('"site_inactive"'), 'inactive site (requireActive) → site_inactive');
  assert.ok(/opts:\s*\{\s*requireActive\?:\s*boolean\s*\}/.test(src), 'requireActive option exists');
  assert.ok(src.includes('appointmentErrorResponse'), 'transition error → appointment_not_found helper');
  assert.ok(src.includes('createErrorResponse'), 'create error → service_not_found helper');
});

test('availability/services/staff resolve the site with requireActive: true (inactive → site_inactive)', () => {
  for (const rel of [
    'app/api/scheduling/v1/availability/route.ts',
    'app/api/scheduling/v1/services/route.ts',
    'app/api/scheduling/v1/staff/route.ts',
  ]) {
    assert.ok(/resolveOwnedSite\(auth\.auth,\s*siteId,\s*\{\s*requireActive:\s*true\s*\}\)/.test(web(rel)), `${rel}: requireActive`);
  }
});

test('availability returns specific codes + 400 for malformed ids', () => {
  const src = web('app/api/scheduling/v1/availability/route.ts');
  assert.ok(src.includes('"invalid_request", "service_id and staff_id must be valid UUIDs."'), 'malformed service/staff → 400');
  assert.ok(src.includes('"service_not_found"'), 'service not enabled → service_not_found');
  assert.ok(src.includes('"staff_not_found"'), 'staff not active → staff_not_found');
  assert.ok(!/schedulingError\(404, "not_found", "Not found\."\)/.test(src), 'no generic "Not found." left');
});

test('appointments LIST: site WITHOUT requireActive; nonexistent contact/staff filter → specific 404 (never [])', () => {
  const src = web('app/api/scheduling/v1/appointments/route.ts');
  // The list must NOT require an active site (inactive-site history stays visible).
  assert.ok(/resolveOwnedSite\(auth\.auth,\s*siteIdParam\)/.test(src), 'list resolves site without requireActive');
  assert.ok(src.includes('staffBelongsToClient') && src.includes('"staff_not_found"'), 'nonexistent staff_id → staff_not_found');
  assert.ok(src.includes('contactBelongsToClient') && src.includes('"contact_not_found"'), 'nonexistent contact_id → contact_not_found');
  // CREATE pre-validates the resources for specific errors + uses the create helper.
  assert.ok(/resolveOwnedSite\(auth\.auth,\s*b\.site_id,\s*\{\s*requireActive:\s*true\s*\}\)/.test(src), 'create pre-validates the site (requireActive)');
  assert.ok(src.includes('createErrorResponse(result)'), 'create maps engine errors to specific codes');
});

test('transition routes: malformed id → 400; not-found → appointment_not_found', () => {
  for (const t of ['cancel', 'confirm', 'complete', 'no-show', 'reschedule']) {
    const src = web(`app/api/scheduling/v1/appointments/[id]/${t}/route.ts`);
    assert.ok(src.includes('"invalid_request", "appointment id must be a valid UUID."'), `${t}: malformed id → 400`);
    assert.ok(src.includes('appointmentErrorResponse(result)'), `${t}: not-found → appointment_not_found`);
    assert.ok(!src.includes('"not_found", "Not found."'), `${t}: no generic not_found`);
  }
});

test('CRM contact routes: malformed → 400; not-found → contact_not_found (never the generic not_found)', () => {
  for (const rel of [
    'app/api/crm/v1/contacts/[contactId]/route.ts',
    'app/api/crm/v1/contacts/[contactId]/tags/route.ts',
    'app/api/crm/v1/contacts/[contactId]/tags/[tag]/route.ts',
    'app/api/crm/v1/contacts/[contactId]/notes/route.ts',
    'app/api/crm/v1/contacts/lookup/route.ts',
  ]) {
    const src = web(rel);
    assert.ok(src.includes('"contact_not_found"'), `${rel}: contact_not_found`);
    assert.ok(!src.includes('"not_found", "Contact not found."'), `${rel}: no generic contact not_found`);
    assert.ok(!src.includes('"not_found", "No contact matches that identity."'), `${rel}: lookup uses contact_not_found`);
  }
  // The id-taking contact routes 400 a malformed id (not 404).
  for (const rel of [
    'app/api/crm/v1/contacts/[contactId]/route.ts',
    'app/api/crm/v1/contacts/[contactId]/tags/route.ts',
    'app/api/crm/v1/contacts/[contactId]/tags/[tag]/route.ts',
    'app/api/crm/v1/contacts/[contactId]/notes/route.ts',
  ]) {
    assert.ok(web(rel).includes('"invalid_request", "contact id must be a valid UUID."'), `${rel}: malformed id → 400`);
  }
});

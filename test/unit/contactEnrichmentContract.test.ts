import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * SOURCE CONTRACT (D-3): the wiring the pure/live tests can't reach (server-only modules).
 * Two invariants that protect against the phantom-appointment failure mode and against the
 * data-loss the old full-replace custom_fields caused:
 *   1. A CRM WRITE never returns an appointment-shaped field (upsert/PATCH/tags use the
 *      enrichment shape, not the full MachineContact). Reads keep the full shape.
 *   2. The identity-addressable writes (notes/tags) resolve READ-ONLY and NEVER create.
 */
const web = (rel: string): string => readFileSync(fileURLToPath(new URL(`../../web/${rel}`, import.meta.url)), 'utf8');

const WRITE_ROUTES = [
  'app/api/crm/v1/contacts/upsert/route.ts',
  'app/api/crm/v1/contacts/[contactId]/tags/route.ts',
  'app/api/crm/v1/contacts/[contactId]/tags/[tag]/route.ts',
];

test('D-3 §risk: every CRM write returns the enrichment shape — no next_appointment', () => {
  for (const rel of WRITE_ROUTES) {
    const src = web(rel);
    assert.ok(src.includes('loadEnrichmentContact('), `${rel}: write must return the enrichment shape`);
    assert.ok(!src.includes('loadMachineContact('), `${rel}: a write must NOT return the full contact (no next_appointment)`);
  }
  // PATCH is a write (→ enrichment); GET on the same file is a read (→ full contact).
  const contactRoute = web('app/api/crm/v1/contacts/[contactId]/route.ts');
  assert.ok(contactRoute.includes('loadEnrichmentContact('), 'PATCH returns the enrichment shape');
  assert.ok(contactRoute.includes('loadMachineContact('), 'GET (read) still returns the full contact');
});

test('D-3 §risk: the EnrichmentContact type carries no appointment-shaped field', () => {
  const api = web('lib/crmApi.ts');
  // Slice just the interface declaration (stop at the loader's doc comment, whose prose
  // legitimately mentions "appointment").
  const type = api.slice(api.indexOf('export interface EnrichmentContact'), api.indexOf('/** Load the lean enrichment'));
  assert.ok(type.length > 0, 'EnrichmentContact interface exists');
  for (const forbidden of ['next_appointment', 'start_at', 'start_label', 'date_label', 'public_reference', 'service_name', 'staff_name']) {
    assert.ok(!type.includes(forbidden), `EnrichmentContact must not include ${forbidden}`);
  }
});

test('D-3 §1: notes + tags are identity-addressable and NEVER create a contact', () => {
  for (const rel of [
    'app/api/crm/v1/contacts/[contactId]/notes/route.ts',
    'app/api/crm/v1/contacts/[contactId]/tags/route.ts',
    'app/api/crm/v1/contacts/[contactId]/tags/[tag]/route.ts',
  ]) {
    const src = web(rel);
    assert.ok(src.includes('resolveContactTarget('), `${rel}: resolves the contact via the shared by-identity helper`);
    assert.ok(!src.includes('resolveContactByIdentity('), `${rel}: a note/tag write must NEVER create a contact`);
  }
});

test('D-3 §1: resolveContactTarget resolves READ-ONLY (findContactIdsByIdentity), 404s unknown, ambiguates >1', () => {
  // crmApi.ts never imports the creating chokepoint, so these file-level checks are safe.
  const api = web('lib/crmApi.ts');
  assert.ok(api.includes('findContactIdsByIdentity('), 'uses the read-only identity lookup (no create)');
  assert.ok(!api.includes('resolveContactByIdentity('), 'crmApi never calls the creating chokepoint');
  assert.ok(api.includes('BY_IDENTITY'), 'branches on the by-identity sentinel');
  assert.ok(api.includes('"contact_not_found"'), 'unknown identity → 404 contact_not_found');
  assert.ok(api.includes('"ambiguous_match"'), 'more than one match → ambiguous_match');
});

test('D-3 §1: the by-identity sentinel matches the scheduling by-time convention (a literal path segment)', () => {
  const api = web('lib/crmApi.ts');
  assert.ok(api.includes('export const BY_IDENTITY = "by-identity"'), 'BY_IDENTITY sentinel exported');
  const sched = web('lib/semanticParams.ts');
  assert.ok(sched.includes('export const BY_TIME = "by-time"'), 'mirrors scheduling BY_TIME — same convention');
});

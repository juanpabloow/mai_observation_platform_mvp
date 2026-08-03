import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * SOURCE-LEVEL CONTRACT for the CRM v1 route handlers (C-5). The real security semantics
 * (isolation, capability enforcement, refusal bodies) are proven live against the running
 * server; THIS guards the declarative wiring the root runner can't execute:
 *  - every handler calls authenticateCrm BEFORE it reads body/params, so a request
 *    without valid credentials/capability never reaches validation;
 *  - each route declares the CORRECT capability (reads → crm.read, writes → crm.write).
 */

const v1 = fileURLToPath(new URL('../../web/app/api/crm/v1/', import.meta.url));
const read = (rel: string): string => readFileSync(`${v1}${rel}`, 'utf8');
const INPUT_TOKENS = ['req.json(', '.searchParams', 'await params'];

interface RouteCap {
  rel: string;
  caps: string[]; // one per handler, in file order
}
const ROUTES: RouteCap[] = [
  { rel: 'contacts/lookup/route.ts', caps: ['crm.read'] },
  { rel: 'contacts/upsert/route.ts', caps: ['crm.write'] },
  { rel: 'contacts/[contactId]/route.ts', caps: ['crm.read', 'crm.write'] }, // GET, PATCH
  { rel: 'contacts/[contactId]/notes/route.ts', caps: ['crm.write'] },
  { rel: 'contacts/[contactId]/tags/route.ts', caps: ['crm.write'] },
  { rel: 'contacts/[contactId]/tags/[tag]/route.ts', caps: ['crm.write'] },
  { rel: 'field-definitions/route.ts', caps: ['crm.read'] },
];

function handlerSegments(src: string): string[] {
  return src.split(/export async function /).slice(1);
}

test('every CRM handler authenticates (with the right capability) before reading input', () => {
  for (const { rel, caps } of ROUTES) {
    const segs = handlerSegments(read(rel));
    assert.equal(segs.length, caps.length, `${rel}: expected ${caps.length} handler(s)`);
    segs.forEach((seg, i) => {
      const authCall = `authenticateCrm(req, "${caps[i]}")`;
      const auth = seg.indexOf(authCall);
      assert.ok(auth >= 0, `${rel} handler #${i + 1}: must call ${authCall}`);
      for (const tok of INPUT_TOKENS) {
        const j = seg.indexOf(tok);
        if (j >= 0) assert.ok(auth < j, `${rel} handler #${i + 1}: authenticateCrm must precede ${JSON.stringify(tok)}`);
      }
    });
  }
});

test('reads require crm.read, writes require crm.write (no over-grant)', () => {
  // Reads
  assert.ok(read('contacts/lookup/route.ts').includes('authenticateCrm(req, "crm.read")'));
  assert.ok(read('field-definitions/route.ts').includes('authenticateCrm(req, "crm.read")'));
  assert.ok(read('contacts/[contactId]/route.ts').includes('authenticateCrm(req, "crm.read")')); // GET
  // Writes
  for (const rel of [
    'contacts/upsert/route.ts',
    'contacts/[contactId]/notes/route.ts',
    'contacts/[contactId]/tags/route.ts',
    'contacts/[contactId]/tags/[tag]/route.ts',
  ]) {
    assert.ok(read(rel).includes('authenticateCrm(req, "crm.write")'), `${rel}: must require crm.write`);
    assert.ok(!read(rel).includes('crm.read'), `${rel}: a write route must not use crm.read`);
  }
  assert.ok(read('contacts/[contactId]/route.ts').includes('authenticateCrm(req, "crm.write")')); // PATCH
});

test('upsert is the only route that resolves-or-creates a contact; lookup creates nothing', () => {
  assert.ok(read('contacts/upsert/route.ts').includes('resolveContactByIdentity('), 'upsert uses the C-2 chokepoint');
  assert.ok(!read('contacts/lookup/route.ts').includes('resolveContactByIdentity('), 'lookup must not create');
  assert.ok(read('contacts/lookup/route.ts').includes('findContactIdsByIdentity('), 'lookup is a read-only identity lookup');
});

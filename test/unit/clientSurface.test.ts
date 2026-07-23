import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { parseClientSurface } from '../../web/lib/clientSurface.js';

/** The pure client-surface parser behind the header breadcrumb. */

const CID = '5f0c3d54-1234-4abc-9def-0123456789ab';

test('recognizes every client-level surface', () => {
  assert.deepEqual(parseClientSurface(`/clients/${CID}/team`), { clientId: CID, label: 'Team' });
  assert.deepEqual(parseClientSurface(`/clients/${CID}/modules`), { clientId: CID, label: 'Modules' });
  assert.deepEqual(parseClientSurface(`/clients/${CID}/contacts`), { clientId: CID, label: 'Contacts' });
  // Detail routes still resolve to the same surface.
  assert.deepEqual(parseClientSurface(`/clients/${CID}/contacts/abc-123`), { clientId: CID, label: 'Contacts' });
  assert.deepEqual(parseClientSurface(`/clients/${CID}/scheduling/agenda`), { clientId: CID, label: 'Agenda' });
  assert.deepEqual(parseClientSurface(`/clients/${CID}/scheduling/agenda/`), { clientId: CID, label: 'Agenda' });
});

test('workflow routes and non-client paths are NOT client surfaces', () => {
  assert.equal(parseClientSurface(`/clients/${CID}/workflows/wf1/executions`), null);
  assert.equal(parseClientSurface(`/clients/${CID}`), null);
  assert.equal(parseClientSurface('/contacts'), null);
  assert.equal(parseClientSurface('/scheduling/agenda'), null);
  assert.equal(parseClientSurface('/'), null);
  // A surface name embedded elsewhere doesn't match.
  assert.equal(parseClientSurface(`/clients/${CID}/teamster`), null);
});

test('client id is URL-decoded', () => {
  const parsed = parseClientSurface('/clients/a%20b/team');
  assert.deepEqual(parsed, { clientId: 'a b', label: 'Team' });
});

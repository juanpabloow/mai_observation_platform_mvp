import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { parseClientSurface } from '../../web/lib/clientSurface.js';

/** The pure client-surface parser behind the header breadcrumb. */

const CID = '5f0c3d54-1234-4abc-9def-0123456789ab';

test('recognizes every client-level surface', () => {
  assert.deepEqual(parseClientSurface(`/clients/${CID}/team`), { clientId: CID, label: 'Users & access' });
  assert.deepEqual(parseClientSurface(`/clients/${CID}/modules`), { clientId: CID, label: 'Modules' });
  assert.deepEqual(parseClientSurface(`/clients/${CID}/contacts`), { clientId: CID, label: 'Contacts', group: 'CRM' });
  // Detail routes still resolve to the same surface.
  assert.deepEqual(parseClientSurface(`/clients/${CID}/contacts/abc-123`), { clientId: CID, label: 'Contacts', group: 'CRM' });
  assert.deepEqual(parseClientSurface(`/clients/${CID}/scheduling/agenda`), { clientId: CID, label: 'Agenda', group: 'Scheduling' });
  assert.deepEqual(parseClientSurface(`/clients/${CID}/scheduling/agenda/`), { clientId: CID, label: 'Agenda', group: 'Scheduling' });
  // Per-client scheduling admin (canonical route).
  assert.deepEqual(parseClientSurface(`/clients/${CID}/scheduling/admin`), {
    clientId: CID,
    label: 'Scheduling settings',
    group: 'Scheduling',
  });
  // Final design: the Workflows LIST page + the client-level Inbox (incl. its thread).
  assert.deepEqual(parseClientSurface(`/clients/${CID}/workflows`), { clientId: CID, label: 'Workflows' });
  assert.deepEqual(parseClientSurface(`/clients/${CID}/inbox`), { clientId: CID, label: 'Inbox' });
  assert.deepEqual(parseClientSurface(`/clients/${CID}/inbox/abc-123`), { clientId: CID, label: 'Inbox' });
});

test('Contacts is grouped under CRM — never under Scheduling', () => {
  // The reference mock renders "Gallery Barber Club / Scheduling / Contacts". That is
  // a design inconsistency: the route is gated by the `crm` module, so the breadcrumb
  // must not invent a Contacts-inside-Scheduling hierarchy.
  const contacts = parseClientSurface(`/clients/${CID}/contacts`);
  assert.equal(contacts?.group, 'CRM');
  assert.notEqual(contacts?.group, 'Scheduling');
});

test('surfaces that hang directly off the client carry NO group segment', () => {
  // "Client / Inbox", not "Client / <something> / Inbox".
  assert.equal(parseClientSurface(`/clients/${CID}/inbox`)?.group, undefined);
  assert.equal(parseClientSurface(`/clients/${CID}/team`)?.group, undefined);
  assert.equal(parseClientSurface(`/clients/${CID}/modules`)?.group, undefined);
  assert.equal(parseClientSurface(`/clients/${CID}/workflows`)?.group, undefined);
});

test('workflow routes and non-client paths are NOT client surfaces', () => {
  // A SPECIFIC workflow is a workflow route (parseWorkflowRoute), not the list surface.
  assert.equal(parseClientSurface(`/clients/${CID}/workflows/wf1/executions`), null);
  assert.equal(parseClientSurface(`/clients/${CID}/workflows/all/analytics`), null);
  assert.equal(parseClientSurface(`/clients/${CID}`), null);
  assert.equal(parseClientSurface('/contacts'), null);
  assert.equal(parseClientSurface('/scheduling/agenda'), null);
  assert.equal(parseClientSurface('/'), null);
  // A surface name embedded elsewhere doesn't match.
  assert.equal(parseClientSurface(`/clients/${CID}/teamster`), null);
});

test('client id is URL-decoded', () => {
  const parsed = parseClientSurface('/clients/a%20b/team');
  assert.deepEqual(parsed, { clientId: 'a b', label: 'Users & access' });
});

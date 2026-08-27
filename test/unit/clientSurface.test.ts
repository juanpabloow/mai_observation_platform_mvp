import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { parseClientSurface } from '../../web/lib/clientSurface.js';

/** The pure client-surface parser behind the header breadcrumb. */

const CID = '5f0c3d54-1234-4abc-9def-0123456789ab';

test('recognizes every client-level surface', () => {
  assert.deepEqual(parseClientSurface(`/clients/${CID}/team`), { clientId: CID, label: 'Usuarios y accesos' });
  assert.deepEqual(parseClientSurface(`/clients/${CID}/modules`), { clientId: CID, label: 'Módulos' });
  assert.deepEqual(parseClientSurface(`/clients/${CID}/contacts`), { clientId: CID, label: 'Contactos' });
  // Detail routes still resolve to the same surface.
  assert.deepEqual(parseClientSurface(`/clients/${CID}/contacts/abc-123`), { clientId: CID, label: 'Contactos' });
  assert.deepEqual(parseClientSurface(`/clients/${CID}/scheduling/agenda`), { clientId: CID, label: 'Agenda' });
  assert.deepEqual(parseClientSurface(`/clients/${CID}/scheduling/agenda/`), { clientId: CID, label: 'Agenda' });
  // Per-client scheduling admin (canonical route).
  assert.deepEqual(parseClientSurface(`/clients/${CID}/scheduling/admin`), {
    clientId: CID,
    label: 'Configuración de agenda',
  });
  // Final design: the Workflows LIST page + the client-level Inbox (incl. its thread).
  assert.deepEqual(parseClientSurface(`/clients/${CID}/workflows`), { clientId: CID, label: 'Flujos' });
  assert.deepEqual(parseClientSurface(`/clients/${CID}/inbox`), { clientId: CID, label: 'Inbox' });
  assert.deepEqual(parseClientSurface(`/clients/${CID}/inbox/abc-123`), { clientId: CID, label: 'Inbox' });
});

test('the trail is TWO segments — no module group between the client and the page', () => {
  // The group segment ("Client / CRM / Contacts") is gone, and with it the field.
  //
  // Two reasons it had to go, and neither is cosmetic. The rail already groups these
  // pages under WORKSPACE / CRM / SCHEDULING / ADMINISTRATION headings a couple of
  // hundred pixels to the left, so the breadcrumb spent a segment restating context the
  // reader can see. And "CRM" was not a link — there is no /clients/x/crm page — so a
  // three-segment trail implied a hierarchy you could climb and then refused to let you.
  //
  // Asserted structurally rather than by name: the parser must return EXACTLY the two
  // keys, so re-adding a third segment fails here rather than silently reappearing.
  for (const path of ['contacts', 'scheduling/agenda', 'scheduling/staff', 'inbox', 'team', 'modules']) {
    const parsed = parseClientSurface(`/clients/${CID}/${path}`);
    assert.ok(parsed, `${path} resolves`);
    assert.deepEqual(Object.keys(parsed!).sort(), ['clientId', 'label'], `${path} carries no third segment`);
  }
});

test('every label a person reads is in Spanish', () => {
  // The surfaces are Spanish; a trail that says "Users & access" over a screen titled
  // "Usuarios y accesos" is the mixed-language state this rework removed.
  const labels = ['contacts', 'scheduling/agenda', 'scheduling/staff', 'scheduling/admin', 'team', 'modules', 'workflows']
    .map((p) => parseClientSurface(`/clients/${CID}/${p}`)?.label);
  for (const l of labels) {
    assert.ok(l, 'the surface resolves');
    // No English left behind. "Inbox" is deliberately absent from this list: it is the
    // word the product uses in Spanish too.
    assert.equal(/^(Users|Modules|Contacts|Workflows|Scheduling|Staff|Team)\b/.test(l!), false, `"${l}" is not English`);
  }
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
  assert.deepEqual(parsed, { clientId: 'a b', label: 'Usuarios y accesos' });
});

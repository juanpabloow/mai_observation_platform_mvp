import { randomUUID } from 'node:crypto';
import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { query, withTransaction } from '../../src/db/client.js';
import {
  listContactConversations,
  listContacts,
} from '../../src/db/repositories/contacts.js';
import { resolveContactByIdentity } from '../../src/db/repositories/contactIdentities.js';
// C-2 shim: resolveOrCreateContact was replaced by the identity chokepoint.
const resolveOrCreateContact = async (i: Parameters<typeof resolveContactByIdentity>[0]) =>
  (await resolveContactByIdentity(i)).contact;
import {
  insertAppointment,
  listAppointments,
  listAppointmentsForContact,
  listEventsForContact,
  recordAppointmentEvent,
} from '../../src/db/repositories/scheduling/appointments.js';
import { zonedPartsToUtc } from '../../src/scheduling/timezone.js';
import { cleanupTenant, closeDb, seedScenario, seedSiteForClient, seedWorkflow } from './fixtures.js';

/**
 * Phase 3A read-side defense: the DB does NOT guarantee that
 * conversations.contact_id / appointments.contact_id stay within one client
 * (the machine/n8n write path is Phase 3B). These tests DELIBERATELY build the
 * inconsistent state — a client-A contact with a client-B conversation and a
 * client-B appointment attached — and assert client A's detail reads and list
 * aggregates never surface any of it.
 */

const TZ = 'America/Bogota';
const at = (h: number): Date => zonedPartsToUtc(2026, 8, 5, h, 0, TZ);

const tenants: string[] = [];

after(async () => {
  for (const t of tenants) await cleanupTenant(t);
  await closeDb();
});

test('mislinked cross-client conversation/appointment never surface on the contact', async () => {
  const s = await seedScenario();
  tenants.push(s.tenantId);
  const other = await seedSiteForClient(s.tenantId, s.otherClientId);

  // The client-A contact.
  const contact = await resolveOrCreateContact({
    tenantId: s.tenantId, clientId: s.clientId, channel: 'whatsapp', channelUserId: '573001110001', name: 'Alice',
  });

  // Workflows: wfA belongs to client A, wfB to client B.
  await seedWorkflow(s.tenantId, s.clientId, 'wf-A');
  await seedWorkflow(s.tenantId, s.otherClientId, 'wf-B');

  // A legit client-A conversation AND a MISLINKED client-B conversation, both
  // pointing at the client-A contact. The B one has the LATEST message time, so
  // an unfiltered aggregate would pick it up as last_conversation_at.
  const convRows = await query<{ id: string; n8n_workflow_id: string }>(
    `INSERT INTO conversations (tenant_id, n8n_workflow_id, conversation_ref, contact_id, last_message_at)
       VALUES ($1, 'wf-A', $2, $3, now() - interval '2 days'),
              ($1, 'wf-B', $4, $3, now())
     RETURNING id, n8n_workflow_id`,
    [s.tenantId, `ref-${randomUUID().slice(0, 8)}`, contact.id, `ref-${randomUUID().slice(0, 8)}`],
  );
  const convA = convRows.rows.find((c) => c.n8n_workflow_id === 'wf-A')!;

  // A MISLINKED client-B COMPLETED appointment attached to the client-A contact
  // AND to client A's conversation (raw insert — the domain service wouldn't
  // produce this; that's the point).
  const apptB = await withTransaction((client) =>
    insertAppointment(client, {
      tenantId: s.tenantId, clientId: s.otherClientId, siteId: other.siteId, contactId: contact.id,
      sourceConversationId: convA.id, staffId: other.staffId, serviceId: other.serviceId,
      startAt: at(9), serviceEndAt: at(10), blockedFrom: at(9), blockedUntil: at(10),
      serviceNameSnapshot: 'Other svc', durationMinSnapshot: 60, priceSnapshot: null,
      bufferBeforeMinSnapshot: 0, bufferAfterMinSnapshot: 0,
      origin: 'internal', createdByType: 'agent', createdByUserId: null, idempotencyKey: null,
    }),
  );
  await query(`UPDATE appointments SET status = 'completed' WHERE id = $1`, [apptB.id]);
  await recordAppointmentEvent({
    tenantId: s.tenantId, appointmentId: apptB.id, eventType: 'appointment_completed', actorType: 'agent',
  });

  // ── Detail reads for client A must exclude every mislinked record ──
  const convs = await listContactConversations(s.tenantId, contact.id, s.clientId);
  assert.deepEqual(convs.map((c) => c.n8n_workflow_id), ['wf-A'], 'only the client-A conversation is listed');

  const appts = await listAppointmentsForContact(s.tenantId, contact.id, s.clientId);
  assert.equal(appts.length, 0, "client B's appointment never surfaces on client A's contact");

  const events = await listEventsForContact(s.tenantId, contact.id, s.clientId);
  assert.equal(events.length, 0, "client B's appointment events never surface either");

  // ── List aggregates for client A must ignore them too ──
  const { items: list } = await listContacts(s.tenantId, { clientId: s.clientId });
  const row = list.find((c) => c.id === contact.id);
  assert.ok(row);
  assert.equal(row.visit_count, 0, "B's completed appointment doesn't count as a visit");
  assert.equal(row.is_customer, false, 'no customer status from a foreign-client appointment');
  assert.equal(row.next_appointment_at, null);
  // last_conversation_at comes from wf-A (2 days ago), NOT the newer wf-B one.
  assert.ok(row.last_conversation_at, 'the legit client-A conversation still counts');
  assert.ok(
    new Date(row.last_conversation_at as unknown as string).getTime() < Date.now() - 24 * 60 * 60 * 1000,
    'the newer cross-client conversation did not become last_conversation_at',
  );

  // ── Client B's own view: the appointment is visible as B's, but NO identity
  // of client A leaks through it (Phase 3A finding: joins were UUID-only) ──
  const apptsB = await listAppointmentsForContact(s.tenantId, contact.id, s.otherClientId);
  assert.equal(apptsB.length, 1, "the appointment is still B's appointment");
  const bRow = apptsB[0];
  assert.equal(bRow.contact_id, null, "A's contact UUID is neutralized to null");
  assert.equal(bRow.contact_name, null, "A's contact name is neutralized to null");
  assert.equal(bRow.source_conversation_id, null, "A's conversation id is neutralized to null");
  // Nothing of A anywhere in the projected row.
  const serialized = JSON.stringify(bRow);
  assert.ok(!serialized.includes(contact.id), "A's contact UUID appears nowhere");
  assert.ok(!serialized.includes('Alice'), "A's contact name appears nowhere");
  assert.ok(!serialized.includes(convA.id), "A's conversation UUID appears nowhere");
  // Same neutralization through the generic list under B's scope.
  const listB = await listAppointments(s.tenantId, { clientId: s.otherClientId });
  const bViaList = listB.find((a) => a.id === apptB.id);
  assert.ok(bViaList);
  assert.equal(bViaList.contact_id, null);
  assert.equal(bViaList.contact_name, null);
  assert.equal(bViaList.source_conversation_id, null);
});

test('a consistent appointment keeps its own contact and source conversation (no over-nulling)', async () => {
  const s = await seedScenario();
  tenants.push(s.tenantId);
  const other = await seedSiteForClient(s.tenantId, s.otherClientId);
  await seedWorkflow(s.tenantId, s.otherClientId, 'wf-B2');

  // Everything belongs to client B: contact, conversation (wf of B), appointment.
  const contactB = await resolveOrCreateContact({
    tenantId: s.tenantId, clientId: s.otherClientId, channel: 'whatsapp', channelUserId: '573001110002', name: 'Bruno',
  });
  const conv = await query<{ id: string }>(
    `INSERT INTO conversations (tenant_id, n8n_workflow_id, conversation_ref, contact_id)
       VALUES ($1, 'wf-B2', $2, $3) RETURNING id`,
    [s.tenantId, `ref-${randomUUID().slice(0, 8)}`, contactB.id],
  );
  const appt = await withTransaction((client) =>
    insertAppointment(client, {
      tenantId: s.tenantId, clientId: s.otherClientId, siteId: other.siteId, contactId: contactB.id,
      sourceConversationId: conv.rows[0].id, staffId: other.staffId, serviceId: other.serviceId,
      startAt: at(11), serviceEndAt: at(12), blockedFrom: at(11), blockedUntil: at(12),
      serviceNameSnapshot: 'Other svc', durationMinSnapshot: 60, priceSnapshot: null,
      bufferBeforeMinSnapshot: 0, bufferAfterMinSnapshot: 0,
      origin: 'internal', createdByType: 'agent', createdByUserId: null, idempotencyKey: null,
    }),
  );
  const rows = await listAppointments(s.tenantId, { clientId: s.otherClientId });
  const row = rows.find((a) => a.id === appt.id);
  assert.ok(row);
  assert.equal(row.contact_id, contactB.id, 'own contact id preserved');
  assert.equal(row.contact_name, 'Bruno', 'own contact name preserved');
  assert.equal(row.source_conversation_id, conv.rows[0].id, 'own conversation preserved');
});

test("an appointment stamped client B but using client A's site/staff is EXCLUDED from lists", async () => {
  const s = await seedScenario();
  tenants.push(s.tenantId);
  // Raw inconsistent insert: client_id = B, but site + staff belong to client A.
  const inconsistent = await withTransaction((client) =>
    insertAppointment(client, {
      tenantId: s.tenantId, clientId: s.otherClientId, siteId: s.siteId, contactId: null,
      sourceConversationId: null, staffId: s.staffA, serviceId: s.serviceHaircut,
      startAt: at(14), serviceEndAt: at(15), blockedFrom: at(14), blockedUntil: at(15),
      serviceNameSnapshot: 'Haircut', durationMinSnapshot: 60, priceSnapshot: null,
      bufferBeforeMinSnapshot: 0, bufferAfterMinSnapshot: 0,
      origin: 'internal', createdByType: 'agent', createdByUserId: null, idempotencyKey: null,
    }),
  );
  // Required resources (site/staff) join on ownership → the inconsistent row is
  // excluded everywhere: B's list, A's list, and the tenant-wide list. Client A's
  // site name/staff name never render under client B.
  const listB = await listAppointments(s.tenantId, { clientId: s.otherClientId });
  assert.ok(!listB.some((a) => a.id === inconsistent.id), "not in B's list");
  const listA = await listAppointments(s.tenantId, { clientId: s.clientId });
  assert.ok(!listA.some((a) => a.id === inconsistent.id), "not in A's list either (client_id is B)");
  const listAll = await listAppointments(s.tenantId);
  assert.ok(!listAll.some((a) => a.id === inconsistent.id), 'not in the tenant-wide list');
});

test('runtime fail-closed: omitting clientId returns ZERO rows, never tenant-wide data', async () => {
  const s = await seedScenario();
  tenants.push(s.tenantId);
  await seedWorkflow(s.tenantId, s.clientId, 'wf-FC');
  const contact = await resolveOrCreateContact({
    tenantId: s.tenantId, clientId: s.clientId, channel: 'whatsapp', channelUserId: '573001110003', name: 'Cleo',
  });
  await query(
    `INSERT INTO conversations (tenant_id, n8n_workflow_id, conversation_ref, contact_id)
       VALUES ($1, 'wf-FC', $2, $3)`,
    [s.tenantId, `ref-${randomUUID().slice(0, 8)}`, contact.id],
  );
  const appt = await withTransaction((client) =>
    insertAppointment(client, {
      tenantId: s.tenantId, clientId: s.clientId, siteId: s.siteId, contactId: contact.id,
      sourceConversationId: null, staffId: s.staffA, serviceId: s.serviceHaircut,
      startAt: at(16), serviceEndAt: at(17), blockedFrom: at(16), blockedUntil: at(17),
      serviceNameSnapshot: 'Haircut', durationMinSnapshot: 60, priceSnapshot: null,
      bufferBeforeMinSnapshot: 0, bufferAfterMinSnapshot: 0,
      origin: 'internal', createdByType: 'agent', createdByUserId: null, idempotencyKey: null,
    }),
  );
  await recordAppointmentEvent({
    tenantId: s.tenantId, appointmentId: appt.id, eventType: 'appointment_created', actorType: 'agent',
  });

  // Deliberately UNTYPED calls (what a JS caller could do): the third argument is
  // omitted. Every function must return [] — never widen to tenant-wide data.
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const noClientAppts = await (listAppointmentsForContact as any)(s.tenantId, contact.id);
  const noClientConvs = await (listContactConversations as any)(s.tenantId, contact.id);
  const noClientEvents = await (listEventsForContact as any)(s.tenantId, contact.id);
  /* eslint-enable @typescript-eslint/no-explicit-any */
  assert.deepEqual(noClientAppts, [], 'appointments: fail closed');
  assert.deepEqual(noClientConvs, [], 'conversations: fail closed');
  assert.deepEqual(noClientEvents, [], 'events: fail closed');

  // Positive control: with the clientId the same data IS returned.
  assert.equal((await listAppointmentsForContact(s.tenantId, contact.id, s.clientId)).length, 1);
  assert.equal((await listContactConversations(s.tenantId, contact.id, s.clientId)).length, 1);
  assert.equal((await listEventsForContact(s.tenantId, contact.id, s.clientId)).length, 1);
});

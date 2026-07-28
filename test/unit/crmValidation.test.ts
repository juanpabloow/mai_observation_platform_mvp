import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  CreateNoteInput,
  CreateTaskInput,
  CreateTagInput,
  ChangeStageInput,
  parse,
} from '../../web/lib/crmValidation.js';

/** Pure strict validators for the CRM actions — no coercion, unknown keys rejected. */
const UUID = '5f0c3d54-1234-4abc-9def-0123456789ab';

test('note: valid passes; empty/whitespace body + unknown keys rejected', () => {
  assert.ok(parse(CreateNoteInput, { clientId: UUID, contactId: UUID, body: 'hi' }).ok);
  assert.equal(parse(CreateNoteInput, { clientId: UUID, contactId: UUID, body: '   ' }).ok, false, 'blank body');
  assert.equal(parse(CreateNoteInput, { clientId: UUID, contactId: UUID, body: 'hi', extra: 1 }).ok, false, 'unknown key');
  assert.equal(parse(CreateNoteInput, { clientId: 'not-a-uuid', contactId: UUID, body: 'hi' }).ok, false, 'bad uuid');
});

test('task: enums exact, ISO due date, no coercion, optional nulls allowed', () => {
  assert.ok(parse(CreateTaskInput, { clientId: UUID, contactId: UUID, title: 'T', priority: 'high', dueAt: '2027-01-01T10:00:00Z' }).ok);
  assert.ok(parse(CreateTaskInput, { clientId: UUID, contactId: UUID, title: 'T', dueAt: null, assignedToUserId: null }).ok);
  assert.equal(parse(CreateTaskInput, { clientId: UUID, contactId: UUID, title: 'T', priority: 'urgent' }).ok, false, 'bad enum');
  assert.equal(parse(CreateTaskInput, { clientId: UUID, contactId: UUID, title: 'T', dueAt: '2027-01-01' }).ok, false, 'non-ISO date');
  assert.equal(parse(CreateTaskInput, { clientId: UUID, contactId: UUID, title: '' }).ok, false, 'empty title');
});

test('tag: color enum enforced; stage enum enforced', () => {
  assert.ok(parse(CreateTagInput, { clientId: UUID, name: 'VIP', color: 'amber' }).ok);
  assert.equal(parse(CreateTagInput, { clientId: UUID, name: 'VIP', color: 'chartreuse' }).ok, false);
  assert.ok(parse(ChangeStageInput, { clientId: UUID, contactId: UUID, stage: 'active' }).ok);
  assert.equal(parse(ChangeStageInput, { clientId: UUID, contactId: UUID, stage: 'lead' }).ok, false);
});

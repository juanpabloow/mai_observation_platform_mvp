import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  agoEs,
  avatarText,
  capCount,
  clock24,
  confirmCopy,
  conversationTitle,
  dayBuckets,
  daySeam,
  inTab,
  isPhoneRef,
  listStamp,
  matchesSearch,
  previewLines,
  responder,
  tabCounts,
  threadActionPlan,
  windowChip,
  windowClosedLine,
  windowState,
} from '../../web/lib/inboxPresent.js';
import { validateNoteBody, validateTagName, validateTaskTitle, TAG_NAME_MAX } from '../../web/lib/crmFieldRules.js';
import { groupConversations, INBOX_GROUP_ORDER } from '../../web/lib/inboxGroups.js';

/**
 * The inbox redesign's pure rules ("Inbox de Gallery"): Spanish 24 h dates, titles and
 * avatars, the three state signals, the 24 h window, tabs, search and the take/return plan.
 * Times are built in the runner's LOCAL zone, as the browser formats them.
 */

const at = (y: number, mo: number, d: number, h = 12, mi = 0) => new Date(y, mo - 1, d, h, mi);
const NOW = at(2026, 10, 15, 14, 30); // Thursday

test('dates: 24 h clock, list stamp (hoy · Ayer · Lun · 10 oct) and day seam', () => {
  assert.equal(clock24(at(2026, 10, 15, 9, 5)), '09:05');
  assert.equal(listStamp(at(2026, 10, 15, 14, 8), NOW), '14:08');
  assert.equal(listStamp(at(2026, 10, 14, 23, 50), NOW), 'Ayer');
  assert.equal(listStamp(at(2026, 10, 12, 10), NOW), 'Lun');
  assert.equal(listStamp(at(2026, 10, 10, 10), NOW), 'Sáb');
  assert.equal(listStamp(at(2026, 10, 8, 10), NOW), '8 oct', 'a week or more → day + month');
  assert.equal(listStamp(at(2025, 12, 20), NOW), '20 dic 2025', 'another year carries the year');
  assert.equal(daySeam(at(2026, 10, 15, 8), NOW), 'Hoy');
  assert.equal(daySeam(at(2026, 10, 14, 8), NOW), 'Ayer');
  assert.equal(daySeam(at(2026, 10, 10, 8), NOW), 'Sáb 10 oct');
  assert.equal(agoEs(20 * 60_000), 'hace 20 min');
  assert.equal(agoEs(5 * 3_600_000), 'hace 5 h');
  assert.equal(agoEs(3 * 86_400_000 + 1), 'hace 3 d');
});

test('identity: name, else known phone, else "Contacto sin nombre"; a channel id is never a number', () => {
  assert.deepEqual(conversationTitle('Mariana Duarte', '573105550187'), { text: 'Mariana Duarte', kind: 'name' });
  assert.deepEqual(conversationTitle(null, '573005550142'), { text: '+57 300 555 0142', kind: 'phone' });
  assert.deepEqual(conversationTitle('  ', 'wa-bsuid-7f3c9a'), { text: 'Contacto sin nombre', kind: 'unknown' });
  assert.equal(isPhoneRef('wa-bsuid-7f3c9a'), false);
  assert.equal(isPhoneRef('1234567'), false, 'too short to be a phone');
  assert.equal(avatarText('Mariana Duarte', 'x'), 'MD');
  assert.equal(avatarText('Falla', 'x'), 'F');
  assert.equal(avatarText(null, '573005550142'), '#');
  assert.equal(avatarText(null, 'wa-bsuid-7f3c9a'), '?');
});

test('who answers: pending / you / a colleague / the bot — from ids, never from names', () => {
  assert.deepEqual(responder('pending', null, null, 'me'), { kind: 'pending', label: 'Necesita una persona' });
  assert.deepEqual(responder('bot', null, null, 'me'), { kind: 'bot', label: 'Bot responde' });
  assert.deepEqual(responder('human', 'me', 'Laura Rojas', 'me'), { kind: 'you', label: 'Tú respondes' });
  assert.deepEqual(responder('human', 'u2', 'Diego Ruiz', 'me'), { kind: 'other', label: 'Diego responde' });
  assert.deepEqual(responder('human', 'u2', 'Laura Rojas', 'me'), { kind: 'other', label: 'Laura responde' }, 'same name, different person');
  assert.deepEqual(responder('human', null, null, 'me'), { kind: 'other', label: 'Otra persona responde' });
});

test('the 24 h window: open with hours left, closed with its age, never opened', () => {
  const lastAt = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString();
  assert.deepEqual(windowState(lastAt(2), NOW), { state: 'open', hoursLeft: 22 });
  assert.deepEqual(windowChip(windowState(lastAt(2), NOW)), { open: true, label: 'Ventana abierta · quedan 22 h' });
  assert.deepEqual(windowState(lastAt(23.5), NOW), { state: 'open', hoursLeft: 1 }, 'never "quedan 0 h"');
  const closed = windowState(lastAt(24 + 72), NOW);
  assert.equal(closed.state, 'closed');
  assert.deepEqual(windowChip(closed), { open: false, label: 'Ventana de 24 h vencida' });
  assert.equal(windowClosedLine(closed), 'La ventana de 24 h se cerró hace 3 d. WhatsApp solo permite enviar una plantilla aprobada.');
  assert.deepEqual(windowState(null, NOW), { state: 'never' });
  assert.equal(windowChip(windowState(null, NOW)), null);
  assert.match(windowClosedLine(windowState(null, NOW)) ?? '', /después de que la persona te escriba primero/);
  assert.equal(windowClosedLine(windowState(lastAt(1), NOW)), null, 'open → the composer is available');
});

type V = Parameters<typeof matchesSearch>[0] & { mode: 'bot' | 'pending' | 'human'; lastMessageAt: string | null; createdAt: string; id: string; pendingSince: string | null };
const view = (over: Partial<V>): V => ({
  id: 'x',
  contactName: null,
  conversationRef: '573105550187',
  lastMessageText: null,
  workflowName: 'Gallery · Visto y escribiendo',
  mode: 'bot',
  lastMessageAt: NOW.toISOString(),
  createdAt: NOW.toISOString(),
  pendingSince: null,
  ...over,
});

test('search: name (accent-insensitive), raw or displayed number, message and workflow', () => {
  const v = view({ contactName: 'Tomás Herrera', lastMessageText: '¿Me pueden abrir un cupo?' });
  assert.ok(matchesSearch(v, 'tomas'), 'the NAME was the missing field');
  assert.ok(matchesSearch(v, 'HERRERA'));
  assert.ok(matchesSearch(v, '310 555'), 'as displayed');
  assert.ok(matchesSearch(v, '5550187'), 'raw digits');
  assert.ok(matchesSearch(v, 'cupo'));
  assert.ok(matchesSearch(v, 'visto y'));
  assert.ok(matchesSearch(v, '   '), 'blank matches everything');
  assert.equal(matchesSearch(v, 'zzzz'), false);
});

test('tabs, counts (99+), preview lines and Hoy · Ayer · Anteriores', () => {
  const views = [view({ mode: 'pending' }), view({ mode: 'human' }), view({ mode: 'bot' }), view({ mode: 'bot' })];
  assert.deepEqual(tabCounts(views), { all: 4, pending: 1, human: 1, bot: 2 });
  assert.equal(inTab('pending', 'all'), true);
  assert.equal(inTab('pending', 'human'), false);
  assert.equal(capCount(99), '99');
  assert.equal(capCount(100), '99+');
  assert.equal(previewLines('pending'), 2);
  assert.equal(previewLines('human'), 1);
  const items = [
    view({ id: 'a', lastMessageAt: at(2026, 10, 15, 9).toISOString() }),
    view({ id: 'b', lastMessageAt: at(2026, 10, 14, 9).toISOString() }),
    view({ id: 'c', lastMessageAt: at(2026, 10, 1, 9).toISOString() }),
    view({ id: 'd', lastMessageAt: null, createdAt: at(2026, 10, 15, 8).toISOString() }),
  ];
  assert.deepEqual(dayBuckets(items, NOW).map((b) => [b.label, b.items.map((i) => i.id)]), [
    ['Hoy', ['a', 'd']],
    ['Ayer', ['b']],
    ['Anteriores', ['c']],
  ]);
  assert.deepEqual(INBOX_GROUP_ORDER.map((g) => g.label), ['Necesitan una persona', 'Atiende una persona', 'Atiende el bot']);
  assert.equal(groupConversations([]).length, 0);
});

test('take / return plan mirrors the server rules (nobody takes a colleague’s conversation)', () => {
  const base = { assignedUserId: null, assignedName: null, viewerUserId: 'me', viewerIsFullAccess: false };
  assert.equal(threadActionPlan({ ...base, mode: 'bot' }).primary?.kind, 'take');
  const pend = threadActionPlan({ ...base, mode: 'pending' });
  assert.equal(pend.primary?.kind, 'take');
  assert.equal(pend.secondary?.kind, 'dismiss', 'a pending one can still go back to the bot');
  const mine = threadActionPlan({ ...base, mode: 'human', assignedUserId: 'me', assignedName: 'Laura' });
  assert.deepEqual([mine.primary?.kind, mine.primary?.disabledReason], ['return', null]);
  const theirs = threadActionPlan({ ...base, mode: 'human', assignedUserId: 'u2', assignedName: 'Diego Ruiz' });
  assert.equal(theirs.primary?.kind, 'return');
  assert.equal(theirs.primary?.disabledReason, 'Diego está respondiendo. Solo esa persona o un administrador puede devolverla al bot.');
  const admin = threadActionPlan({ ...base, mode: 'human', assignedUserId: 'u2', assignedName: 'Diego', viewerIsFullAccess: true });
  assert.equal(admin.primary?.disabledReason, null, 'an owner/admin may return it');
  assert.equal(threadActionPlan({ ...base, mode: 'human', assignedUserId: 'u2' }).primary?.kind, 'return', 'never "take" from a colleague');
});

test('confirmation copy says the consequence in plain words', () => {
  assert.deepEqual(confirmCopy('take', 'Mariana Duarte', null, false), {
    title: '¿Tomar esta conversación?',
    body: 'El bot dejará de responder a Mariana Duarte. Escribirás tú hasta que la devuelvas al bot.',
    confirm: 'Tomar conversación',
  });
  assert.equal(confirmCopy('return', 'Andrés', 'Laura', true).body, 'El bot volverá a responder a Andrés. Tú dejarás de atenderla.');
  assert.equal(confirmCopy('return', 'Camila', 'Diego Ruiz', false).body, 'El bot volverá a responder a Camila. Diego dejará de atenderla.');
  assert.match(confirmCopy('dismiss', 'Tomás', null, false).body, /saldrá de «Necesitan una persona»/);
});

test('ficha form rules: empty, too long and repeated tag — the server limits', () => {
  assert.equal(validateTaskTitle('  '), 'Escribe el título de la tarea.');
  assert.equal(validateTaskTitle('x'.repeat(301)), 'Máximo 300 caracteres.');
  assert.equal(validateTaskTitle('Confirmar horario'), null);
  assert.equal(validateNoteBody(''), 'Escribe la nota.');
  assert.equal(validateNoteBody('Prefiere la mañana'), null);
  assert.equal(validateTagName('', []), 'Escribe el nombre de la etiqueta.');
  assert.equal(validateTagName('x'.repeat(TAG_NAME_MAX + 1), []), `Máximo ${TAG_NAME_MAX} caracteres.`);
  assert.equal(validateTagName(' cliente FRECUENTE ', ['Cliente frecuente']), 'Esa etiqueta ya existe.');
  assert.equal(validateTagName('Clíente frecuente', ['Cliente frecuente']), 'Esa etiqueta ya existe.', 'accent-insensitive');
  assert.equal(validateTagName('VIP', ['Cliente frecuente']), null);
});

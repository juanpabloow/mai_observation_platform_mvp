import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { displayContactName } from '../../web/lib/contactName.js';
import { normalizeWhatsappUsername } from '../../src/db/repositories/contacts.js';

/** JP-3 — the display fallback chain and the username normalizer. */

test('displayContactName: real name → @username → masked phone → "Sin nombre"', () => {
  // A real stored name always wins.
  assert.equal(displayContactName({ name: 'Nando', whatsappUsername: 'nanditho.66', phoneE164: '+573120000220' }), 'Nando');
  // Junk name → the WhatsApp handle.
  assert.equal(displayContactName({ name: '.', whatsappUsername: 'nanditho.66', phoneE164: '+573120000220' }), '@nanditho.66');
  assert.equal(displayContactName({ name: null, whatsappUsername: 'nanditho.66' }), '@nanditho.66');
  // No name, no handle → masked phone.
  assert.equal(displayContactName({ name: '  ', whatsappUsername: null, phoneE164: '+573120000220' }), '+57 312 ••• 0220');
  // Nothing at all → neutral.
  assert.equal(displayContactName({ name: null, whatsappUsername: null, phoneE164: null, channelUserId: null }), 'Sin nombre');
});

test('normalizeWhatsappUsername: strips "@", trims, rejects empty / sentinel / too long', () => {
  assert.equal(normalizeWhatsappUsername('@nanditho.66'), 'nanditho.66');
  assert.equal(normalizeWhatsappUsername('  @nando '), 'nando'); // leading @ stripped, trimmed
  assert.equal(normalizeWhatsappUsername('nando'), 'nando');
  assert.equal(normalizeWhatsappUsername(''), null);
  assert.equal(normalizeWhatsappUsername('   '), null);
  assert.equal(normalizeWhatsappUsername('@'), null);
  assert.equal(normalizeWhatsappUsername(null), null);
  assert.equal(normalizeWhatsappUsername('undefined'), null, 'a sentinel is never stored');
  assert.equal(normalizeWhatsappUsername('a'.repeat(65)), null, 'over the 64-char cap');
  assert.equal(normalizeWhatsappUsername('a'.repeat(64)), 'a'.repeat(64), 'exactly 64 is allowed');
});

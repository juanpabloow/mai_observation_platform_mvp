import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { displayContactName, isMeaningfulName, maskPhone } from '../../web/lib/contactName.js';

test('isMeaningfulName: letters/numbers/emoji are names; punctuation/whitespace are not', () => {
  assert.equal(isMeaningfulName('José'), true);
  assert.equal(isMeaningfulName('#1'), true); // has a number
  assert.equal(isMeaningfulName('😀'), true); // emoji-only stays a name
  assert.equal(isMeaningfulName('🇨🇴'), true); // flag (regional indicators)
  assert.equal(isMeaningfulName('.'), false);
  assert.equal(isMeaningfulName('...'), false);
  assert.equal(isMeaningfulName('!!'), false);
  assert.equal(isMeaningfulName('—'), false);
  assert.equal(isMeaningfulName('   '), false);
  assert.equal(isMeaningfulName(''), false);
  assert.equal(isMeaningfulName(null), false);
  assert.equal(isMeaningfulName(undefined), false);
});

test('maskPhone: masks the middle, keeps a hint and the last four', () => {
  assert.equal(maskPhone('+573120000220'), '+57 312 ••• 0220');
  assert.equal(maskPhone('573120000220'), '+57 312 ••• 0220'); // bare digits, same result
  assert.equal(maskPhone('+57 312 000 0220'), '+57 312 ••• 0220'); // punctuation stripped
  assert.equal(maskPhone('123456'), null); // too short to mask
  assert.equal(maskPhone('wa:abc'), null); // not a phone
  assert.equal(maskPhone(''), null);
  assert.equal(maskPhone(null), null);
});

test('displayContactName: real name → masked phone → "Sin nombre"', () => {
  assert.equal(displayContactName({ name: 'José' }), 'José');
  assert.equal(displayContactName({ name: '  Ana  ' }), 'Ana'); // trimmed, untouched
  assert.equal(displayContactName({ name: '😀' }), '😀'); // emoji name kept
  // junk name falls back to the masked phone (phone_e164 preferred)
  assert.equal(displayContactName({ name: '.', phoneE164: '+573120000220' }), '+57 312 ••• 0220');
  // no phone_e164 → fall back to the channel id if it is phone-like
  assert.equal(displayContactName({ name: '.', channelUserId: '573120000220' }), '+57 312 ••• 0220');
  // phone_e164 wins over channel id
  assert.equal(displayContactName({ name: '', phoneE164: '+573120000220', channelUserId: '999' }), '+57 312 ••• 0220');
  // nothing usable → neutral fallback
  assert.equal(displayContactName({ name: '   ' }), 'Sin nombre');
  assert.equal(displayContactName({ name: '.', channelUserId: 'wa:abc123' }), 'Sin nombre');
});

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bioLead, checkPublicBio, checkPublicTitle, PUBLIC_BIO_MAX, publicProfileMessage } from '../../web/lib/staffPublicProfile.js';

/**
 * The professional's PUBLIC profile (booking page): length and CONTENT rules, the same
 * for the Team editor, the server action and the DB CHECKs (migration 1800).
 */

const FEDERICO =
  'Barbero profesional enfocado en encontrar un estilo que refleje tu personalidad. Cuida cada detalle con técnica, precisión y dedicación, buscando una experiencia cómoda y cercana.';
const FALLA =
  'Barbero profesional con trayectoria en el cuidado masculino. Su enfoque combina precisión, limpieza en cada trazo y respeto por el estilo personal de cada cliente, para resaltar su imagen y presencia.';

test('the approved Gallery presentations are valid as they are', () => {
  for (const bio of [FEDERICO, FALLA]) assert.deepEqual(checkPublicBio(bio), { ok: true, value: bio });
  assert.deepEqual(checkPublicTitle('Barbero profesional'), { ok: true, value: 'Barbero profesional' });
});

test('blank is "not published"; whitespace is normalised; paragraphs survive', () => {
  assert.deepEqual(checkPublicBio('   '), { ok: true, value: null });
  assert.deepEqual(checkPublicBio(null), { ok: true, value: null });
  assert.deepEqual(checkPublicBio('  Uno   dos.\r\n\r\n\r\n\r\nTres.  '), { ok: true, value: 'Uno dos.\n\nTres.' });
  assert.deepEqual(checkPublicTitle('Barbero\nprofesional'), { ok: true, value: 'Barbero profesional' }, 'a title is one line');
});

test('length limits', () => {
  assert.equal(checkPublicBio('a'.repeat(PUBLIC_BIO_MAX)).ok, true);
  const long = checkPublicBio('a'.repeat(PUBLIC_BIO_MAX + 1));
  assert.deepEqual(long, { ok: false, error: 'too_long', max: PUBLIC_BIO_MAX });
  assert.equal(checkPublicTitle('t'.repeat(61)).ok, false);
});

test('no links, e-mails or phone numbers on a public page; no control characters', () => {
  for (const bad of [
    'Escríbeme por https://wa.me/573001112233',
    'Mira mi trabajo en www.ejemplo.com',
    'Agenda en ejemplo.co/reserva',
    'Correo: federico@gmail.com',
    'Llámame al 300 123 4567',
    'Tel. +57 (300) 123-45-67',
  ]) {
    const r = checkPublicBio(bad);
    assert.equal(r.ok, false, bad);
    if (!r.ok) assert.equal(r.error, 'contact_or_link', bad);
  }
  const ctl = checkPublicBio('Hola\u0007mundo');
  assert.equal(ctl.ok, false);
  // Numbers in normal prose are fine ("10 años", "2x1").
  assert.equal(checkPublicBio('Más de 10 años de experiencia y 2 sedes.').ok, true);
});

test('messages in Spanish for the phone editor, English for the desktop panel', () => {
  assert.match(publicProfileMessage('contact_or_link', 'Presentación', 600, 'es'), /no incluyas enlaces, correos ni teléfonos/);
  assert.match(publicProfileMessage('too_long', 'Presentation', 600, 'en'), /at most 600/);
});

test('the artist card shows the first sentence', () => {
  assert.equal(bioLead(FEDERICO), 'Barbero profesional enfocado en encontrar un estilo que refleje tu personalidad.');
  assert.equal(bioLead('Sin punto final'), 'Sin punto final');
  assert.equal(bioLead(null), null);
});

test('the bios live in the editable profile, never hard-coded in the booking components', () => {
  const dir = fileURLToPath(new URL('../../web/components/booking/', import.meta.url));
  for (const f of ['BookingFlow.tsx', 'ArtistStep.tsx', 'ArtistProfile.tsx', 'ui.tsx']) {
    const src = readFileSync(dir + f, 'utf8');
    assert.ok(!src.includes('Barbero profesional enfocado') && !src.includes('trayectoria en el cuidado masculino'), f);
    assert.ok(!/Federico|Falla/.test(src), `${f} names no Gallery professional`);
  }
});

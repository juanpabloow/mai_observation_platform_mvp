import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  artistInitials,
  contactErrors,
  dayStatusOf,
  fullPhone,
  groupSlots,
  isSelectableDay,
  lastBookableDay,
  needsMore,
  onArtistChange,
  onServiceChange,
  priceShown,
  priceText,
  reachableStep,
  reconcileArtist,
  STEP_TITLES,
  type Selection,
} from '../../web/lib/publicBookingFlow.js';

/**
 * The PUBLIC booking flow's decisions (v3, four steps), apart from the UI. The engine
 * still decides availability and the server the price; these only decide what to show
 * and what a change invalidates.
 */

const TZ = 'America/Bogota';

test('four steps; each needs the previous choices', () => {
  assert.deepEqual(Object.values(STEP_TITLES), ['Elige tu experiencia', 'Elige a tu artista', 'Elige fecha y hora', 'Tus datos']);
  assert.equal(reachableStep({ serviceId: null, artist: null, slotStart: null }), 1);
  assert.equal(reachableStep({ serviceId: 's', artist: null, slotStart: null }), 2);
  assert.equal(reachableStep({ serviceId: 's', artist: 'any', slotStart: null }), 3);
  assert.equal(reachableStep({ serviceId: 's', artist: 'a1', slotStart: '2026-10-14T15:00:00.000Z' }), 4);
});

test('calendar: today, past, beyond the horizon, closed, loading, open, full, unknown', () => {
  const today = '2026-10-13';
  const lastDay = lastBookableDay(today, 30);
  assert.equal(lastDay, '2026-11-12');
  const base = { today, lastDay, closedWeekdays: new Set(['sun']), load: 'loaded' as const, openDays: new Set(['2026-10-13', '2026-10-14']) };
  assert.equal(dayStatusOf('2026-10-12', base), 'past');
  assert.equal(dayStatusOf('2026-11-13', base), 'out');
  assert.equal(dayStatusOf('2026-10-18', base), 'closed', 'a Sunday');
  assert.equal(dayStatusOf('2026-10-14', base), 'open');
  assert.equal(dayStatusOf('2026-10-15', base), 'full');
  assert.equal(dayStatusOf('2026-10-15', { ...base, load: 'loading' }), 'loading');
  assert.equal(dayStatusOf('2026-10-15', { ...base, load: 'error' }), 'unknown');
  assert.equal(isSelectableDay('past'), false);
  assert.equal(isSelectableDay('out'), false);
  for (const s of ['closed', 'full', 'open', 'loading', 'unknown'] as const) assert.equal(isSelectableDay(s), true, s);
});

test('times are grouped by the SITE clock (24 h), morning before 12:00', () => {
  const slots = ['2026-10-14T14:00:00.000Z', '2026-10-14T16:45:00.000Z', '2026-10-14T17:00:00.000Z', '2026-10-14T22:30:00.000Z'].map((start_at) => ({ start_at }));
  // 09:00, 11:45 → Mañana; 12:00, 17:30 → Tarde (Bogotá = UTC−5)
  const g = groupSlots(slots, TZ);
  assert.deepEqual(g.map((x) => [x.name, x.items.length]), [['Mañana', 2], ['Tarde', 2]]);
  assert.deepEqual(groupSlots(slots.slice(2), TZ).map((x) => x.name), ['Tarde'], 'an empty group is dropped');
});

test('changing service or artist drops ONLY the time (and says so); the rest survives', () => {
  const sel: Selection = { serviceId: 's1', artist: 'a1', day: '2026-10-14', slotStart: '2026-10-14T15:00:00.000Z' };
  const svc = onServiceChange(sel, 's2');
  assert.deepEqual(svc.sel, { serviceId: 's2', artist: 'a1', day: '2026-10-14', slotStart: null });
  assert.equal(svc.cleared, 'svc');
  assert.equal(onServiceChange(sel, 's1').cleared, null, 'same service: nothing cleared');
  assert.equal(onServiceChange({ ...sel, slotStart: null }, 's2').cleared, null, 'no time chosen: no notice');

  const art = onArtistChange(sel, 'any');
  assert.deepEqual(art.sel, { serviceId: 's1', artist: 'any', day: '2026-10-14', slotStart: null });
  assert.equal(art.cleared, 'art');
});

test('an artist who does not perform the new service is dropped; "Sin preferencia" never is', () => {
  const sel: Selection = { serviceId: 's2', artist: 'falla', day: '2026-10-14', slotStart: null };
  assert.deepEqual(reconcileArtist(sel, ['federico']), { sel: { ...sel, artist: null }, dropped: true });
  assert.equal(reconcileArtist(sel, ['federico', 'falla']).dropped, false);
  assert.equal(reconcileArtist({ ...sel, artist: 'any' }, []).dropped, false);
});

test('contact form: Spanish messages, Colombian mobile rule, optional e-mail, consent', () => {
  const ok = { name: 'Andrés Gómez', cc: '+57', phone: '300 123 4567', email: '', consent: true };
  assert.deepEqual(contactErrors(ok, 'Gallery-93'), { name: '', phone: '', email: '', consent: '' });
  const bad = contactErrors({ name: 'A', cc: '+57', phone: '300 12', email: 'andres@', consent: false }, 'Gallery-93');
  assert.equal(bad.name, 'Escribe tu nombre para que Gallery-93 sepa a quién espera.');
  assert.match(bad.phone, /10 dígitos y empieza por 3/);
  assert.match(bad.email, /nombre@correo\.com/);
  assert.match(bad.consent, /acepta/);
  assert.match(contactErrors({ ...ok, phone: '601 234 5678' }, 'X').phone, /empieza por 3/, 'a landline is not a mobile');
  assert.equal(contactErrors({ ...ok, cc: '+34', phone: '612 345 678' }, 'X').phone, '');
  assert.equal(contactErrors({ ...ok, phone: '+1 415 555 0101' }, 'X').phone, '', 'typed international number');
  assert.equal(fullPhone({ cc: '+57', phone: '300 123 4567' }), '+57 3001234567');
  assert.equal(fullPhone({ cc: '+57', phone: '+1 415 555 0101' }), '+1 415 555 0101');
});

test('price shown: the artist\'s own price; "Desde" for Sin preferencia when artists differ', () => {
  const staff = [
    { id: 'a', price: '60000.00' },
    { id: 'b', price: '70000.00' },
  ];
  assert.equal(priceText(priceShown({ servicePrice: '60000.00', artist: 'b', staff }), true), '$70.000 COP');
  assert.equal(priceText(priceShown({ servicePrice: '60000.00', artist: 'any', staff }), true), 'Desde $60.000 COP');
  assert.equal(priceText(priceShown({ servicePrice: '60000.00', artist: null, staff: [] })), '$60.000');
  assert.equal(priceText(priceShown({ servicePrice: null, artist: null, staff: [] })), 'Precio a consultar');
});

test('artist initials and the "Ver más" threshold', () => {
  assert.equal(artistInitials('Federico'), 'Fe');
  assert.equal(artistInitials('Falla'), 'Fa');
  assert.equal(artistInitials('Ana Ruiz'), 'AR');
  assert.equal(needsMore('Corte a tu medida con acabado final.'), false);
  assert.equal(needsMore('x'.repeat(91)), true);
  assert.equal(needsMore('Línea uno\nLínea dos'), true);
  assert.equal(needsMore(null), false);
});

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { originColumnChip, originColumnDetail } from '../../web/lib/originDisplay.js';

test('originColumnChip: the 5 list chips; only Anuncio carries the accent token', () => {
  assert.deepEqual(originColumnChip('meta_ad'), { label: 'Anuncio', tone: 'bg-accent/10 text-accent' });
  assert.equal(originColumnChip('meta_post').label, 'Anuncio');
  assert.equal(originColumnChip('organic_whatsapp').label, 'Orgánico');
  assert.equal(originColumnChip('booked_by_contact').label, 'Orgánico');
  assert.equal(originColumnChip('booking_page').label, 'Página de reservas');
  assert.equal(originColumnChip('manual').label, 'Asignado manualmente');
  assert.equal(originColumnChip('import').label, 'Desconocido');
  assert.equal(originColumnChip('unknown').label, 'Desconocido');
  assert.equal(originColumnChip(null).label, 'Desconocido');
  for (const k of ['organic_whatsapp', 'booking_page', 'booked_by_contact', 'manual', 'import', 'unknown', null] as const) {
    assert.equal(originColumnChip(k).tone, 'bg-chip text-muted', `${k ?? 'null'} is neutral, not accent`);
  }
});

test('originColumnDetail: the quiet second line per origin_kind', () => {
  assert.equal(originColumnDetail({ originKind: 'meta_ad', adName: 'Factos', adHeadline: 'H', adIsTest: false, campaignName: 'Camp' }), 'Factos · Camp');
  assert.equal(originColumnDetail({ originKind: 'meta_ad', adName: null, adHeadline: 'Headline', adIsTest: false, campaignName: null }), 'Headline', 'ad name falls back to headline');
  assert.equal(originColumnDetail({ originKind: 'meta_ad', adName: 'X', adHeadline: 'H', adIsTest: true, campaignName: 'Camp' }), 'Anuncio de prueba', 'a test ad wins the line');
  assert.equal(originColumnDetail({ originKind: 'organic_whatsapp', adName: null, adHeadline: null, adIsTest: null, campaignName: null }), 'WhatsApp');
  assert.equal(originColumnDetail({ originKind: 'booked_by_contact', adName: null, adHeadline: null, adIsTest: null, campaignName: null }), 'Reservado por otra persona');
  assert.equal(originColumnDetail({ originKind: 'manual', adName: null, adHeadline: null, adIsTest: null, campaignName: 'Camp' }), 'Camp');
  assert.equal(originColumnDetail({ originKind: 'manual', adName: null, adHeadline: null, adIsTest: null, campaignName: null }), null);
  assert.equal(originColumnDetail({ originKind: 'booking_page', adName: null, adHeadline: null, adIsTest: null, campaignName: null }), null);
  assert.equal(originColumnDetail({ originKind: null, adName: null, adHeadline: null, adIsTest: null, campaignName: null }), null);
});

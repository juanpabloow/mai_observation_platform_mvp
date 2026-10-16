import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  checkCategoryInput,
  checkIncludes,
  directionsUrl,
  featuredMissing,
  hoursLines,
  pageSections,
  safeMapsUrl,
  upgradeOffer,
  whatsappLink,
  type PageCategory,
  type PageService,
} from '../../web/lib/bookingPage.js';
import { expectedPriceOf } from '../../web/lib/publicBookingFlow.js';

/** Booking page presentation (migration 1804): the pure rules the page, the projection
 *  and the admin preview share. */

const svc = (over: Partial<PageService> & { id: string }): PageService => ({
  name: over.id,
  description: null,
  duration_min: 60,
  price: '60000.00',
  category_id: null,
  recommended: false,
  image_url: null,
  includes: [],
  upgrade_to: null,
  ...over,
});

test('WhatsApp: only a clean E.164 number becomes a wa.me link, with the first message', () => {
  assert.equal(whatsappLink('+573022275653', 'Hola Gallery, quiero reservar'), 'https://wa.me/573022275653?text=Hola%20Gallery%2C%20quiero%20reservar');
  assert.equal(whatsappLink('+573022275653', ''), 'https://wa.me/573022275653');
  for (const bad of [null, '', '3022275653', '+57 302 227 5653', '+0573022275653', 'javascript:alert(1)']) assert.equal(whatsappLink(bad, 'x'), null, String(bad));
});

test('Cómo llegar: a business Maps link only when it is https Google Maps; else a search for the address', () => {
  assert.equal(safeMapsUrl('https://maps.app.goo.gl/AbC123'), 'https://maps.app.goo.gl/AbC123');
  assert.ok(safeMapsUrl('https://www.google.com/maps/place/Gallery'));
  for (const bad of ['http://maps.app.goo.gl/x', 'https://evil.example/maps', 'https://www.google.com/search?q=x', 'https://goo.gl/abc', 'notaurl']) assert.equal(safeMapsUrl(bad), null, bad);
  assert.equal(
    directionsUrl({ name: 'Gallery', address: 'Calle 77 #13-19, Bogotá', public_maps_url: null }),
    'https://www.google.com/maps/search/?api=1&query=Gallery%2C%20Calle%2077%20%2313-19%2C%20Bogot%C3%A1',
  );
  assert.equal(directionsUrl({ name: 'Gallery', address: 'Calle 77', public_maps_url: 'https://evil.example' })?.startsWith('https://www.google.com/maps/search/'), true, 'a bad link falls back to the search');
  assert.equal(directionsUrl({ name: 'Gallery', address: null }), null);
});

test('hours: consecutive days with the same hours merge; nothing configured says nothing', () => {
  const r = { start: '10:00', end: '20:00' };
  assert.deepEqual(hoursLines({ mon: [r], tue: [r], wed: [r], thu: [r], fri: [r], sat: [r] }), [
    { days: 'Lunes a sábado', hours: '10:00–20:00' },
    { days: 'Domingo', hours: 'Cerrado' },
  ]);
  assert.deepEqual(hoursLines({ mon: [r], tue: [r], sat: [{ start: '09:00', end: '14:00' }] }), [
    { days: 'Lunes y martes', hours: '10:00–20:00' },
    { days: 'Miércoles a viernes', hours: 'Cerrado' },
    { days: 'Sábado', hours: '09:00–14:00' },
    { days: 'Domingo', hours: 'Cerrado' },
  ]);
  assert.deepEqual(hoursLines({}), []);
  assert.deepEqual(hoursLines(null), []);
});

test('sections: business order; featured keeps only COMPLETE services; contact groups are links only with a WhatsApp', () => {
  const cats: PageCategory[] = [
    { id: 'nubes', name: 'Entre Nubes', tagline: 'Una experiencia inolvidable', layout: 'featured' },
    { id: 'sig', name: 'Signature', tagline: 'El ritual completo', layout: 'list' },
    { id: 'ese', name: 'Esencial', tagline: 'Impecable y a tiempo', layout: 'list' },
    { id: 'color', name: 'Color', tagline: '¿Buscas color?', layout: 'contact' },
  ];
  const incomplete = svc({ id: 'nubes-1', category_id: 'nubes', description: 'x', includes: ['a'] }); // no image
  const services = [incomplete, svc({ id: 'corte', category_id: 'ese' }), svc({ id: 'cs', category_id: 'sig' }), svc({ id: 'loose' }), svc({ id: 'foreign', category_id: 'other-client' })];
  const page = pageSections(services, cats, { hasWhatsapp: true });
  assert.ok(page);
  assert.deepEqual(page.sections.map((s) => s.key), ['sig', 'ese', 'other'], 'an incomplete experience is NOT offered; empty groups are dropped');
  assert.deepEqual(page.sections.at(-1)?.items.map((s) => s.id), ['loose', 'foreign'], 'ungrouped (or a foreign group) → Otros servicios');
  assert.deepEqual(page.contacts.map((c) => c.id), ['color']);
  assert.deepEqual(pageSections(services, cats, { hasWhatsapp: false })?.contacts, [], 'no WhatsApp → no dead link');

  const complete = { ...incomplete, image_url: 'https://cdn.example/n.jpg' };
  assert.deepEqual(pageSections([complete], cats, { hasWhatsapp: false })?.sections.map((s) => [s.key, s.layout]), [['nubes', 'featured']]);
  assert.equal(pageSections(services, [], { hasWhatsapp: true }), null, 'no categories → the previous grouping, unchanged');
});

test('featured card: lists exactly what is missing', () => {
  assert.deepEqual(featuredMissing({ image_url: null, description: ' ', includes: [], price: null, duration_min: 60 }), ['imagen', 'descripción', 'qué incluye', 'precio']);
  assert.deepEqual(featuredMissing({ image_url: 'https://x/y.jpg', description: 'd', includes: ['a'], price: '0.00', duration_min: 30 }), []);
});

test('upgrade: the REAL difference — $40.000 and $50.000, never a made-up or negative amount', () => {
  const all = [
    svc({ id: 'corte', price: '60000.00', upgrade_to: 'corte-sig' }),
    svc({ id: 'corte-sig', price: '100000.00' }),
    svc({ id: 'cb', price: '100000.00', upgrade_to: 'cb-sig' }),
    svc({ id: 'cb-sig', price: '150000.00' }),
    svc({ id: 'cheaper', price: '150000.00', upgrade_to: 'corte' }),
    svc({ id: 'unpriced', price: null, upgrade_to: 'cb-sig' }),
    svc({ id: 'gone', price: '1.00', upgrade_to: 'not-on-page' }),
  ];
  const by = (id: string) => all.find((s) => s.id === id)!;
  assert.equal(upgradeOffer(by('corte'), all)?.delta, 40000);
  assert.equal(upgradeOffer(by('cb'), all)?.delta, 50000);
  assert.equal(upgradeOffer(by('cb'), all)?.target.id, 'cb-sig');
  for (const id of ['cheaper', 'unpriced', 'gone', 'cb-sig']) assert.equal(upgradeOffer(by(id), all), null, id);
});

test('admin validation: category and "Qué incluye" follow the public text rules', () => {
  assert.equal(checkCategoryInput({ name: 'Signature', tagline: 'El ritual completo', layout: 'list', sortOrder: '1', visible: true }).ok, true);
  assert.equal(checkCategoryInput({ name: ' ', tagline: '', layout: 'list', sortOrder: 0, visible: true }).ok, false);
  assert.equal(checkCategoryInput({ name: 'Color', tagline: '', layout: 'contact', sortOrder: 0, visible: true }).ok, false, 'a WhatsApp group needs its link text');
  assert.equal(checkCategoryInput({ name: 'X', tagline: 'Escríbenos al 3001234567', layout: 'list', sortOrder: 0, visible: true }).ok, false, 'no phones in public text');
  assert.equal(checkCategoryInput({ name: 'X', tagline: '', layout: 'carousel', sortOrder: 0, visible: true }).ok, false);
  assert.deepEqual(checkIncludes('- Lavado\n• Masaje capilar\n\nToallas calientes'), { ok: true, value: ['Lavado', 'Masaje capilar', 'Toallas calientes'] });
  assert.deepEqual(checkIncludes('  '), { ok: true, value: null });
  assert.equal(checkIncludes(Array.from({ length: 9 }, (_, i) => `p${i}`).join('\n')).ok, false);
  assert.equal(checkIncludes('Visita www.ejemplo.com').ok, false);
});

test('price guard: the page sends only an EXACT shown price; a range or unknown sends nothing', () => {
  const staff = [
    { id: 'a', price: '100000.00' },
    { id: 'b', price: '100000' },
  ];
  assert.equal(expectedPriceOf({ artist: 'a', staff }), '100000.00');
  assert.equal(expectedPriceOf({ artist: 'any', staff }), '100000.00', 'every artist shares the price');
  assert.equal(expectedPriceOf({ artist: 'any', staff: [...staff, { id: 'c', price: '120000.00' }] }), undefined, '"Desde …" is not compared');
  assert.equal(expectedPriceOf({ artist: 'any', staff: [] }), undefined);
  assert.equal(expectedPriceOf({ artist: 'a', staff: [{ id: 'a', price: null }] }), null, 'precio a consultar is compared as null');
});

// ── Source-level contract (wiring a render test cannot reach cheaply) ─────────────

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

test('the page never shows "Sin reseñas aún" and every rating opens its own reviews', () => {
  for (const f of ['ServiceStep.tsx', 'ArtistStep.tsx', 'BookingFlow.tsx', 'ArtistProfile.tsx']) {
    assert.equal(read(`web/components/booking/${f}`).includes('Sin reseñas aún'), false, f);
  }
  const flow = read('web/components/booking/BookingFlow.tsx');
  for (const scope of ['Todas las reseñas de la sede.', 'Solo reseñas de este servicio.', 'Solo reseñas de este artista.']) assert.ok(flow.includes(scope), scope);
});

test('page visibility is ONE predicate, applied to the list, the staff, the availability guard and the POST', () => {
  const cat = read('src/db/repositories/scheduling/publicCatalog.ts');
  assert.equal((cat.match(/\$\{publicServicePredicate\(/g) ?? []).length, 4, 'list, staff list, staff service_ids, isPublicServiceAtSite');
  const post = read('web/app/api/booking/[slug]/route.ts');
  assert.ok(post.indexOf('isPublicServiceAtSite(') > 0 && post.indexOf('isPublicServiceAtSite(') < post.indexOf('createAppointment({'), 'checked before the engine');
  const svc = read('src/db/repositories/scheduling/services.ts');
  assert.equal(/public_visible/.test(svc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').split('export interface ServiceRow')[0]), false, 'the agenda/bot queries never filter by page visibility');
});

test('motion: short, transform/opacity, and off under prefers-reduced-motion', () => {
  const css = read('web/app/globals.css');
  const block = css.slice(css.indexOf('Public booking: motion'), css.indexOf('SCHEDULING design system'));
  assert.ok(block.includes('@media (prefers-reduced-motion: reduce)'));
  for (const d of block.matchAll(/(\d?\.\d+)s/g)) assert.ok(Number(d[1]) <= 1.2, `duration ${d[1]}s`);
  // Keyframes move only transform / opacity (and the check's stroke), never layout.
  const frames = [...block.matchAll(/@keyframes [\w-]+ \{([\s\S]*?)\n\}/g)].map((m) => m[1]).join('\n');
  assert.ok(frames.length > 0);
  assert.equal(/\b(width|height|top|left|right|bottom|margin|padding)\s*:/.test(frames), false);
});

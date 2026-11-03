import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { arrangePublicReviews, FEATURED_REVIEWS, PUBLIC_REVIEWS_SENT } from '../../web/lib/publicReviews.js';
import { mapEmbedUrl } from '../../web/lib/bookingPage.js';

/**
 * The public review list (product, 3 Nov 2026): comments first, a few 3–4★ mixed into
 * the featured ones, 1–2★ never featured but never dropped, star-only last.
 */

type R = { id: string; rating: number; comment: string | null; submitted_at: string };
let day = 0;
/** Newest first as declared: each call is one day older than the previous one. */
const rv = (id: string, rating: number, comment: string | null = `texto ${id}`): R => ({
  id,
  rating,
  comment,
  submitted_at: new Date(Date.UTC(2026, 10, 1) - day++ * 86_400_000).toISOString(),
});
const ids = (list: R[]) => list.map((r) => r.id);
const root = (p: string) => readFileSync(fileURLToPath(new URL(`../../${p}`, import.meta.url)), 'utf8');

test('comments first, then star-only; newest first inside each group', () => {
  day = 0;
  const list = [rv('s1', 5, null), rv('c1', 5), rv('s2', 4, null), rv('c2', 5), rv('blank', 5, '   ')];
  assert.deepEqual(ids(arrangePublicReviews(list)), ['c1', 'c2', 's1', 's2', 'blank'], 'a blank comment counts as no comment');
});

test('3–4★ ones take the 2nd and 4th places among the featured; the rest are the newest 5★', () => {
  day = 0;
  const list = [rv('a5', 5), rv('b5', 5), rv('c5', 5), rv('d4', 4), rv('e5', 5), rv('f3', 3), rv('g5', 5), rv('h4', 4), rv('i5', 5)];
  const out = ids(arrangePublicReviews(list));
  assert.deepEqual(out.slice(0, FEATURED_REVIEWS), ['a5', 'd4', 'b5', 'f3', 'c5', 'e5']);
  assert.deepEqual(out.slice(FEATURED_REVIEWS), ['g5', 'h4', 'i5'], 'the other commented ones follow, by date');
});

test('1–2★ are never featured, but stay in the list', () => {
  day = 0;
  const list = [rv('x1', 1), rv('a5', 5), rv('y2', 2), rv('b5', 5)];
  const out = ids(arrangePublicReviews(list));
  assert.deepEqual(out, ['a5', 'b5', 'x1', 'y2']);
});

test('nothing is invented: only 5★ stays only 5★; few 5★ are filled with 3–4★', () => {
  day = 0;
  assert.deepEqual(ids(arrangePublicReviews([rv('a', 5), rv('b', 5), rv('c', 5)])), ['a', 'b', 'c']);
  day = 0;
  assert.deepEqual(ids(arrangePublicReviews([rv('m1', 4), rv('t1', 5), rv('m2', 3), rv('m3', 4)])), ['t1', 'm1', 'm2', 'm3']);
  assert.deepEqual(arrangePublicReviews([]), []);
});

test('input order does not matter, and the input is not mutated', () => {
  day = 0;
  const list = [rv('a5', 5), rv('b4', 4), rv('c5', 5), rv('d5', 5, null)];
  const shuffled = [list[3], list[1], list[0], list[2]];
  const copy = [...shuffled];
  assert.deepEqual(ids(arrangePublicReviews(shuffled)), ids(arrangePublicReviews(list)));
  assert.deepEqual(shuffled, copy);
});

test('every public list goes through the same order and cap', () => {
  const api = root('web/lib/publicBookingApi.ts');
  assert.match(api, /arrangePublicReviews\(rows\)\.slice\(0, PUBLIC_REVIEWS_SENT\)\.map\(projectPublicReview\)/);
  assert.equal((api.match(/publicReviewList\(/g) ?? []).length, 3, 'definition + services + staff');
  assert.match(root('web/app/book/[siteSlug]/page.tsx'), /siteReviews=\{publicReviewList\(siteReviews\)\}/, 'the business list too');
  assert.ok(PUBLIC_REVIEWS_SENT >= FEATURED_REVIEWS);
  const repo = root('src/db/repositories/scheduling/reviews.ts');
  for (const fn of ['publicStaffReviews', 'publicSiteReviews', 'publicServiceReviews']) {
    assert.match(repo, new RegExp(`export async function ${fn}\\([^)]*limit = PUBLIC_REVIEW_POOL\\)`), `${fn} reads the pool`);
  }
  assert.match(repo, /count\(\*\) FILTER \(WHERE rating = 1\)::int AS s1/, 'the bars count every approved review');
  const flow = root('web/components/booking/BookingFlow.tsx');
  assert.doesNotMatch(flow, /reviews \?\? \[\]\)\.slice\(0, 3\)/, 'the dialog gets the whole page-ordered list');
});

test('the map follows the address; no address, no map', () => {
  // The /maps/embed form (the short ?output=embed one redirects with X-Frame-Options and stays blank).
  assert.equal(mapEmbedUrl('Calle 77A #13-19, Bogotá'), 'https://www.google.com/maps/embed?origin=mfe&pb=!1m3!2m1!1sCalle%2077A%20%2313-19%2C%20Bogot%C3%A1!6i16');
  assert.equal(mapEmbedUrl('Local 2! Bogotá'), 'https://www.google.com/maps/embed?origin=mfe&pb=!1m3!2m1!1sLocal%202%21%20Bogot%C3%A1!6i16', '"!" separates pb fields');
  assert.equal(mapEmbedUrl('  '), null);
  assert.equal(mapEmbedUrl(null), null);
  const info = root('web/components/booking/BusinessInfo.tsx');
  assert.match(info, /<iframe[\s\S]*?src=\{map\}[\s\S]*?loading="lazy"[\s\S]*?tabIndex=\{-1\}/, 'lazy, out of the tab order («Cómo llegar» is the way there)');
});

test('confirmation: the full location block, WhatsApp once, green', () => {
  const done = root('web/components/booking/BookingDone.tsx');
  assert.doesNotMatch(done, /\bcompact\b/, 'the same block as step 1 (with the map)');
  assert.equal((done.match(/href=\{wa\}/g) ?? []).length, 0, 'no second WhatsApp link next to the calendar button');
  assert.match(done, /whatsappText=\{waText\}/, 'the block carries the reference in its first message');
  const info = root('web/components/booking/BusinessInfo.tsx');
  assert.match(info, /className=\{BTN_WHATSAPP\}/);
  assert.match(root('web/components/booking/ui.tsx'), /bg-pb-wa px-4 text-\[15px\] font-\[590\] text-white/);
  assert.match(root('web/app/globals.css'), /--color-pb-wa: #1a7f4b;/);
});

// ── The map's pin: the same place as «Cómo llegar» ──────────────────────────────────

test('the map query comes from the business link: exact coordinates first', async () => {
  const { mapQueryFromMapsUrl } = await import('../../web/lib/bookingPage.js');
  const place = 'https://www.google.com/maps/place/Gallery+93/@4.6636,-74.0571,17z/data=!3m1!4b1!4m6!3m5!1s0x8e3f9a:0x1!8m2!3d4.6637123!4d-74.0572456!16s%2Fg%2F11';
  assert.equal(mapQueryFromMapsUrl(place), '4.6637123,-74.0572456', 'the place pin (!3d!4d), not the camera (@)');
  assert.equal(mapQueryFromMapsUrl('https://www.google.com/maps/@4.66,-74.05,15z'), '4.66,-74.05');
  assert.equal(mapQueryFromMapsUrl('https://maps.google.com/?q=4.6,-74.0'), '4.6,-74.0');
  assert.equal(mapQueryFromMapsUrl('https://www.google.com/maps/search/?api=1&query=Gallery%2093%20Bogot%C3%A1'), 'Gallery 93 Bogotá');
  assert.equal(mapQueryFromMapsUrl('https://www.google.com/maps/place/Gallery+93,+Calle+77/'), 'Gallery 93, Calle 77');
  assert.equal(mapQueryFromMapsUrl('https://maps.app.goo.gl/AbC123'), null, 'a short link says nothing until resolved');
  assert.equal(mapQueryFromMapsUrl('https://evil.example/maps/@4.6,-74.0,15z'), null, 'Google Maps links only');
  assert.equal(mapQueryFromMapsUrl('https://www.google.com/maps/@95.1,-74.0,15z'), null, 'no impossible coordinates');
});

test('a short link is resolved once, only through Google Maps hosts; anything else falls back to name + address', async () => {
  const { publicMapQuery, clearMapsCache } = await import('../../web/lib/mapsPlace.js');
  clearMapsCache();
  const site = { name: 'Gallery-93', address: 'Calle 77A #13-19, Bogotá' };
  const calls: string[] = [];
  const redirectTo = (location: string) => async (url: string) => {
    calls.push(url);
    return new Response(null, { status: 302, headers: { location } });
  };
  const exact = 'https://www.google.com/maps/place/Gallery+93/data=!4m6!3m5!8m2!3d4.6637123!4d-74.0572456';
  assert.equal(await publicMapQuery({ ...site, public_maps_url: 'https://maps.app.goo.gl/AbC123' }, redirectTo(exact)), '4.6637123,-74.0572456');
  assert.equal(await publicMapQuery({ ...site, public_maps_url: 'https://maps.app.goo.gl/AbC123' }, redirectTo(exact)), '4.6637123,-74.0572456');
  assert.equal(calls.length, 1, 'cached per link');
  // A redirect away from Google, a network error or no link at all: the business name and address.
  assert.equal(await publicMapQuery({ ...site, public_maps_url: 'https://maps.app.goo.gl/Evil' }, redirectTo('https://evil.example/@1,2')), 'Gallery-93, Calle 77A #13-19, Bogotá');
  assert.equal(await publicMapQuery({ ...site, public_maps_url: 'https://maps.app.goo.gl/Down' }, async () => { throw new Error('offline'); }), 'Gallery-93, Calle 77A #13-19, Bogotá');
  assert.equal(await publicMapQuery({ ...site, public_maps_url: 'https://www.google.com/maps/@4.66,-74.05,15z' }, async () => { throw new Error('never called'); }), '4.66,-74.05', 'a long link needs no request');
  assert.equal(await publicMapQuery({ name: 'X', address: null }), null, 'no address, no link: no map');
  const page = root('web/app/book/[siteSlug]/page.tsx');
  assert.match(page, /publicMapQuery\(site\)/);
  assert.match(page, /map_query: mapQuery/);
  assert.match(root('web/components/booking/BusinessInfo.tsx'), /mapEmbedUrl\(mapQuery \?\? address\)/);
});

test('desktop «Lo que dicen» is the average and the bars; the confirmation is one centred column', () => {
  const hl = root('web/components/booking/ReviewsHighlights.tsx');
  const card = hl.slice(hl.indexOf('aria-labelledby="pb-said-card"'));
  assert.doesNotMatch(card, /ReviewArticle/, 'no quotes in the side card');
  assert.match(card, /<RatingBars rating=\{rating\} \/>/);
  const flow = root('web/components/booking/BookingFlow.tsx');
  assert.match(flow, /\{!confirmation \? \(\s*<div className="sticky top-7/, 'no «Tu selección» after booking');
  assert.match(flow, /confirmation \? "lg:mx-auto lg:max-w-\[760px\]" : ""/);
});

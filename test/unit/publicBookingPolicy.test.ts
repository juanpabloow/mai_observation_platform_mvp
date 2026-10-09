import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { POLICY_DEFAULTS, publicClientConfig, readPublicBookingPolicy, safeExternalUrl } from '../../web/lib/publicBookingPolicy.js';
import { TURNSTILE_SITEVERIFY_URL, verifyTurnstileToken } from '../../web/lib/turnstileVerify.js';
import {
  PUBLIC_API_HEADERS,
  projectPublicConfirmation,
  projectPublicSite,
  projectPublicSlots,
  publicEngineError,
  publicNotFound,
} from '../../web/lib/publicBookingApi.js';
import { calendarDays, monthSegments, siteMidnight, fmtTime, dayHeadline, timezoneLabel } from '../../web/lib/siteCalendar.js';
import { buildBookingIcs, icsEscape } from '../../web/lib/bookingIcs.js';
import { staffTone, initialsOf } from '../../web/lib/staffTone.js';
import { bookingLinkStatus, bookingPath, bookingUrl } from '../../web/lib/bookingLink.js';
import { hashRateKey, windowStartFor } from '../../src/db/repositories/scheduling/publicBookingRateLimit.js';

/** Pure pieces of the public booking flow — no DB, no network. */

// ── Policy ──────────────────────────────────────────────────────────────────────

test('policy defaults: 10/10min per IP, 5/h per phone, 3 active per phone, Turnstile off', () => {
  const p = readPublicBookingPolicy({});
  assert.equal(p.disabled, false);
  assert.deepEqual(p.rateLimit.ip, { limit: POLICY_DEFAULTS.ipMax, windowSec: POLICY_DEFAULTS.ipWindowSec });
  assert.deepEqual(p.rateLimit.phone, { limit: POLICY_DEFAULTS.phoneMax, windowSec: POLICY_DEFAULTS.phoneWindowSec });
  assert.equal(p.maxActivePerPhone, 3);
  assert.equal(p.turnstile.enabled, false);
  assert.equal(p.hashSecret, null, 'no secret configured → null (creation fails closed)');
});

test('policy: a typo or out-of-range value falls back to the default instead of disabling a guard', () => {
  const p = readPublicBookingPolicy({
    PUBLIC_BOOKING_RATE_LIMIT_IP_MAX: 'ten',
    PUBLIC_BOOKING_RATE_LIMIT_PHONE_MAX: '0',
    PUBLIC_BOOKING_MAX_ACTIVE_PER_PHONE: '-1',
    PUBLIC_BOOKING_RATE_LIMIT_IP_WINDOW_SECONDS: '99999999',
  });
  assert.equal(p.rateLimit.ip.limit, POLICY_DEFAULTS.ipMax);
  assert.equal(p.rateLimit.phone.limit, POLICY_DEFAULTS.phoneMax);
  assert.equal(p.maxActivePerPhone, POLICY_DEFAULTS.maxActivePerPhone);
  assert.equal(p.rateLimit.ip.windowSec, POLICY_DEFAULTS.ipWindowSec);
  const custom = readPublicBookingPolicy({ PUBLIC_BOOKING_RATE_LIMIT_IP_MAX: '25', PUBLIC_BOOKING_MAX_ACTIVE_PER_PHONE: '5' });
  assert.equal(custom.rateLimit.ip.limit, 25);
  assert.equal(custom.maxActivePerPhone, 5);
});

test('policy: hashing secret falls back to BETTER_AUTH_SECRET; a short secret counts as none', () => {
  assert.equal(readPublicBookingPolicy({ BETTER_AUTH_SECRET: 'x'.repeat(32) }).hashSecret, 'x'.repeat(32));
  assert.equal(readPublicBookingPolicy({ PUBLIC_BOOKING_HASH_SECRET: 'y'.repeat(20), BETTER_AUTH_SECRET: 'x'.repeat(32) }).hashSecret, 'y'.repeat(20));
  assert.equal(readPublicBookingPolicy({ PUBLIC_BOOKING_HASH_SECRET: 'short' }).hashSecret, null);
});

test('the browser config carries the Turnstile SITE key only — never the secret', () => {
  const env = {
    PUBLIC_BOOKING_TURNSTILE_ENABLED: 'true',
    NEXT_PUBLIC_TURNSTILE_SITE_KEY: 'site-key',
    PUBLIC_BOOKING_TURNSTILE_SECRET_KEY: 'super-secret',
    PUBLIC_BOOKING_HASH_SECRET: 'h'.repeat(32),
  };
  const cfg = publicClientConfig(readPublicBookingPolicy(env));
  assert.equal(cfg.turnstileSiteKey, 'site-key');
  assert.equal(cfg.turnstileMisconfigured, false);
  assert.ok(!JSON.stringify(cfg).includes('super-secret'));
  assert.ok(!JSON.stringify(cfg).includes('h'.repeat(32)));
  // Enabled without a secret (or without a site key) → the page says it is unavailable.
  assert.equal(publicClientConfig(readPublicBookingPolicy({ ...env, PUBLIC_BOOKING_TURNSTILE_SECRET_KEY: '' })).turnstileMisconfigured, true);
  // Disabled → no widget at all, even with keys present.
  assert.equal(publicClientConfig(readPublicBookingPolicy({ ...env, PUBLIC_BOOKING_TURNSTILE_ENABLED: 'false' })).turnstileSiteKey, null);
});

test('privacy URL: only absolute http(s) is accepted — no relative path, no javascript:', () => {
  assert.equal(safeExternalUrl('https://example.com/privacidad'), 'https://example.com/privacidad');
  assert.equal(safeExternalUrl('/privacidad'), null);
  assert.equal(safeExternalUrl('javascript:alert(1)'), null);
  assert.equal(safeExternalUrl(''), null);
});

// ── Turnstile ───────────────────────────────────────────────────────────────────

function fakeFetch(answer: unknown, status = 200) {
  const calls: Array<{ url: string; body: URLSearchParams }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: new URLSearchParams(String(init?.body ?? '')) });
    return new Response(JSON.stringify(answer), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { impl, calls };
}

test('turnstile: no secret or no token → refused without calling Cloudflare', async () => {
  const f = fakeFetch({ success: true });
  assert.deepEqual(await verifyTurnstileToken({ secret: null, token: 't', fetchImpl: f.impl }), { ok: false, reason: 'missing_secret' });
  assert.deepEqual(await verifyTurnstileToken({ secret: 's', token: '', fetchImpl: f.impl }), { ok: false, reason: 'missing_token' });
  assert.deepEqual(await verifyTurnstileToken({ secret: 's', token: 'x'.repeat(2049), fetchImpl: f.impl }), { ok: false, reason: 'missing_token' });
  assert.equal(f.calls.length, 0);
});

test('turnstile: only Cloudflare success:true passes; the request carries secret, token, ip and a UUID idempotency key', async () => {
  const ok = fakeFetch({ success: true, action: 'public_booking' });
  const key = '0b5c8a52-6a0f-4e11-9d43-1f0ad2c1a3b4';
  assert.deepEqual(await verifyTurnstileToken({ secret: 's', token: 't', remoteIp: '1.2.3.4', idempotencyKey: key, fetchImpl: ok.impl }), { ok: true });
  assert.equal(ok.calls[0].url, TURNSTILE_SITEVERIFY_URL);
  assert.equal(ok.calls[0].body.get('secret'), 's');
  assert.equal(ok.calls[0].body.get('response'), 't');
  assert.equal(ok.calls[0].body.get('remoteip'), '1.2.3.4');
  assert.equal(ok.calls[0].body.get('idempotency_key'), key);

  const notUuid = fakeFetch({ success: true });
  await verifyTurnstileToken({ secret: 's', token: 't', idempotencyKey: 'not-a-uuid', fetchImpl: notUuid.impl });
  assert.equal(notUuid.calls[0].body.get('idempotency_key'), null);

  for (const answer of [{ success: false, 'error-codes': ['timeout-or-duplicate'] }, { success: 'true' }, {}]) {
    assert.deepEqual(await verifyTurnstileToken({ secret: 's', token: 't', fetchImpl: fakeFetch(answer).impl }), { ok: false, reason: 'invalid' });
  }
  assert.deepEqual(
    await verifyTurnstileToken({ secret: 's', token: 't', fetchImpl: fakeFetch({ success: true, action: 'login' }).impl }),
    { ok: false, reason: 'invalid' },
    'a token minted for another action is refused',
  );
});

test('turnstile: HTTP error, bad JSON, network error and timeout all fail closed as unavailable', async () => {
  assert.deepEqual(await verifyTurnstileToken({ secret: 's', token: 't', fetchImpl: fakeFetch({ success: true }, 500).impl }), { ok: false, reason: 'unavailable' });
  const badJson = (async () => new Response('<html>', { status: 200 })) as unknown as typeof fetch;
  assert.deepEqual(await verifyTurnstileToken({ secret: 's', token: 't', fetchImpl: badJson }), { ok: false, reason: 'unavailable' });
  const boom = (async () => {
    throw new Error('ECONNRESET');
  }) as unknown as typeof fetch;
  assert.deepEqual(await verifyTurnstileToken({ secret: 's', token: 't', fetchImpl: boom }), { ok: false, reason: 'unavailable' });
  const hang = ((_u: unknown, init?: RequestInit) =>
    new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))) as unknown as typeof fetch;
  const started = Date.now();
  // AbortSignal.timeout's timer is unref'd; keep the loop alive while it fires.
  const keepAlive = setTimeout(() => undefined, 2000);
  assert.deepEqual(await verifyTurnstileToken({ secret: 's', token: 't', timeoutMs: 50, fetchImpl: hang }), { ok: false, reason: 'unavailable' });
  clearTimeout(keepAlive);
  assert.ok(Date.now() - started < 2000, 'the timeout is honoured');
});

// ── API vocabulary ──────────────────────────────────────────────────────────────

test('the generic 404 is one fixed Spanish body; engine errors become Spanish, never the engine English', async () => {
  const a = await publicNotFound().text();
  const b = await publicNotFound().text();
  assert.equal(a, b);
  assert.match(a, /no está disponible/);
  for (const err of ['conflict_slot', 'unavailable', 'no_staff', 'conflict_idempotency', 'not_found', 'invalid_phone', 'active_limit', 'contact_conflict'] as const) {
    const res = publicEngineError(err);
    const text = await res.text();
    assert.ok(!/That time|Service is not|Idempotency-Key|Could not read/.test(text), `${err} is translated`);
    assert.ok(res.status >= 400 && res.status < 500);
  }
  assert.equal(publicEngineError('conflict_slot').status, 409);
  assert.match(PUBLIC_API_HEADERS['Cache-Control'], /no-store/);
});

test('projections: site exposes closed weekdays only; slots keep only public staff; the confirmation has no row id', () => {
  assert.deepEqual(
    projectPublicSite({ name: 'S', address: null, timezone: 'America/Bogota', opening_hours: { mon: [{ start: '09:00', end: '18:00' }] } }).closed_weekdays,
    ['sun', 'tue', 'wed', 'thu', 'fri', 'sat'],
  );
  assert.deepEqual(projectPublicSite({ name: 'S', address: null, timezone: 'UTC', opening_hours: {} }).closed_weekdays, [], 'no hours configured = unknown = open');

  const t = new Date('2030-01-02T15:00:00Z');
  const slots = projectPublicSlots(
    [
      { start_at: t, service_end_at: t, staff_id: 'hidden', available_staff_ids: ['hidden', 'ana'] },
      { start_at: t, service_end_at: t, staff_id: 'hidden', available_staff_ids: ['hidden'] },
    ],
    new Set(['ana']),
  );
  assert.equal(slots.length, 1);
  assert.equal(slots[0].staff_id, 'ana');
  assert.deepEqual(slots[0].available_staff_ids, ['ana']);

  const c = projectPublicConfirmation(
    { public_reference: 'ref', service_name_snapshot: 'Corte', start_at: t, service_end_at: t, duration_min_snapshot: 30, price_snapshot: null, ...({ id: 'row-id', tenant_id: 'tid', client_id: 'cid', contact_id: 'kid' } as object) } as never,
    { name: 'S', address: null, timezone: 'UTC', ...({ tenant_id: 'tid', client_id: 'cid' } as object) } as never,
    'Ana',
  );
  const json = JSON.stringify(c);
  for (const leak of ['row-id', 'tid', 'cid', 'kid']) assert.ok(!json.includes(leak), `${leak} not projected`);
});

// ── Rate-limit hashing ──────────────────────────────────────────────────────────

test('rate keys are HMACs bound to scope and site; a missing secret throws (fail closed)', () => {
  const s = 'k'.repeat(32);
  const a = hashRateKey(s, 'ip', 'site-a', '1.2.3.4');
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, hashRateKey(s, 'ip', 'site-b', '1.2.3.4'), 'per site');
  assert.notEqual(a, hashRateKey(s, 'phone', 'site-a', '1.2.3.4'), 'per scope');
  assert.notEqual(a, hashRateKey('j'.repeat(32), 'ip', 'site-a', '1.2.3.4'), 'per secret');
  assert.ok(!a.includes('1.2.3.4'));
  assert.throws(() => hashRateKey('', 'ip', 'site', 'v'));
  assert.equal(windowStartFor(new Date('2030-01-01T00:07:30Z'), 600).toISOString(), '2030-01-01T00:00:00.000Z');
});

// ── Calendar helpers ────────────────────────────────────────────────────────────

test('month segments respect the 14-day cap, start today, and cover the rest of the month at site midnight', () => {
  const tz = 'America/Bogota';
  const segs = monthSegments('2030-03', '2030-03-05', tz);
  assert.equal(segs[0].from.toISOString(), siteMidnight('2030-03-05', tz).toISOString());
  assert.equal(segs.at(-1)!.to.toISOString(), siteMidnight('2030-04-01', tz).toISOString());
  for (let i = 0; i < segs.length; i++) {
    assert.ok(segs[i].to.getTime() - segs[i].from.getTime() <= 14 * 86_400_000, 'each ≤ 14 days');
    if (i > 0) assert.equal(segs[i].from.getTime(), segs[i - 1].to.getTime(), 'contiguous');
  }
  assert.deepEqual(monthSegments('2030-02', '2030-03-05', tz), [], 'a past month needs no query');
  assert.equal(siteMidnight('2030-03-05', tz).toISOString(), '2030-03-05T05:00:00.000Z');
});

test('calendar grid is Monday-first whole weeks; labels are Spanish 24-hour', () => {
  const days = calendarDays('2030-09'); // 1 Sep 2030 is a Sunday
  assert.equal(days.length % 7, 0);
  assert.equal(days[6].key, '2030-09-01');
  assert.equal(fmtTime('2030-09-02T20:30:00Z', 'America/Bogota'), '15:30');
  // The visitor may switch to 12-hour — still the SITE's clock, Spanish day period.
  assert.equal(fmtTime('2030-09-02T20:30:00Z', 'America/Bogota', '12'), '3:30 p. m.');
  assert.equal(fmtTime('2030-09-02T14:05:00Z', 'America/Bogota', '12'), '9:05 a. m.');
  assert.equal(fmtTime('2030-09-02T17:00:00Z', 'America/Bogota', '12'), '12:00 p. m.');
  assert.equal(dayHeadline('2030-09-03'), 'Martes 3 de septiembre');
  assert.match(timezoneLabel('America/Bogota'), /^Bogotá \(GMT-5\)$/);
});

test('the .ics carries only the confirmation fields, escaped, in UTC', () => {
  const ics = buildBookingIcs({
    reference: 'ref-1',
    service: 'Corte, barba; y más',
    site: 'Sede',
    address: 'Calle 1',
    staffName: 'Ana',
    startAt: '2030-01-02T15:00:00.000Z',
    endAt: '2030-01-02T16:00:00.000Z',
  });
  assert.ok(ics.includes('DTSTART:20300102T150000Z'));
  assert.ok(ics.includes('SUMMARY:Corte\\, barba\\; y más · Sede'));
  assert.ok(ics.includes('\r\n'));
  assert.equal(icsEscape('a\nb'), 'a\\nb');
});

test('staff tone is deterministic and from the pastel palette; initials skip an env tag', () => {
  assert.equal(staffTone('abc'), staffTone('abc'));
  assert.ok(['slate', 'lilac', 'sage', 'sand', 'blue'].includes(staffTone('x')));
  assert.equal(initialsOf('[DEV] Ana Ruiz'), 'AR');
});

test('booking link: built from the given origin, never a hard-coded host; status mirrors the public gate', () => {
  assert.equal(bookingPath('sede-centro'), '/book/sede-centro');
  assert.equal(bookingUrl('https://app.example.com/', 'sede-centro'), 'https://app.example.com/book/sede-centro');
  assert.equal(bookingUrl(null, 'sede centro'), '/book/sede%20centro');
  assert.equal(bookingLinkStatus({ siteActive: true, schedulingEnabled: true }), 'available');
  assert.equal(bookingLinkStatus({ siteActive: false, schedulingEnabled: true }), 'site_inactive');
  assert.equal(bookingLinkStatus({ siteActive: true, schedulingEnabled: false }), 'scheduling_disabled');
});

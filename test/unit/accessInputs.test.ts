import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { initialsOf, normalizePersonName } from '../../web/lib/personName.js';
import { countryOptions, nationalOf, normalizePhone } from '../../web/lib/phone.js';
import { destinationLabel, safeInternalPath } from '../../web/lib/safeRedirect.js';
import {
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  activeAgo,
  describeUserAgent,
  endReason,
  googleRecentAuthAt,
  isRecentlyReauthenticated,
  newSessionPolicy,
  onActivity,
  sessionTypeLabel,
} from '../../web/lib/sessionPolicy.js';
import { parseEndReason } from '../../web/lib/accessCopy.js';

/** ACCESO-1 — the pure rules: names, phones, safe return paths and the session numbers. */

test('name: one free field — accents, ñ, apostrophes, hyphens, one word and other scripts are all names', () => {
  for (const ok of ['Ana', 'José Ñúñez', "D'Angelo O'Brien", 'María-José', '李小龙', 'Zoë Saldaña', 'Nguyễn']) {
    const r = normalizePersonName(ok);
    assert.ok(r.ok, ok);
  }
  assert.deepEqual(normalizePersonName('  Valentina    Ríos  '), { ok: true, name: 'Valentina Ríos' });
  assert.equal(normalizePersonName('   ').ok, false);
  assert.equal(normalizePersonName('Ana\u0000').ok, false, 'control characters');
  assert.equal(normalizePersonName('Ana‮evil').ok, false, 'bidi override');
  assert.equal(normalizePersonName('x'.repeat(121)).ok, false);
  assert.equal(initialsOf('Valentina Ríos'), 'VR');
  assert.equal(initialsOf('ana'), 'A');
});

test('phone: real per-country validation (not a digit count), E.164 out, the country kept', () => {
  assert.deepEqual(normalizePhone({ country: 'CO', national: '300 123 4567' }), { ok: true, phone: { e164: '+573001234567', country: 'CO' } });
  assert.deepEqual(normalizePhone({ country: 'MX', national: '55 1234 5678' }), { ok: true, phone: { e164: '+525512345678', country: 'MX' } });
  assert.deepEqual(normalizePhone({ country: 'ES', national: '612 34 56 78' }), { ok: true, phone: { e164: '+34612345678', country: 'ES' } });
  // A number valid somewhere else is NOT valid for the chosen country.
  assert.equal(normalizePhone({ country: 'CO', national: '612 34 56 78' }).ok, false);
  // 6–14 digits is not the rule: 7 digits that are no Colombian number are refused…
  assert.equal(normalizePhone({ country: 'CO', national: '1234567' }).ok, false);
  // …and an international paste wins over the picked country.
  assert.deepEqual(normalizePhone({ country: 'CO', national: '+1 201 555 0123' }), { ok: true, phone: { e164: '+12015550123', country: 'US' } });
  assert.deepEqual(normalizePhone({ country: 'CO', national: '' }), { ok: true, phone: null }, 'optional: empty clears');
  assert.equal(normalizePhone({ country: 'CO', national: '300<script>' }).ok, false);
  assert.equal(normalizePhone({ country: 'XX', national: '300 123 4567' }).ok, false, 'unknown country');
  assert.equal(nationalOf('+573001234567'), '300 1234567');
  const opts = countryOptions();
  assert.equal(opts.priority[0]!.code, 'CO');
  assert.ok(opts.rest.length > 200, 'every country is offered');
  assert.equal(opts.priority.find((o) => o.code === 'CO')!.dial, '+57');
});

test('return path after login: only same-site paths, never auth screens or APIs; the query survives', () => {
  const ok = ['/clients/x/scheduling/agenda?date=2026-10-29', '/settings/security/sessions', '/invite/accept?token=abc'];
  for (const p of ok) assert.equal(safeInternalPath(p), p, p);
  const bad = [
    'https://evil.example/',
    '//evil.example',
    '/\\evil.example',
    '\\\\evil.example',
    'javascript:alert(1)',
    '/%0d%0aSet-Cookie:x',
    '/login?redirect=/x',
    '/logout',
    '/api/auth/sign-out',
    '/_next/static/x.js',
    'clients',
    '',
    null,
    `/${'a'.repeat(3000)}`,
  ];
  for (const p of bad) assert.equal(safeInternalPath(p as string), '/negocios', String(p));
  assert.equal(safeInternalPath('/\u0000x'), '/negocios', 'control characters');
  assert.equal(destinationLabel('/clients/x/scheduling/agenda?date=1'), 'Agenda');
  assert.equal(destinationLabel('/clients/x/inbox'), 'Inbox');
  assert.equal(destinationLabel('/'), null);
  assert.equal(parseEndReason('idle'), 'idle');
  assert.equal(parseEndReason('<script>'), null);
});

test('session numbers: 30 days fixed / 12 h max + 2 h idle; activity clamps to the absolute end', () => {
  const now = new Date('2026-10-26T14:00:00Z');
  const p = newSessionPolicy({ now, persistent: true });
  assert.equal(p.expiresAt.getTime(), now.getTime() + 30 * DAY_MS);
  assert.equal(onActivity(p, new Date(now.getTime() + DAY_MS)), null, 'persistent: activity changes nothing');

  const s = newSessionPolicy({ now, persistent: false });
  assert.equal(s.expiresAt.getTime(), now.getTime() + 2 * HOUR_MS);
  assert.equal(s.absoluteExpiresAt.getTime(), now.getTime() + 12 * HOUR_MS);
  const late = new Date(now.getTime() + 11 * HOUR_MS);
  const next = onActivity({ ...s, expiresAt: new Date(late.getTime() + MINUTE_MS) }, late)!;
  assert.equal(next.expiresAt.getTime(), s.absoluteExpiresAt.getTime(), 'clamped to 12 h');
  assert.equal(onActivity({ ...s, expiresAt: new Date(now.getTime() - 1) }, now), null, 'an expired session is never revived');
  assert.equal(endReason({ persistent: false, absoluteExpiresAt: s.absoluteExpiresAt, expiresAt: s.expiresAt }), 'idle');
  assert.equal(endReason({ persistent: false, absoluteExpiresAt: s.absoluteExpiresAt, expiresAt: s.absoluteExpiresAt }), 'max');
  assert.equal(endReason(p), 'persist');
});

test('recent authentication: 10 minutes; Google auth_time, when sent, must be recent', () => {
  const now = new Date('2026-10-26T14:00:00Z');
  assert.equal(isRecentlyReauthenticated(new Date(now.getTime() - 9 * MINUTE_MS), now), true);
  assert.equal(isRecentlyReauthenticated(new Date(now.getTime() - 11 * MINUTE_MS), now), false);
  assert.equal(isRecentlyReauthenticated(null, now), false);
  assert.equal(isRecentlyReauthenticated(new Date(now.getTime() + 5 * MINUTE_MS), now), false, 'a future stamp is not trusted');
  // Google auth_time is the ONLY proof: present, numeric, within 10 minutes, not in the future.
  const sec = (ms: number) => ms / 1000;
  assert.equal(googleRecentAuthAt(sec(now.getTime() - 3 * MINUTE_MS), now)?.getTime(), now.getTime() - 3 * MINUTE_MS, 'the REAL auth moment');
  assert.equal(googleRecentAuthAt(sec(now.getTime() - 11 * MINUTE_MS), now), null, 'stale');
  assert.equal(googleRecentAuthAt(sec(now.getTime() + 5 * MINUTE_MS), now), null, 'future');
  assert.equal(googleRecentAuthAt(sec(now.getTime() + 30_000), now)?.getTime(), now.getTime(), 'small skew tolerated, clamped to now');
  for (const bad of [undefined, null, '1700000000', NaN, Infinity, 0, -1, {}, true]) {
    assert.equal(googleRecentAuthAt(bad, now), null, `rejects ${String(bad)}`);
  }
});

test('Seguridad → Sesiones labels: only what the User-Agent says; never a guessed place', () => {
  assert.deepEqual(describeUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1'), { label: 'Safari · iOS', kind: 'phone' });
  assert.equal(describeUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0').label, 'Edge · Windows');
  assert.equal(describeUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36').label, 'Chrome · macOS');
  assert.equal(describeUserAgent('').label, 'Navegador no identificado');
  assert.equal(describeUserAgent('curl/8.0').label, 'Navegador no identificado');
  const now = new Date('2026-10-26T14:00:00Z');
  assert.equal(activeAgo(new Date(now.getTime() - 2 * HOUR_MS), now), 'Activa hace 2\u00a0h');
  assert.equal(activeAgo(new Date(now.getTime() - 3 * DAY_MS), now), 'Activa hace 3\u00a0días');
  assert.equal(sessionTypeLabel({ persistent: false, absoluteExpiresAt: now, authMethod: 'password' }), 'Sesión de 12\u00a0h');
  assert.match(sessionTypeLabel({ persistent: true, absoluteExpiresAt: now, authMethod: 'google' }), /^Mantener sesión · hasta /);
});

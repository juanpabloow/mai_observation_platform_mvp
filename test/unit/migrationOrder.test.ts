import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * MIGRATION ORDER CONTRACT. node-pg-migrate runs files in timestamp order and refuses
 * a pending migration dated before one already applied. Two branches cut from the same
 * base can each add a migration; whichever merges second must sort AFTER the other, or
 * `migrate:prod up` aborts in production. These checks catch the cheap half of that:
 * every prefix is a unique, well-formed timestamp, and the migrations known to have
 * collided keep their resolved order.
 */
const dir = fileURLToPath(new URL('../../migrations/', import.meta.url));
const files = readdirSync(dir).filter((f) => /\.(ts|js|sql)$/.test(f)).sort();

test('every migration starts with a unique 13-digit timestamp', () => {
  const stamps = files.map((f) => f.split('_')[0]);
  for (const [i, s] of stamps.entries()) assert.match(s, /^\d{13}$/, `${files[i]} has a 13-digit timestamp prefix`);
  assert.equal(new Set(stamps).size, stamps.length, 'no two migrations share a timestamp');
});

test('public booking rate limit runs AFTER the RBAC client-role migrations', () => {
  const idx = (name: string) => files.findIndex((f) => f.includes(name));
  const booking = idx('public-booking-rate-limit');
  assert.ok(booking >= 0, 'the public booking migration exists');
  assert.ok(!files.some((f) => f.startsWith('1784500000000_')), 'the pre-rename name is gone');
  for (const earlier of ['client-roles', 'setter-role']) {
    const i = idx(earlier);
    assert.ok(i >= 0 && i < booking, `${earlier} sorts before public-booking-rate-limit`);
  }
});

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { localWallClockToUtc, zonedPartsToUtc } from '../../src/scheduling/timezone.js';

/**
 * Point 4: schedule-exception wall-clock times must be interpreted in the SITE's
 * timezone, not the browser's. These assert the conversion is site-tz-based and
 * differs from a browser in another timezone interpreting the same wall-clock.
 */

test('a Bogotá wall-clock is anchored to the site tz, independent of any browser tz', () => {
  // 2026-08-05 12:00 local in Bogotá (UTC-5, no DST) → 17:00Z.
  const bogota = localWallClockToUtc('2026-08-05T12:00', 'America/Bogota');
  assert.equal(bogota.toISOString(), '2026-08-05T17:00:00.000Z');

  // The same wall-clock in New York (UTC-4 in Aug) → 16:00Z — a DIFFERENT instant.
  const ny = localWallClockToUtc('2026-08-05T12:00', 'America/New_York');
  assert.equal(ny.toISOString(), '2026-08-05T16:00:00.000Z');
  assert.notEqual(bogota.getTime(), ny.getTime());

  // So a browser in New York entering "12:00" for a Bogotá site must still store
  // 17:00Z (site tz), which is what the server-side conversion produces.
  assert.equal(bogota.getTime(), zonedPartsToUtc(2026, 8, 5, 12, 0, 'America/Bogota').getTime());
});

test('accepts space or T separator', () => {
  assert.equal(
    localWallClockToUtc('2026-08-05 09:30', 'America/Bogota').toISOString(),
    '2026-08-05T14:30:00.000Z',
  );
});

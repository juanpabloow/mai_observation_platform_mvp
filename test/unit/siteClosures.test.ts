import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { projectSiteClosures, SITE_CLOSURE_WINDOW_DAYS } from '../../web/lib/siteClosures.js';

/**
 * Upcoming whole-site closures on GET /api/scheduling/v1/sites: the assistant reads the
 * hours and closures from the agenda instead of a hardcoded prompt. Bogotá is UTC-5 all
 * year, so local midnight = 05:00Z.
 */

const TZ = 'America/Bogota';
const NOW = new Date('2026-11-05T15:00:00Z'); // jueves 5 nov, 10:00 a. m. local

test('a whole local day with «Cierre de la sede» reads as closed that day', () => {
  const [c] = projectSiteClosures(
    [{ from: new Date('2026-11-16T05:00:00Z'), until: new Date('2026-11-17T05:00:00Z'), public_reason: 'site_closed' }],
    TZ, NOW, 'es-CO',
  );
  assert.equal(c.all_day, true);
  assert.equal(c.day, '2026-11-16');
  assert.equal(c.from_local, '2026-11-16T00:00:00-05:00');
  assert.equal(c.public_reason_label, 'Cierre de la sede');
  assert.equal(c.customer_message, 'La sede está cerrada el lunes, 16 de noviembre.');
});

test('several whole days name the first and the LAST closed day, not the next morning', () => {
  const [c] = projectSiteClosures(
    [{ from: new Date('2026-12-24T05:00:00Z'), until: new Date('2026-12-26T05:00:00Z'), public_reason: 'site_closed' }],
    TZ, NOW, 'es-CO',
  );
  assert.equal(c.customer_message, 'La sede está cerrada del jueves, 24 de diciembre al viernes, 25 de diciembre.');
});

test('a partial closure gives the hours; without a public reason it stays neutral', () => {
  const [c] = projectSiteClosures(
    [{ from: new Date('2026-11-07T19:00:00Z'), until: new Date('2026-11-07T23:00:00Z'), public_reason: null }],
    TZ, NOW, 'es-CO',
  );
  assert.equal(c.all_day, false);
  assert.equal(c.public_reason, null);
  assert.equal(c.public_reason_label, null);
  assert.match(c.customer_message, /^La sede no atiende el sábado, 7 de noviembre de 2:00\sp\.\sm\. a 6:00\sp\.\sm\.\.$/);
});

test('past closures are dropped and the rest come earliest first', () => {
  const out = projectSiteClosures(
    [
      { from: new Date('2026-11-12T05:00:00Z'), until: new Date('2026-11-13T05:00:00Z'), public_reason: 'unavailable' },
      { from: new Date('2026-11-04T05:00:00Z'), until: new Date('2026-11-05T05:00:00Z'), public_reason: 'site_closed' },
      { from: new Date('2026-11-09T05:00:00Z'), until: new Date('2026-11-10T05:00:00Z'), public_reason: 'site_closed' },
    ],
    TZ, NOW, 'es-CO',
  );
  assert.deepEqual(out.map((c) => c.day), ['2026-11-09', '2026-11-12']);
  assert.equal(out[1].customer_message, 'La sede no atiende el jueves, 12 de noviembre.');
});

test('a closure already running is kept (it ends after now)', () => {
  const out = projectSiteClosures(
    [{ from: new Date('2026-11-05T05:00:00Z'), until: new Date('2026-11-06T05:00:00Z'), public_reason: 'site_closed' }],
    TZ, NOW, 'es-CO',
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].customer_message, 'La sede está cerrada el jueves, 5 de noviembre.');
});

test('/sites wiring: hours from the booking-page projection, closures with public reason only', () => {
  const src = readFileSync(fileURLToPath(new URL('../../web/app/api/scheduling/v1/sites/route.ts', import.meta.url)), 'utf8');
  assert.match(src, /projectPublicSite\(s\)/);
  assert.match(src, /loadExplainExceptions\(\{ tenantId: auth\.auth\.tenantId, siteId: s\.id/);
  assert.match(src, /staffIds: \[\]/, 'site-wide blocks only — never a professional’s absence');
  assert.match(src, /upcoming_closures: projectSiteClosures\(exc\.site,/);
  assert.doesNotMatch(src, /\.reason\b|\breason:/, 'the internal block text must never be read or sent');
  assert.equal(SITE_CLOSURE_WINDOW_DAYS, 14);
});

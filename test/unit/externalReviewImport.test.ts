import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  externalKeyFor,
  freshaUrlOrNull,
  IMPORT_MAX_ROWS,
  parseCsv,
  parseReviewDate,
  parseStars,
  planExternalImport,
  readImportRows,
  redactForPublic,
  type ImportCatalog,
  type ImportMapping,
} from '../../web/lib/externalReviewImport.js';

/**
 * The Fresha import PLAN (the mandatory dry-run): pure, no database. What a platform
 * administrator sees before anything is written — explicit equivalences only, unknown
 * attribution stays unattributed, every invalid row blocks, contact data is redacted in
 * the public text with the original kept, and re-planning the same file is idempotent.
 */

const NOW = new Date('2026-10-14T15:00:00Z');
const FEDE = '11111111-1111-4111-8111-111111111111';
const FALLA = '22222222-2222-4222-8222-222222222222';
const CORTE = '33333333-3333-4333-8333-333333333333';
const CATALOG: ImportCatalog = {
  siteId: '99999999-9999-4999-8999-999999999999',
  siteSlug: 'gallery-93',
  timezone: 'America/Bogota',
  staff: [
    { id: FEDE, name: 'Federico' },
    { id: FALLA, name: 'Falla' },
  ],
  services: [{ id: CORTE, name: 'Corte Signature' }],
};

const HEAD = 'Fecha,Cliente,Estrellas,Comentario,Artista,Servicio,Enlace';
const CSV = [
  HEAD,
  '2026-03-14,Andrés Gómez Ruiz,5,"Excelente, muy puntual",Federico,Corte Signature,https://www.fresha.com/es/a/gallery-93/reviews/abc',
  '14/02/2026,lucía pérez,4,,falla,Corte + barba,captura-0214.png',
  '2026-01-05,Mateo,5,Volveré,,,',
].join('\n');

const FULL: ImportMapping = {
  site: 'gallery-93',
  staff: { Federico: FEDE, falla: FALLA },
  services: { 'Corte Signature': CORTE, 'Corte + barba': null },
};

const plan = (mapping: ImportMapping | null, csv = CSV, existing = new Set<string>()) => {
  const { rows, errors } = readImportRows(csv);
  assert.deepEqual(errors, []);
  return planExternalImport({ rows, catalog: CATALOG, mapping, existingKeys: existing, now: NOW });
};

test('CSV: quotes, doubled quotes, CRLF, BOM and ";" exports', () => {
  assert.deepEqual(parseCsv('﻿a,b\r\n"x, y","di""jo"\r\n'), [['a', 'b'], ['x, y', 'di"jo']]);
  assert.deepEqual(parseCsv('a;b\n1;"2;3"\n\n'), [['a', 'b'], ['1', '2;3']]);
});

test('required columns are enforced; the artist column is optional; the row limit holds', () => {
  assert.match(readImportRows('Cliente,Comentario\nAna,Bien').errors[0], /Faltan columnas/);
  assert.deepEqual(readImportRows('Fecha,Cliente,Estrellas\n2026-01-01,Ana,5').errors, []);
  const big = ['Fecha,Cliente,Estrellas', ...Array.from({ length: IMPORT_MAX_ROWS + 1 }, () => '2026-01-01,Ana,5')].join('\n');
  assert.match(readImportRows(big).errors[0], /Máximo/);
});

test('stars: integers 1–5 only; dates: real, past, day-first — never in the future', () => {
  assert.deepEqual(['5', '4,0', '1.0'].map(parseStars), [5, 4, 1]);
  assert.deepEqual(['0', '6', '4.5', 'cinco', ''].map(parseStars), [null, null, null, null, null]);
  assert.ok(parseReviewDate('14/03/2026', 'America/Bogota', NOW));
  assert.equal(parseReviewDate('2027-01-01', 'America/Bogota', NOW), null, 'future');
  assert.equal(parseReviewDate('31/02/2026', 'America/Bogota', NOW), null, 'impossible');
  assert.equal(parseReviewDate('03/14/2026', 'America/Bogota', NOW), null, 'month-first is not guessed');
  // No time → noon in the site's zone: the day never shifts.
  assert.equal(parseReviewDate('2026-03-14', 'America/Bogota', NOW)!.toISOString(), '2026-03-14T17:00:00.000Z');
});

test('without equivalences NOTHING can be applied — exact name matches are only suggestions', () => {
  const p = plan(null);
  assert.equal(p.canApply, false);
  assert.deepEqual(p.unmapped.staff, ['Federico', 'falla']);
  assert.equal(p.proposedMapping.staff.Federico, FEDE, 'exact match suggested');
  assert.equal(p.proposedMapping.staff.falla, FALLA, 'case/accents only');
  assert.equal(p.proposedMapping.services['Corte + barba'], null, 'no fuzzy match: unknown stays null');
  assert.equal(p.ready.length, 1, 'only the row with no artist/service needs no confirmation');
});

test('a fuzzy-looking name is NOT matched (no "Fede" → Federico)', () => {
  const p = plan(null, [HEAD, '2026-03-14,Ana,5,Bien,Fede,,'].join('\n'));
  assert.equal(p.proposedMapping.staff.Fede, null);
});

test('with every equivalence confirmed: ready, explicit "sin atribuir", provenance fields', () => {
  const p = plan(FULL);
  assert.equal(p.canApply, true);
  assert.equal(p.ready.length, 3);
  const [a, b, c] = p.ready;
  assert.equal(a.staffId, FEDE);
  assert.equal(a.serviceId, CORTE);
  assert.equal(a.authorDisplay, 'Andrés G.', 'private author format');
  assert.equal(a.publicSourceUrl, 'https://www.fresha.com/es/a/gallery-93/reviews/abc');
  assert.equal(b.serviceId, null, 'confirmed as unknown service → counts for no service');
  assert.equal(b.serviceName, 'Corte + barba', 'the text the source showed is kept as text');
  assert.equal(b.evidenceRef, 'captura-0214.png', 'internal reference kept…');
  assert.equal(b.publicSourceUrl, null, '…but never a public link');
  assert.equal(c.staffId, null, 'no artist in the file → unattributed');
  assert.equal(c.serviceId, null);
});

test('an artist confirmed as "Sin atribuir" (null) imports without attribution', () => {
  const p = plan({ ...FULL, staff: { Federico: FEDE, falla: null } });
  assert.equal(p.canApply, true);
  assert.equal(p.ready.find((r) => r.line === 3)!.staffId, null);
});

test('an id from another site / client is refused, never trusted', () => {
  const foreign = '44444444-4444-4444-8444-444444444444';
  const p = plan({ ...FULL, staff: { Federico: foreign, falla: FALLA } });
  assert.equal(p.canApply, false);
  assert.match(p.errors.join(' '), /no es un profesional de esta sede/);
  const otherSite = plan({ ...FULL, site: 'otra-sede' });
  assert.equal(otherSite.canApply, false);
});

test('any invalid row blocks the whole import (future date, stars, size, control chars)', () => {
  const bad = [
    HEAD,
    '2027-01-01,Ana,5,Bien,,,',
    '2026-01-01,Ana,6,Bien,,,',
    `2026-01-01,Ana,5,"${'x'.repeat(601)}",,,`,
    '2026-01-01,Ana,5,"hola\u0007",,,',
  ].join('\n');
  const p = plan(FULL, bad);
  assert.equal(p.canApply, false);
  assert.deepEqual(p.rejected.map((r) => r.line), [2, 3, 4, 5]);
  assert.match(p.rejected[2].reason, /no se recorta/, 'never truncated (it would change its meaning)');
});

test('spreadsheet formula cells are rejected (formula injection)', () => {
  const p = plan(FULL, [HEAD, '2026-01-01,=HYPERLINK("http://x"),5,Bien,,,', '2026-01-01,Ana,5,"+cmd|\' /C calc\'!A0",,,', '2026-01-01,Ana,5,@SUM(1),,,', '2026-01-01,Ana,5,"- muy bien, volveré",,,'].join('\n'));
  assert.deepEqual(p.rejected.map((r) => r.line), [2, 3, 4]);
  assert.match(p.rejected[0].reason, /fórmula/);
  assert.equal(p.ready.length, 1, '"- muy bien" (a dash and a space) is ordinary text');
});

test('contact data and links are redacted in the PUBLIC text only; the original is kept', () => {
  const r = redactForPublic('Excelente. Escríbeme a ana@correo.com o al 300 123 4567, ver www.misitio.com');
  assert.equal(r.changed, true);
  assert.doesNotMatch(r.text!, /ana@|300 123|misitio/);
  assert.match(r.text!, /^Excelente\. Escríbeme a \[dato oculto\] o al \[dato oculto\]/);
  assert.equal(redactForPublic('Muy buen corte').changed, false);

  const p = plan(FULL, [HEAD, '2026-01-01,Ana,5,"Genial, mi cel 3001234567",,,'].join('\n'));
  const row = p.ready[0];
  assert.equal(row.redacted, true);
  assert.equal(row.originalComment, 'Genial, mi cel 3001234567', 'audit copy, internal');
  assert.doesNotMatch(row.comment!, /3001234567/);
});

test('the public link is https fresha.com only — anything else stays internal', () => {
  assert.ok(freshaUrlOrNull('https://www.fresha.com/x'));
  assert.ok(freshaUrlOrNull('https://fresha.com/x'));
  for (const u of ['http://www.fresha.com/x', 'https://fresha.com.evil.io/x', 'https://evil.io/fresha.com', 'javascript:alert(1)', 'https://user:pw@fresha.com/x', 'captura.png']) {
    assert.equal(freshaUrlOrNull(u), null, u);
  }
});

test('idempotent: stable keys; a re-plan skips what was imported and repeats in the file', () => {
  const first = plan(FULL);
  const keys = new Set(first.ready.map((r) => r.externalKey));
  assert.equal(keys.size, 3);
  const again = plan(FULL, CSV, keys);
  assert.equal(again.ready.length, 0);
  assert.deepEqual(again.duplicates.map((d) => d.reason), ['already_imported', 'already_imported', 'already_imported']);

  const twice = plan(FULL, [HEAD, '2026-01-05,Mateo,5,Volveré,,,', '2026-01-05,Mateo,5,Volveré,,,'].join('\n'));
  assert.equal(twice.ready.length, 1);
  assert.equal(twice.duplicates[0].reason, 'repeated_in_file');

  const { rows } = readImportRows(CSV);
  assert.equal(externalKeyFor(rows[0], CATALOG.siteId), externalKeyFor(rows[0], CATALOG.siteId));
  assert.notEqual(externalKeyFor(rows[0], CATALOG.siteId), externalKeyFor(rows[0], 'another-site'), 'scoped per site');
});

// ── Public wording ──────────────────────────────────────────────────────────────

test('public wording: says where reviews come from, explains mixed averages, never "verified"', async () => {
  const { reviewOrigin, originalDate } = await import('../../web/lib/publicReviews.js');
  assert.match(reviewOrigin({ count: 4, imported: 0 }), /cita completada aquí/);
  assert.match(reviewOrigin({ count: 4 }), /cita completada aquí/, 'absent = all collected here');
  assert.match(reviewOrigin({ count: 2, imported: 2 }), /^Reseñas importadas de Fresha: se revisó su procedencia/);
  assert.match(reviewOrigin({ count: 4, imported: 1 }), /^Incluye 1 reseña importada de Fresha .*Las demás son de clientes con una cita completada aquí\.$/);
  assert.match(reviewOrigin({ count: 4, imported: 3 }), /3 reseñas importadas/);
  for (const t of [reviewOrigin({ count: 2, imported: 2 }), reviewOrigin({ count: 4, imported: 1 })]) assert.doesNotMatch(t, /verificad/i);
  assert.equal(originalDate('2026-03-14T17:00:00.000Z'), '14 de marzo de 2026');
});

test('the booking components never call a review "Verificada" or an imported one an M_AI appointment', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const dir = new URL('../../web/components/booking/', import.meta.url);
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.tsx'))) {
    const src = readFileSync(new URL(f, dir), 'utf8');
    assert.doesNotMatch(src, /["'>][^"'<]*\bVerificad[ao]s?\b/, `${f}: no generic "Verificada" badge`);
    assert.doesNotMatch(src, /cita verificada/i, f);
  }
  const ui = readFileSync(new URL('ui.tsx', dir), 'utf8');
  assert.match(ui, /importada" : "importadas"\} de Fresha/, 'the rating button names imported reviews in its accessible name');
});

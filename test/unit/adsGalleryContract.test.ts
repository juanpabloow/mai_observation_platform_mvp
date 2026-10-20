import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * AT-UI source-contract tests for the cover-first Ads gallery. The repo has no DOM test harness, so
 * (as with the RBAC/catalog source contracts) these assert the accessibility + permission invariants
 * directly in the component source: the cover is a real keyboard/touch link, the tile opens the panel
 * via a button, covers are lazy with a fixed aspect, alt comes from the label, the share bar is
 * labelled, and every edit/upload/select control is gated behind `canManage` (Setter read-only).
 */
const src = readFileSync(fileURLToPath(new URL('../../web/components/campaigns/CampaignsPanel.tsx', import.meta.url)), 'utf8');

test('cover opens the creative via a real anchor (keyboard + touch), lazy, fixed 4:5, alt from label', () => {
  assert.match(src, /href=\{creativeHref\}[\s\S]{0,80}target="_blank"/, 'cover is an <a> to the creative');
  assert.match(src, /loading="lazy"/, 'covers are lazy-loaded');
  assert.match(src, /aspect-\[4\/5\]/, 'cover sits in a fixed 4:5 frame');
  assert.match(src, /alt=\{label\}/, 'alt text from the ad label');
});

test('the tile body opens the detail panel via a <button> (reachable without hover)', () => {
  assert.match(src, /<button[^>]*onClick=\{onOpenDetail\}[\s\S]{0,120}aria-label=\{`Ver detalle de \$\{label\}`\}/);
});

test('no-cover tile renders the headline fallback and gates "Subir portada" behind canManage', () => {
  assert.match(src, /\{ad\.headline \|\| label\}/, 'headline fallback in the 4:5 frame');
  assert.match(src, /canManage \? <span[^>]*>Subir portada<\/span> : null/, 'upload prompt only for editors');
});

test('edit / cover-upload / campaign-change / select controls are all gated behind canManage', () => {
  assert.match(src, /canManage \? <AdCoverControl/, 'cover uploader behind canManage');
  assert.match(src, /canManage \? \(\s*<button type="button" aria-pressed=\{selectMode\}/, 'Seleccionar toggle behind canManage');
  assert.match(src, /Editar nombre y nota/, 'edit entry present');
  // the detail-panel campaign <select> is inside a canManage block
  assert.match(src, /canManage \? \(\s*<label[\s\S]{0,120}>Campaña<\/span>/, 'campaign change behind canManage');
  assert.match(src, /assignAdsToCampaignAction\(clientId, \[ad\.id\]/, 'campaign change reuses the existing assign action');
});

test('the share bar is labelled for assistive tech (role=img + percentage aria-label)', () => {
  assert.match(src, /role="img"\s+aria-label=\{`\$\{sharePct\}% de los leads/);
});

test('the unassigned group uses a warn/accent token, never error red', () => {
  // "Sin campaña" header styling uses warn tokens; no bg-danger / text-danger on the group header.
  assert.match(src, /group\.isUnassigned \? "bg-warn-soft"/);
  assert.ok(!/group\.isUnassigned \? "bg-danger/.test(src), 'never error red for the unassigned group');
});

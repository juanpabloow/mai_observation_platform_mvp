import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isChromelessPath } from '../../web/lib/shellChrome.js';

/**
 * SOURCE CONTRACT for the FRAMED SHELL (Shopify-style): on desktop, a signed-in screen
 * is a dark ground with the rail flush on it, and the header + content as ONE rounded
 * panel on top. Chromeless screens (auth, public booking) and phones stay full-bleed.
 */
const read = (rel: string): string => readFileSync(fileURLToPath(new URL(`../../web/${rel}`, import.meta.url)), 'utf8');

test('the header + content column is the framed panel', () => {
  const layout = read('app/layout.tsx');
  assert.ok(layout.includes('className="u-shell-frame flex min-w-0 min-h-0 flex-1 flex-col"'), 'one panel wraps header + content');
  assert.ok(layout.indexOf('className="u-shell-frame') < layout.indexOf('<AppHeader />'), 'the header is INSIDE the panel');
  assert.ok(layout.indexOf('<AppSidebarServer />') < layout.indexOf('className="u-shell-frame'), 'the rail is OUTSIDE it, on the ground');
});

test('the frame keys on the rail being present, desktop only — never a route list', () => {
  const css = read('app/globals.css');
  const start = css.indexOf('FRAMED SHELL');
  const block = css.slice(start, css.indexOf('Full-screen dialog scrim', start));
  assert.ok(block.includes('@media (min-width: 1280px)'), 'xl+ only (below it the rail is a drawer)');
  assert.ok(block.includes('body:has([data-collapsed]) .u-shell-frame'), 'framed only while the rail is in the DOM');
  assert.ok(block.includes('border-radius: var(--frame-radius)'), 'rounded panel');
  assert.ok(block.includes('margin: var(--frame-gap) var(--frame-gap) var(--frame-gap) 0'), 'inset top/right/bottom, flush to the rail');
  assert.ok(block.includes('--frame-ground: var(--sidebar-bg)'), 'the ground IS the rail colour');
  assert.ok(!/gradient|backdrop-filter/.test(block), 'flat: no gradient, no glass');
});

test('the streaming rail placeholder is framed, and skipped on chromeless screens', () => {
  const layout = read('app/layout.tsx');
  assert.ok(layout.includes('data-collapsed="false"'), 'the placeholder already frames the first paint');
  assert.ok(layout.includes('chromeless ? null'), 'auth / booking never get a placeholder rail');
  for (const p of ['/login', '/signup', '/logout', '/forgot-password', '/reset-password', '/book/x']) assert.ok(isChromelessPath(p), p);
  for (const p of ['/', '/clients/x/scheduling/agenda', '/contacts', '/bookings']) assert.ok(!isChromelessPath(p), p);
});

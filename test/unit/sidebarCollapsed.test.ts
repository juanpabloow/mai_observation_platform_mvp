import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve as resolvePath } from 'node:path';
import {
  hasSidebarCollapsedCookie,
  LEGACY_SIDEBAR_COLLAPSED_KEY,
  parseSidebarCollapsed,
  SIDEBAR_COLLAPSED_COOKIE,
  sidebarCollapsedCookie,
} from '../../web/lib/sidebarCollapsed.js';

/**
 * REGRESSION: loading a page with the sidebar collapsed threw a hydration mismatch.
 *
 * Cause: the preference lived only in localStorage. SSR always drew the rail expanded;
 * SidebarProvider applied the stored value in an effect after mount, and the rail — which
 * streams in its own <Suspense> boundary — hydrated LATER with `collapsed = true` against
 * expanded HTML. Fix: the preference is a cookie the root layout reads during SSR and
 * hands to the provider as its INITIAL state, so the server HTML and the browser's first
 * render are the same; the legacy localStorage value is adopted once, after the rail has
 * hydrated. (The end-to-end check — direct load, reload and navigation, both themes, with
 * zero hydration errors — is a headless-browser run; see the delivery report.)
 */

const web = fileURLToPath(new URL('../../web/', import.meta.url));
const read = (rel: string): string => readFileSync(`${web}${rel}`, 'utf8');

test('cookie helpers: one name, "1" = collapsed, anything else = expanded', () => {
  assert.equal(SIDEBAR_COLLAPSED_COOKIE, 'sidebar-collapsed');
  assert.equal(parseSidebarCollapsed('1'), true);
  for (const v of ['0', '', 'true', 'yes', undefined, null]) assert.equal(parseSidebarCollapsed(v), false, String(v));
  assert.equal(sidebarCollapsedCookie(true), 'sidebar-collapsed=1; path=/; max-age=31536000; samesite=lax');
  assert.equal(sidebarCollapsedCookie(false), 'sidebar-collapsed=0; path=/; max-age=31536000; samesite=lax');
  assert.equal(hasSidebarCollapsedCookie('a=1; sidebar-collapsed=0; b=2'), true);
  assert.equal(hasSidebarCollapsedCookie('a=1; not-sidebar-collapsed=1'), false);
  assert.equal(LEGACY_SIDEBAR_COLLAPSED_KEY, 'sidebarCollapsed', 'the pre-cookie key is still migrated');
});

test('SSR: the provider renders from the server-read value (what the first client render will use)', async () => {
  const req = createRequire(pathToFileURL(resolvePath(web, 'package.json')));
  const React = req('react') as typeof import('react');
  const { renderToString } = req('react-dom/server') as typeof import('react-dom/server');
  (globalThis as { React?: unknown }).React = React;
  const { SidebarProvider, useSidebar } = await import('../../web/components/SidebarContext.js');
  const Probe = () => React.createElement('aside', { 'data-collapsed': String(useSidebar().collapsed) });
  for (const initial of [true, false]) {
    const html = renderToString(React.createElement(SidebarProvider, { initialCollapsed: initial }, React.createElement(Probe)));
    assert.ok(html.includes(`data-collapsed="${initial}"`), `initialCollapsed=${initial} renders as such`);
  }
  // No prop (e.g. a test harness) keeps the expanded default.
  const html = renderToString(React.createElement(SidebarProvider, null, React.createElement(Probe)));
  assert.ok(html.includes('data-collapsed="false"'));
});

test('no post-mount re-sync: nothing changes the collapsed state while the shell hydrates', () => {
  const ctx = read('components/SidebarContext.tsx');
  // The bug was exactly an effect that read storage after mount and flipped the state.
  assert.equal(/useEffect\s*\(/.test(ctx), false, 'SidebarProvider has no mount effect');
  assert.equal(/localStorage\.getItem/.test(ctx), false, 'and never reads localStorage');
  assert.ok(ctx.includes('useState(initialCollapsed)'), 'its initial state IS the server value');
  assert.ok(ctx.includes('document.cookie = sidebarCollapsedCookie(collapsed);'), 'a change persists the cookie');
  // The layout reads the cookie during SSR and threads it to the provider AND to the
  // streaming placeholder (so even the pre-stream frame has the right width).
  const layout = read('app/layout.tsx');
  assert.ok(layout.includes('parseSidebarCollapsed(jar.get(SIDEBAR_COLLAPSED_COOKIE)?.value)'), 'layout reads the cookie');
  assert.ok(layout.includes('<Providers sidebarCollapsed={sidebarCollapsed}>'), 'and passes it to the provider');
  assert.ok(layout.includes('data-collapsed={sidebarCollapsed ? "true" : "false"}'), 'the placeholder matches it');
  assert.ok(read('app/providers.tsx').includes('<SidebarProvider initialCollapsed={sidebarCollapsed}>'), 'providers thread it');
  // The legacy value is adopted only from an effect of the RAIL (after it hydrated), and
  // never over an explicit cookie.
  const rail = read('components/AppSidebar.tsx');
  const migrate = rail.slice(rail.indexOf('ONE-TIME carry-over'), rail.indexOf('}, [setCollapsed]);'));
  assert.ok(migrate.includes('if (hasSidebarCollapsedCookie(document.cookie)) return;'), 'an explicit cookie wins');
  assert.ok(migrate.includes('localStorage.getItem(LEGACY_SIDEBAR_COLLAPSED_KEY)'), 'the legacy key is read once');
  // And the problem is not hidden.
  for (const rel of ['components/AppSidebar.tsx', 'components/SidebarContext.tsx']) {
    assert.equal(/suppressHydrationWarning/.test(read(rel)), false, `${rel} does not suppress hydration warnings`);
  }
});

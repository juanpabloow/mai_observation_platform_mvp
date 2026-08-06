import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_SIDEBAR_THEME,
  SIDEBAR_THEMES,
  SIDEBAR_THEME_COOKIE,
  SIDEBAR_THEME_LABELS,
  parseSidebarTheme,
  sidebarThemeCookie,
} from '../../web/lib/sidebarTheme.js';

/**
 * SIDEBAR APPEARANCE (Light | Black) — a personal, cookie-backed interface
 * preference that recolors ONLY the navigation rail.
 *
 * The behavioural contract is checked against the pure module; the wiring (SSR
 * stamping, which tokens the rail reads, and that the content is untouched) is
 * checked at source level, the same way the other shell contracts are.
 */

const web = fileURLToPath(new URL('../../web/', import.meta.url));
const read = (rel: string): string => readFileSync(`${web}${rel}`, 'utf8');

// ───────────────────────────── The preference ───────────────────────────────

test('Light is the default whenever the cookie is absent, blank or unknown', () => {
  assert.equal(DEFAULT_SIDEBAR_THEME, 'light');
  assert.equal(parseSidebarTheme(undefined), 'light');
  assert.equal(parseSidebarTheme(null), 'light');
  assert.equal(parseSidebarTheme(''), 'light');
  // A tampered or stale cookie must degrade to Light, never throw or render blank.
  assert.equal(parseSidebarTheme('BLACK'), 'light');
  assert.equal(parseSidebarTheme('dark'), 'light');
  assert.equal(parseSidebarTheme('__proto__'), 'light');
  assert.equal(parseSidebarTheme('black; rm -rf'), 'light');
});

test('a valid cookie resolves to that theme', () => {
  assert.equal(parseSidebarTheme('black'), 'black');
  assert.equal(parseSidebarTheme('light'), 'light');
  assert.deepEqual([...SIDEBAR_THEMES], ['light', 'black']);
});

test('the persisted cookie is scoped to the whole app and long-lived', () => {
  const c = sidebarThemeCookie('black');
  assert.ok(c.startsWith(`${SIDEBAR_THEME_COOKIE}=black`), 'writes the shared cookie name');
  assert.ok(c.includes('path=/'), 'every route sees it (so the rail never disagrees with itself)');
  assert.ok(c.includes('max-age=31536000'), 'survives the session');
  assert.ok(c.includes('samesite=lax'), 'survives normal navigation');
  assert.ok(sidebarThemeCookie('light').startsWith(`${SIDEBAR_THEME_COOKIE}=light`));
});

// ─────────────────────────────── The wiring ─────────────────────────────────

test('the cookie is read during SSR and stamped on <html> — no flash', () => {
  const layout = read('app/layout.tsx');
  assert.ok(layout.includes('await cookies()).get(SIDEBAR_THEME_COOKIE)'), 'read server-side…');
  assert.ok(layout.includes('parseSidebarTheme('), '…through the shared parser…');
  assert.ok(layout.includes('data-sidebar-theme={sidebarTheme}'), '…and stamped before the first paint');
});

test('choosing an option applies it immediately AND persists it', () => {
  const menu = read('components/AccountMenu.tsx');
  assert.ok(menu.includes('document.documentElement.dataset.sidebarTheme = theme'), 'instant visual feedback');
  assert.ok(menu.includes('document.cookie = sidebarThemeCookie(theme)'), 'persisted for the next SSR');
  // The control is labelled exactly as specified and offers both options.
  assert.ok(menu.includes('Sidebar appearance'), 'the menu row is "Sidebar appearance"');
  assert.ok(menu.includes('SIDEBAR_THEMES.map('), 'both Light and Black are offered');
  assert.ok(menu.includes('aria-pressed={theme === opt}'), 'the active option is exposed to AT');
});

test('the DOM is never touched on the server, and only ever written from an effect', () => {
  const menu = read('components/AccountMenu.tsx');
  // The seed is guarded, so rendering on the server can never dereference document.
  assert.ok(menu.includes('typeof document === "undefined"'), 'the state seed is SSR-guarded');
  // The WRITE lives in an effect (React Compiler forbids mutating externals from a
  // handler), so the click path only setStates.
  // Anchor on SidebarAppearance's own effect — `return (` also appears earlier, in
  // the outer AccountMenu, so the slice has to start from the effect's offset.
  const effectStart = menu.indexOf('useEffect(() => {', menu.indexOf('function SidebarAppearance()'));
  const effect = menu.slice(effectStart, menu.indexOf('return (', effectStart));
  assert.ok(effect.includes('document.documentElement.dataset.sidebarTheme = theme'), 'the DOM write lives in the effect');
  assert.ok(effect.includes('document.cookie = sidebarThemeCookie(theme)'), 'the cookie write lives in the effect');
  assert.ok(menu.includes('onClick={() => setTheme(opt)}'), 'the handler only updates React state');
});

test('the dark rail is the spec cool-dark, and it overrides ONLY the rail tokens', () => {
  const css = read('app/globals.css');
  // Just the Black RULE BODY — other token blocks follow it, and including them
  // would make the "touches nothing else" check below meaningless.
  const blackStart = css.indexOf("[data-sidebar-theme='black']");
  const black = css.slice(blackStart, css.indexOf('}', blackStart));
  for (const [token, value] of [
    ['--sidebar-bg', '#1a1d24'],
    ['--sidebar-border', '#262a33'],
    ['--sidebar-fg', '#f5f6f8'],
    ['--sidebar-muted', '#a2a8b4'],
    ['--sidebar-section', '#7e8695'],
  ] as const) {
    assert.ok(black.includes(`${token}: ${value}`), `${token} is ${value}`);
  }
  // Hover on a dark rail is the brand RED (supersedes the original #1A1A1D).
  assert.ok(black.includes('--sidebar-hover: var(--sidebar-hover-red)'), 'Black hover is the red token');
  // Nothing the CONTENT uses may be redefined under the Black selector — that is
  // the whole guarantee: only the sidebar changes.
  for (const contentToken of ['--background:', '--surface:', '--foreground:', '--muted:', '--faint:', '--line:', '--brand:']) {
    assert.ok(!black.includes(contentToken), `Black does not touch ${contentToken}`);
  }
});

test('the rail reads sidebar tokens only; the content never reads them', () => {
  const rail = read('components/AppSidebar.tsx') + read('components/InboxTabLink.tsx');
  for (const cls of ['bg-sidebar-bg', 'border-sidebar-border', 'text-sidebar-fg', 'text-sidebar-muted', 'hover:bg-sidebar-hover']) {
    assert.ok(rail.includes(cls), `the rail uses ${cls}`);
  }
  assert.ok(rail.includes('u-th-sidebar'), 'section headings use the rail-scoped heading class');
  // The redesigned content surfaces must not consume the rail's palette.
  for (const rel of [
    'app/clients/[clientId]/contacts/page.tsx',
    'components/ClientInboxWorkspace.tsx',
    'components/HeaderBar.tsx',
    'components/ui/primitives.tsx',
  ]) {
    assert.ok(!/sidebar-(bg|border|fg|muted|hover|section)/.test(read(rel)), `${rel} does not read rail tokens`);
  }
});

test('a DARK rail hovers red — but a TINT, so hover never impersonates the active row', () => {
  const css = read('app/globals.css');
  assert.ok(css.includes('--sidebar-hover-red: #7f1d1d'), 'the dark-rail hover is a red');
  // Applied to BOTH dark rails: the app's dark theme and the Black preference.
  const darkHover = css.slice(css.indexOf('.dark {\n  --sidebar-hover'));
  assert.ok(darkHover.startsWith('.dark {\n  --sidebar-hover: var(--sidebar-hover-red);'), 'dark app theme hovers red');
  const black = css.slice(css.indexOf("[data-sidebar-theme='black']"), css.indexOf('--sidebar-hover-red:'));
  assert.ok(black.includes('--sidebar-hover: var(--sidebar-hover-red)'), 'the Black rail hovers red');
  // A LIGHT rail in a LIGHT app keeps the neutral lift — the red is dark-only.
  const root = css.slice(css.indexOf('--sidebar-bg: var(--sidebar)'), css.indexOf("[data-sidebar-theme='black']"));
  assert.ok(root.includes('--sidebar-hover: var(--subtle)'), 'the light rail keeps a neutral hover');
  // Hover must stay distinguishable from the solid active fill.
  assert.notEqual('#7f1d1d', '#dc2626');
});

test('Black keeps the active row red with white text/icon, and the brand white', () => {
  const src = read('components/AppSidebar.tsx');
  // The active treatment is theme-independent (it is NOT a sidebar token), so it
  // stays the same solid red in both appearances; icons inherit currentColor.
  assert.ok(src.includes('bg-nav-active font-medium text-white'), 'active row: solid red + white');
  assert.ok(read('app/globals.css').includes('--nav-active: #e60a2f'), 'the spec accent, fixed in both modes');
  assert.ok(src.includes('stroke="currentColor"'), 'icons inherit the row colour');
  // The brand wordmark tracks the rail foreground, which is #F4F4F5 under Black.
  assert.ok(src.includes('tracking-tight text-sidebar-fg">M_AI'), 'the wordmark uses the rail foreground');
  const css = read('app/globals.css');
  const black = css.slice(css.indexOf("[data-sidebar-theme='black']"), css.indexOf('@theme inline {'));
  assert.ok(black.includes('--sidebar-fg: #f5f6f8'), 'which is near-white on the dark rail');
});

test('the account footer sits on the rail background, separated by a border', () => {
  const src = read('components/AppSidebar.tsx');
  assert.ok(src.includes('relative shrink-0 border-t border-sidebar-border'), 'footer separated by a rail border');
  assert.ok(src.includes('text-sidebar-muted transition-colors hover:bg-sidebar-hover'), 'footer uses rail tokens');
  // It is inside the <aside>, which carries bg-sidebar-bg — no separate fill.
  assert.ok(src.includes('bg-sidebar-bg'), 'the rail (and therefore the footer) is one surface');
});

// ────────────────── Navigation + permissions are untouched ──────────────────

test('the appearance change did not alter navigation, gating or permissions', () => {
  const src = read('components/AppSidebar.tsx');
  // Module gates.
  assert.ok(src.includes('moduleKeys.includes("inbox")'), 'Inbox still module-gated');
  assert.ok(src.includes('moduleKeys.includes("crm")'), 'CRM still module-gated');
  assert.ok(src.includes('moduleKeys.includes("scheduling")'), 'Scheduling still module-gated');
  // Role gates.
  assert.ok(src.includes('if (!isMember) {'), 'owner/admin-only items still gated by role');
  assert.ok(src.includes('clientId !== defaultClientId'), 'the default client still hides Modules');
  // Structure.
  assert.ok(src.includes('sections = [{ label: "Workspace", items: workspace }];'), 'Workspace is still first');
  assert.ok(src.includes('countEndpoint: `/api/inbox/${clientId}/pending-count`'), 'the real badge endpoint is intact');
  // And exactly one active treatment still exists.
  assert.equal(src.match(/bg-nav-active font-medium text-white/g)?.length, 1, 'one active treatment in the rail');
});

test('the repaint kept the stored cookie VALUE, so saved preferences still resolve', () => {
  // The palette became navy and the menu now reads "Navy", but the stored value is
  // still `black`. Renaming it would have made every previously-saved cookie
  // unknown, silently bouncing those users back to Light.
  assert.equal(parseSidebarTheme('black'), 'black');
  assert.ok(sidebarThemeCookie('black').startsWith('sidebar-theme=black'));
  assert.equal(SIDEBAR_THEME_LABELS.black, 'Navy', 'the label is decoupled from the value');
  assert.equal(SIDEBAR_THEME_LABELS.light, 'Light');
  const menu = read('components/AccountMenu.tsx');
  assert.ok(menu.includes('{SIDEBAR_THEME_LABELS[opt]}'), 'the menu renders the label, not the raw value');
});

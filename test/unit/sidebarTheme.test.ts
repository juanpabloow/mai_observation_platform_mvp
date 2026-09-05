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
  // The jar is read once now (the text-size preference shares it), so the assertion
  // is on the LOOKUP rather than the inline await.
  assert.ok(layout.includes('jar.get(SIDEBAR_THEME_COOKIE)'), 'read server-side…');
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

test('the dark rail is NEUTRAL near-black, and it overrides ONLY the rail tokens', () => {
  const css = read('app/globals.css');
  // Just the Black RULE BODY — other token blocks follow it, and including them
  // would make the "touches nothing else" check below meaningless.
  const blackStart = css.indexOf("[data-sidebar-theme='black']");
  const black = css.slice(blackStart, css.indexOf('}', blackStart));
  // NEUTRAL, not cool. The rail used to be #1A1D24 — the bluest end of the old spec's
  // range, chosen to read "cool beside the white panel"; that cast is exactly what made it
  // look NAVY rather than black. Every value is now on the grey axis.
  for (const [token, value] of [
    ['--sidebar-bg', '#1a1a1a'],
    ['--sidebar-border', '#272727'],
    ['--sidebar-fg', '#f7f7f7'],
    ['--sidebar-muted', '#d4d4d4'],
    ['--sidebar-section', '#9a9a9a'],
  ] as const) {
    assert.ok(black.includes(`${token}: ${value}`), `${token} is ${value}`);
  }
  // The GUARANTEE, checked structurally rather than by value: every colour the Black rail
  // declares is a neutral grey (R=G=B). A hex that drifts back off the grey axis fails
  // here, which is what "black, not navy" actually means.
  for (const m of black.matchAll(/--sidebar-[a-z-]+:\s*#([0-9a-f]{6})\b/g)) {
    const [r, g, b] = [m[1].slice(0, 2), m[1].slice(2, 4), m[1].slice(4, 6)];
    assert.ok(r === g && g === b, `#${m[1]} is a neutral grey, not a tinted one`);
  }
  // Hover on a dark rail is a NEUTRAL warm lift — see the dedicated case below.
  assert.ok(black.includes('--sidebar-hover: var(--sidebar-hover-dark)'), 'Black hover is the neutral token');
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

test('a DARK rail hovers NEUTRAL — hover is a ground change, never a second red', () => {
  const css = read('app/globals.css');
  // THE CONTRACT INVERTED. Hover used to be a dark RED tint (#7f1d1d), chosen so that it
  // and the solid-red ACTIVE row stayed tellable apart. In practice they didn't: a
  // hovered row and the current row read as two reds of similar weight, so the rail
  // appeared to have two "you are here" marks.
  //
  // The accent rule settles it — red marks the active nav item, and a colour on every row
  // you merely sweep past is the dilution that stops it meaning anything. Hover is a
  // change of GROUND (the design's #22262F), and the hovered label lifts to --sidebar-fg.
  assert.ok(css.includes('--sidebar-hover-dark: #242424'), 'the dark-rail hover is a neutral lift');
  // And the misleading name is gone with the value: a token called `-red` that is not red
  // is how the next person reintroduces this.
  assert.equal(/--sidebar-hover-red\s*:/.test(css), false, 'no token still claims to be red');
  // Applied to BOTH dark rails: the app's dark theme and the Black preference.
  const darkHover = css.slice(css.indexOf('.dark {\n  --sidebar-hover'));
  assert.ok(darkHover.startsWith('.dark {\n  --sidebar-hover: var(--sidebar-hover-dark);'), 'dark app theme hovers neutral');
  const black = css.slice(css.indexOf("[data-sidebar-theme='black']"), css.indexOf('--sidebar-hover-dark:'));
  assert.ok(black.includes('--sidebar-hover: var(--sidebar-hover-dark)'), 'the Black rail hovers neutral');
  // A LIGHT rail in a LIGHT app keeps its own neutral lift.
  const root = css.slice(css.indexOf('--sidebar-bg: var(--sidebar)'), css.indexOf("[data-sidebar-theme='black']"));
  assert.ok(root.includes('--sidebar-hover: var(--subtle)'), 'the light rail keeps a neutral hover');
  // The ONE red in the rail is the active fill, and hover is nowhere near it.
  assert.ok(css.includes('--nav-active: #e60a2f'), 'the active fill is the only red');
});

test('Black keeps the active row red with white text/icon, and the brand white', () => {
  const src = read('components/AppSidebar.tsx');
  // The active treatment is theme-independent (it is NOT a sidebar token), so it
  // stays the same solid red in both appearances; icons inherit currentColor.
  assert.ok(src.includes('bg-nav-active font-semibold text-white'), 'active row: solid red + white');
  assert.ok(read('app/globals.css').includes('--nav-active: #e60a2f'), 'the spec accent, fixed in both modes');
  assert.ok(src.includes('stroke="currentColor"'), 'icons inherit the row colour');
  // The brand wordmark tracks the rail foreground, which is #F4F4F5 under Black.
  assert.ok(src.includes('tracking-tight text-sidebar-fg">MONTSERRAT_AI'), 'the wordmark uses the rail foreground');
  const css = read('app/globals.css');
  const black = css.slice(css.indexOf("[data-sidebar-theme='black']"), css.indexOf('@theme inline {'));
  assert.ok(black.includes('--sidebar-fg: #f7f7f7'), 'which is near-white on the dark rail');
});

test('the account footer sits on the rail background, separated by a border', () => {
  const src = read('components/AppSidebar.tsx');
  assert.ok(src.includes('relative shrink-0 border-t border-sidebar-border'), 'footer separated by a rail border');
  assert.ok(src.includes('text-sidebar-muted hover:bg-sidebar-hover'), 'footer uses rail tokens');
  // It is the SAME ROW as the nav items above it — same inset, radius and hover, from the
  // shared constant. It used to be a full-width `rounded-lg` block with its own padding,
  // which made the one row that is always on screen the one row shaped differently.
  assert.ok(src.includes('`${RAIL_ROW} w-[calc(100%-1.25rem)]'), 'and is shaped like every other rail row');
  // The BRAND block above, by contrast, has no rule under it: a hairline there cut the
  // rail into two panels and made the first section heading look like another list's.
  const brand = src.slice(src.indexOf('function Brand('), src.indexOf('function Brand(') + 1200);
  assert.equal(/border-b border-sidebar-border/.test(brand), false, 'the brand carries no bottom rule');
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
  assert.equal(src.match(/bg-nav-active font-semibold text-white/g)?.length, 1, 'one active treatment in the rail');
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

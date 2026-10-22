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

test('the DARK rail is the default whenever the cookie is absent, blank or unknown', () => {
  assert.equal(DEFAULT_SIDEBAR_THEME, 'black');
  assert.equal(parseSidebarTheme(undefined), 'black');
  assert.equal(parseSidebarTheme(null), 'black');
  assert.equal(parseSidebarTheme(''), 'black');
  // A tampered or stale cookie must degrade to the default, never throw or render blank.
  assert.equal(parseSidebarTheme('BLACK'), 'black');
  assert.equal(parseSidebarTheme('dark'), 'black');
  assert.equal(parseSidebarTheme('__proto__'), 'black');
  assert.equal(parseSidebarTheme('light; rm -rf'), 'black');
  // An explicit choice of Light is still honoured.
  assert.equal(parseSidebarTheme('light'), 'light');
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

test('the dark rail is the production NEUTRAL near-black, and it overrides ONLY the rail tokens', () => {
  const css = read('app/globals.css');
  const blackStart = css.indexOf("[data-sidebar-theme='black']");
  const black = css.slice(blackStart, css.indexOf('}', blackStart));
  // Back to the production graphite on request (a cool «Noche» was tried and reverted).
  for (const [token, value] of [
    ['--sidebar-bg', '#1a1a1a'],
    ['--sidebar-border', '#272727'],
    ['--sidebar-fg', '#f7f7f7'],
    ['--sidebar-muted', '#d4d4d4'],
    ['--sidebar-section', '#9a9a9a'],
  ] as const) {
    assert.ok(black.includes(`${token}: ${value}`), `${token} is ${value}`);
  }
  // Every colour the Black rail declares is a neutral grey (R=G=B) — "black, not navy".
  for (const m of black.matchAll(/--sidebar-[a-z-]+:\s*#([0-9a-f]{6})\b/g)) {
    const [r, g, b] = [m[1].slice(0, 2), m[1].slice(2, 4), m[1].slice(4, 6)];
    assert.ok(r === g && g === b, `#${m[1]} is a neutral grey, not a tinted one`);
  }
  assert.ok(black.includes('--sidebar-hover: var(--sidebar-hover-dark)'), 'Black hover is the neutral token');
  for (const contentToken of ['--background:', '--surface:', '--foreground:', '--muted:', '--faint:', '--line:', '--brand:']) {
    assert.ok(!black.includes(contentToken), `Black does not touch ${contentToken}`);
  }
});

test('the light rail is «Claro» (proposal 1d), only in the light app, and only the rail tokens', () => {
  const css = read('app/globals.css');
  const start = css.indexOf("html:not(.dark)[data-sidebar-theme='light'] {");
  assert.ok(start > 0, 'scoped to the light app');
  const light = css.slice(start, css.indexOf('}', start));
  for (const [token, value] of [
    ['--sidebar-bg', '#f2f2f5'],
    ['--sidebar-border', '#e0e0e6'],
    ['--sidebar-fg', '#111113'],
    ['--sidebar-muted', '#3a3a3c'],
    ['--sidebar-sub', '#6e6e73'],
  ] as const) {
    assert.ok(light.includes(`${token}: ${value}`), `${token} is ${value}`);
  }
  for (const contentToken of ['--background:', '--surface:', '--foreground:', '--muted:', '--line:', '--brand:']) {
    assert.ok(!light.includes(contentToken), `Claro does not touch ${contentToken}`);
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

test('a DARK rail hovers on its own ground — hover is a ground change, never a second red', () => {
  const css = read('app/globals.css');
  // Red marks the current page only; hover is a change of GROUND (the Noche field tone)
  // and the hovered label lifts to --sidebar-fg.
  assert.ok(css.includes('--sidebar-hover-dark: #242424'), 'the dark-rail hover is a neutral lift');
  assert.equal(/--sidebar-hover-red\s*:/.test(css), false, 'no token still claims to be red');
  // Applied to BOTH dark rails: the app's dark theme and the Black preference.
  const darkHover = css.slice(css.indexOf('.dark {\n  --sidebar-hover'));
  assert.ok(darkHover.startsWith('.dark {\n  --sidebar-hover: var(--sidebar-hover-dark);'), 'dark app theme hovers on the dark token');
  const black = css.slice(css.indexOf("[data-sidebar-theme='black']"), css.indexOf('--sidebar-hover-dark:'));
  assert.ok(black.includes('--sidebar-hover: var(--sidebar-hover-dark)'), 'the Black rail hovers on the dark token');
  // A LIGHT rail keeps a grey lift.
  const root = css.slice(css.indexOf('--sidebar-bg: var(--sidebar)'), css.indexOf("[data-sidebar-theme='black']"));
  assert.ok(root.includes('--sidebar-hover: var(--subtle)'), 'the light rail keeps a neutral hover');
  // The ONE red in the rail is the active fill, and hover is nowhere near it.
  assert.ok(css.includes('--nav-active: #e60a2f'), 'the active fill is the only red');
});

test('both rails keep the solid red pill with white text, and the brand in the rail foreground', () => {
  const src = read('components/AppSidebar.tsx');
  // The active treatment is theme-independent (--nav-active is NOT a sidebar token), so it
  // stays the same solid red on the dark rail and on Claro; icons inherit currentColor.
  assert.ok(read('components/railRow.ts').includes('"bg-nav-active font-semibold text-white"'), 'active row: solid red + white');
  assert.ok(read('app/globals.css').includes('--nav-active: #e60a2f'), 'the spec accent, fixed in both modes');
  assert.ok(src.includes('stroke="currentColor"'), 'icons inherit the row colour');
  assert.ok(src.includes('tracking-tight text-sidebar-fg">MONTSERRAT_AI'), 'the wordmark uses the rail foreground');
});

test('the account footer sits on the rail background, as one continuous ground', () => {
  const src = read('components/AppSidebar.tsx');
  // The proposal: no box and no rule — the footer is on the rail's own ground.
  assert.ok(!/relative shrink-0 border-t border-sidebar-border/.test(src), 'no rule above the footer');
  assert.ok(src.includes('text-sidebar-muted hover:bg-sidebar-hover'), 'footer uses rail tokens');
  // It is the SAME ROW as the nav items above it — same inset, radius and hover.
  assert.ok(src.includes('`${RAIL_ROW} w-[calc(100%-1.25rem)]'), 'and is shaped like every other rail row');
  // The BRAND block above has no rule under it either.
  const brand = src.slice(src.indexOf('function Brand('), src.indexOf('function Brand(') + 1200);
  assert.equal(/border-b border-sidebar-border/.test(brand), false, 'the brand carries no bottom rule');
  assert.ok(src.includes('bg-sidebar-bg'), 'the rail (and therefore the footer) is one surface');
});

test('the appearance change did not alter navigation, gating or permissions', () => {
  const src = read('components/AppSidebar.tsx');
  // The gates now live in the one section model (lib/sectionNav.ts, proven by
  // sectionNav.test.ts) — the appearance code holds none of its own.
  const model = read('lib/sectionNav.ts');
  assert.ok(src.includes('buildSections({'), 'the rail is built from the section model');
  // Module gates.
  assert.ok(model.includes('p("inbox.view") && has("inbox")'), 'Inbox still module-gated');
  assert.ok(model.includes('p("contacts.view") && has("crm")'), 'CRM still module-gated');
  assert.ok(model.includes('has("scheduling") && { id: "calendar"'), 'Scheduling still module-gated');
  // Role gates (client roles): client-admin items behind manage; Módulos stays agency-
  // only; general surfaces behind general (staff excluded).
  // Permission gates (roles v1): every page reads the permission its own server gate checks.
  assert.ok(model.includes('const p = (key: string) => forOwnClient && permissions.includes(key);'), 'pages gated by the login\'s permissions on its own client');
  assert.ok(model.includes('const sched = (key: string) => p(key) && has("scheduling") && !isDefault;'), 'scheduling settings: permission + module + non-default');
  assert.ok(model.includes('isAgency && !isDefault && { id: "modules"'), 'the default client still hides agency-only Modules');
  assert.ok(src.includes('countEndpoint: sec.id === "inbox" ? `/api/inbox/${clientId}/pending-count` : undefined'), 'the real badge endpoint is intact');
  // And exactly one active treatment still exists.
  assert.equal(src.match(/item\.active \? RAIL_ACTIVE : RAIL_IDLE/g)?.length, 1, 'one active treatment in the rail');
});

test('the repaint kept the stored cookie VALUE, so saved preferences still resolve', () => {
  // The palette was repainted (navy, then neutral near-black, labelled "Dark"), but the
  // stored value is still `black`. Renaming it would have made every previously-saved
  // cookie unknown, silently bouncing those users to the default.
  assert.equal(parseSidebarTheme('black'), 'black');
  assert.ok(sidebarThemeCookie('black').startsWith('sidebar-theme=black'));
  assert.equal(SIDEBAR_THEME_LABELS.black, 'Dark', 'the label is decoupled from the value');
  assert.equal(SIDEBAR_THEME_LABELS.light, 'Light');
  const menu = read('components/AccountMenu.tsx');
  assert.ok(menu.includes('{SIDEBAR_THEME_LABELS[opt]}'), 'the menu renders the label, not the raw value');
});

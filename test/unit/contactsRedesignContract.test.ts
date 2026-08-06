import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * SOURCE-LEVEL CONTRACT TESTS for the Contacts / Contact-record / Inbox VISUAL
 * redesign (no HTTP, no DB, no React render) — the same technique the existing
 * nav/workspace contracts use, and for the same reason: these surfaces are client
 * components + `server-only` pages that can't be invoked from the root runner.
 *
 * The point of THIS file is that the redesign was supposed to change how things
 * LOOK and nothing else. So it guards the behaviour a restyle can silently break:
 * the facets stay URL-driven, `from` survives, the keyset cursor is reset (not
 * carried) when filters change, Columns stays presentational, the inbox keeps
 * `?c=` + the workflow scope, and light/dark share one structure.
 */

const web = fileURLToPath(new URL('../../web/', import.meta.url));
const read = (rel: string): string => readFileSync(`${web}${rel}`, 'utf8');
/** Drop /* … *​/ and // comments, so "counts exactly once" assertions can't be
 *  satisfied (or broken) by prose that merely NAMES the thing. */
const stripComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const CONTACTS_PAGE = 'app/clients/[clientId]/contacts/page.tsx';
const TOOLBAR = 'components/contacts/ContactsToolbar.tsx';
const RECORD = 'components/contacts/ContactRecord.tsx';
const WORKSPACE = 'components/ClientInboxWorkspace.tsx';
const SIDEBAR = 'components/AppSidebar.tsx';

// ───────────────────────────── Shell / sidebar ──────────────────────────────

test('sidebar: exactly ONE active treatment, and it is the solid brand fill', () => {
  const src = read(SIDEBAR);
  // The active row is the single strongest mark in the shell.
  assert.ok(src.includes('bg-nav-active font-medium text-white'), 'active row uses the fixed solid red');
  // Activity is always derived from the pathname — never from a second source that
  // could light up two rows at once.
  assert.ok(src.includes('active: pathname.startsWith('), 'active state derives from the pathname');
  // The badge-bearing Inbox item must use the SAME active treatment, or two rows
  // could render as "current" in different styles.
  const tab = read('components/InboxTabLink.tsx');
  assert.ok(tab.includes('bg-nav-active font-medium text-white'), 'the Inbox item shares the active treatment');
});

test('sidebar: the Inbox badge is fed by the REAL pending-count endpoint', () => {
  const src = read(SIDEBAR);
  assert.ok(src.includes('countEndpoint: `/api/inbox/${clientId}/pending-count`'), 'real count endpoint');
  const tab = read('components/InboxTabLink.tsx');
  assert.ok(tab.includes('payload.pendingCount'), 'the badge renders the served count, not a placeholder');
});

test('sidebar: CRM is its own module-gated section — Contacts is NOT under Scheduling', () => {
  const src = read(SIDEBAR);
  const crm = src.indexOf('label: "CRM"');
  const scheduling = src.indexOf('label: "Scheduling"');
  assert.ok(crm > 0 && scheduling > crm, 'CRM is a separate section, before Scheduling');
  assert.ok(src.includes('moduleKeys.includes("crm")'), 'CRM only renders when the module is enabled');
});

test('shell: chrome geometry is fixed px, so it does not ride the 90% rem scale', () => {
  const css = read('app/globals.css');
  // These are chrome dimensions, not content. Expressed in rem they would silently
  // shrink with the global scale (a 236px rail rendering at ~212px).
  for (const [token, value] of [
    ['--sidebar-width', '238px'],
    ['--topbar-height', '54px'],
    ['--content-pad', '16px'],
    ['--panel-pad', '16px'],
    ['--control-h', '38px'],
    ['--row-h', '41px'],
  ] as const) {
    assert.ok(css.includes(`${token}: ${value}`), `${token} is ${value}`);
  }
  assert.ok(/html\s*{\s*font-size:\s*90%/.test(css), 'content still scales at 90%');
  // Radius is retuned once, at the scale — not with per-component overrides.
  // Softened one step from the original 3-6px spec — still a tight, tool-like
  // scale, tuned once here rather than per component.
  assert.ok(css.includes('--radius-lg: 8px'), 'the panel radius is 8px, not 10-12px');
  assert.ok(css.includes('--radius-md: 6px') && css.includes('--radius-sm: 4px'), 'the scale is 4-8px');
});

test('shell: the four header strips all resolve to the SAME height token', () => {
  const strips = [
    ['components/HeaderBar.tsx', 'the app topbar'],
    ['components/AppSidebar.tsx', "the rail's brand block"],
    ['components/ClientInboxWorkspace.tsx', 'the inbox queue header'],
    ['components/CustomerDetailsPanel.tsx', 'the customer panel header'],
  ] as const;
  for (const [rel, what] of strips) {
    assert.ok(read(rel).includes('h-[var(--topbar-height)]'), `${what} uses the shared height`);
  }
  // The thread header is min-height (its content can wrap) but shares the token.
  assert.ok(read('components/InboxThread.tsx').includes('min-h-[var(--topbar-height)]'), 'the thread header too');
});

test('sidebar: the footer row is a GRID, so the label cannot overlap the avatar', () => {
  const src = read('components/AppSidebar.tsx');
  // The earlier min-w-0/overflow-hidden fix only governed truncation on the RIGHT;
  // it could not stop the label from starting on top of the avatar. Grid tracks
  // cannot overlap: track 2 begins after the avatar's track plus the gap.
  assert.ok(src.includes('grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2.5'), 'two real tracks with a gap');
  // minmax(0,1fr) is what still allows the label to shrink and truncate.
  assert.ok(src.includes('minmax(0,1fr)'), 'the label track can shrink below its content');
  assert.ok(src.includes('truncate text-sm font-medium text-sidebar-fg'), 'long names still truncate on the right');
  // The avatar must not pick up the RED hover token as its fill.
  assert.ok(!/bg-sidebar-hover text-xs font-semibold/.test(src), 'the avatar is not filled with the hover red');
  assert.ok(src.includes('bg-sidebar-border text-xs font-semibold'), 'it uses the neutral rail border tone');
});

test('contacts: the panel gutter is actually VISIBLE against the canvas', () => {
  const css = read('app/globals.css');
  // The margin existed before but #f8f9fb vs #ffffff is ~2.7%/channel — invisible,
  // so the card read as full-bleed. The canvas is now a genuinely distinguishable grey.
  assert.ok(css.includes('--background: #eff1f5'), 'the canvas is distinguishable from the panel');
  assert.ok(css.includes('--surface: #ffffff'), 'the panel stays white');
  assert.ok(css.includes('--content-pad: 16px'), 'and the gutter is wide enough to read');
  // The gutter is the LAYOUT's (see the dedicated test); the page only supplies the
  // card's own radius + hairline.
  assert.ok(
    read('app/layout.tsx').includes('overflow-y-auto p-[var(--content-pad)]'),
    'the shell pads on all four sides',
  );
  assert.ok(read(CONTACTS_PAGE).includes('rounded-lg border border-line bg-surface'), 'the card has its own radius + hairline');
});

test('sidebar: the footer labels the person, not a truncated email', () => {
  const src = read('components/AppSidebar.tsx');
  assert.ok(src.includes('const label = account.name?.trim() || account.email;'), 'name is the primary label…');
  assert.ok(src.includes('{label}</span>'), '…and it is what renders');
  assert.ok(src.includes('title={account.email}'), 'the email survives as the tooltip');
  // The server actually supplies it.
  assert.ok(read('components/AppSidebarServer.tsx').includes('name={name}'), 'the server passes the display name');
});

// ──────────────────────────── Contacts list ─────────────────────────────────

test('shell: the GUTTER is owned by the layout, not by each page', () => {
  // Three rounds of "the card looks full-bleed" traced back to the gutter being a
  // per-page responsibility: any page that set its own width/height could cancel it
  // and every new page had to remember it. The scroll container owns it now.
  const layout = read('app/layout.tsx');
  assert.ok(
    layout.includes('flex min-w-0 min-h-0 flex-1 flex-col overflow-y-auto p-[var(--content-pad)]'),
    'the shell scroll container pads the content on all four sides',
  );
  // …and the pages must NOT pad again, or the gutter doubles.
  // NB: a plain substring test would also match the "p-" inside
  // "gap-[var(--content-pad)]", so anchor on a class boundary.
  const padsItself = /(^|[\s"'`])p-\[var\(--content-pad\)\]/;
  for (const rel of [CONTACTS_PAGE, 'app/clients/[clientId]/contacts/[contactId]/page.tsx', 'components/scheduling/AgendaView.tsx']) {
    assert.ok(!padsItself.test(read(rel)), `${rel} does not re-pad`);
  }
});

test('contacts: one continuous surface — summary, table and end-of-list inside it', () => {
  const src = read(CONTACTS_PAGE);
  assert.ok(
    src.includes('flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-line bg-surface'),
    'one bordered floating panel',
  );
  // The toolbar and the stats row are INSIDE the panel (it is a card, not a bare table).
  assert.ok(src.includes('<ContactsToolbar owners={ownerOptions} />'), 'the toolbar lives in the panel');
  assert.ok(src.includes('px-[var(--panel-pad)]'), 'panel rows share one inner padding token');
  assert.ok(src.includes('min-h-0 flex-1 overflow-auto'), 'the table region grows inside it');
  assert.ok(src.includes('END OF LIST'), 'the end-of-list marker lives in the same surface');
  // The page owns only the rhythm BETWEEN blocks; the gutter is the layout's.
  assert.ok(src.includes('gap-[var(--content-pad)]'), 'block rhythm is the token');
});

test('contacts: the toolbar is a single row on desktop', () => {
  const toolbar = read(TOOLBAR);
  assert.ok(toolbar.includes('lg:flex-nowrap'), 'it stops wrapping at desktop');
  assert.ok(toolbar.includes('h-[var(--control-h)]'), 'controls share the 38px height');
});

test('contacts: "New contact" is rendered but DISABLED — no creation flow backs it yet', () => {
  const src = read(CONTACTS_PAGE);
  // The design's button is present so the toolbar geometry matches, but it must not
  // pretend to work: every contact has to enter through the identity chokepoint.
  assert.ok(src.includes('New contact'), 'the button occupies its designed slot');
  const btn = src.slice(src.indexOf('function NewContactButton()'), src.indexOf('/** One "·'));
  assert.ok(btn.includes('disabled'), 'it is disabled…');
  assert.ok(btn.includes('aria-disabled="true"'), '…and says so to assistive tech');
  assert.ok(btn.includes('title="'), '…and explains why on hover');
  // The TODO lives in the component's doc comment, above the slice.
  assert.ok(src.includes('TODO(crm)'), 'and carries a TODO for the real flow');
  assert.ok(!src.includes('Import contacts'), 'import stays out entirely');
});

test('contacts: every facet is validated server-side before it reaches SQL', () => {
  const src = read(CONTACTS_PAGE);
  assert.ok(src.includes('STAGES.has(stage)'), 'stage is whitelisted');
  assert.ok(src.includes('TASK_FILTERS.has(tasks)'), 'tasks filter is whitelisted');
  assert.ok(src.includes('ownerName.has(owner)'), 'owner must be a real member of the tenant');
  assert.ok(src.includes('UNASSIGNED_OWNER'), 'the unassigned bucket is an explicit sentinel');
});

test('contacts: the list, the summary and the facets all carry the VALIDATED clientId', () => {
  const src = read(CONTACTS_PAGE);
  assert.ok(src.includes('requireClientModulePage(clientId, "crm")'), 'the crm module gate still guards the page');
  assert.ok(src.includes('clientId: client.id'), 'queries pass the validated client explicitly');
  assert.ok(src.includes('summarizeContacts(scope.tenantId, filters)'), 'the summary uses the SAME filter set as the list');
});

test('contacts: summary counters come from ONE grouped query — never an N+1', () => {
  const src = read(CONTACTS_PAGE);
  // One members query + one list query + one summary query, issued together.
  assert.ok(src.includes('Promise.all(['), 'the reads are issued as one batch');
  assert.ok(!/contacts\.map\([^)]*await/s.test(src), 'no awaited work inside the row map');
  const repo = readFileSync(fileURLToPath(new URL('../../src/db/repositories/contacts.ts', import.meta.url)), 'utf8');
  assert.ok(repo.includes('export async function summarizeContacts'), 'the summary is a repository query');
  // The open-task counts are a grouped aggregate joined once, not a per-row lookup.
  assert.ok(repo.includes('GROUP BY contact_id, client_id'), 'task counts are aggregated, then joined');
});

test('contacts: keyset pagination is untouched (cursor in, opaque cursor out)', () => {
  const src = read(CONTACTS_PAGE);
  assert.ok(src.includes('cursor: cursor || undefined'), 'the cursor is forwarded to the repository');
  assert.ok(src.includes('nextCursor ? hrefWith({ cursor: nextCursor })'), 'the next page link carries the next cursor');
  const repo = readFileSync(fileURLToPath(new URL('../../src/db/repositories/contacts.ts', import.meta.url)), 'utf8');
  assert.ok(repo.includes('ORDER BY c.last_contact_at DESC, c.id DESC'), 'the keyset ordering is unchanged');
  assert.ok(repo.includes('encodeContactCursor'), 'the cursor codec is unchanged');
});

test('contacts: `from` (the origin workflow) survives search, facets, paging and row clicks', () => {
  const src = read(CONTACTS_PAGE);
  // Every generated href merges the CURRENT params, `from` included.
  assert.ok(src.includes('{ q, from, stage, owner, tasks, cols, ...patch }'), 'hrefWith merges from');
  assert.ok(src.includes('const fromQS = from ? `?from=${encodeURIComponent(from)}` : ""'), 'from is preserved…');
  assert.ok(src.includes('`${base}/${c.id}${fromQS}`'), '…on the row link into the record');
  // The toolbar preserves whatever is in the URL rather than rebuilding it.
  const toolbar = read(TOOLBAR);
  assert.ok(toolbar.includes('new URLSearchParams(searchParams.toString())'), 'the toolbar preserves existing params');
});

test('contacts: changing a facet RESETS the keyset cursor (a stale cursor would skip rows)', () => {
  const toolbar = read(TOOLBAR);
  assert.ok(toolbar.includes('p.delete("cursor")'), 'every facet write drops the cursor');
});

test('contacts: Enter runs the search (a real form submit)', () => {
  const toolbar = read(TOOLBAR);
  assert.ok(toolbar.includes('onSubmit={'), 'the search is a form, so Enter submits');
  assert.ok(toolbar.includes('apply({ q: draft.trim() })'), 'submitting writes ?q=');
});

test('contacts: Columns is presentational — it writes ?cols= and touches nothing else', () => {
  const toolbar = read(TOOLBAR);
  // It now lives in the STATS row (it belongs to the table, not to the search), as
  // its own exported component driving the same URL param.
  assert.ok(toolbar.includes('export function ContactsColumnsMenu'), 'Columns is its own control');
  assert.ok(toolbar.includes('p.set("cols", cols.join(","))'), 'Columns only writes ?cols=');
  assert.ok(read(CONTACTS_PAGE).includes('<ContactsColumnsMenu visibleColumns={visibleColumns} />'), 'rendered in the stats row');
  const page = read(CONTACTS_PAGE);
  // `cols` must never be forwarded into a query — it is parsed for rendering only.
  assert.ok(page.includes('const visibleColumns = parseColumns(cols)'), 'cols is parsed for rendering');
  assert.ok(!/filters\s*=\s*{[^}]*cols/s.test(page), 'cols never enters the filter set');
});

test('contacts: the row is fully clickable via ONE real link (no duplicate tab stops)', () => {
  const src = read(CONTACTS_PAGE);
  assert.ok(src.includes('after:absolute after:inset-0'), 'the name link stretches over the row');
  assert.ok(src.includes('className={`relative h-[var(--row-h)] border-b'), 'the row is the positioning context');
  // Underline is a hover/focus affordance only — never a permanent decoration.
  assert.ok(src.includes('no-underline'), 'the name link is not permanently underlined');
  assert.ok(src.includes('hover:underline focus-visible:underline'), '…but underlines on hover AND focus');
});

test('contacts: a number without a name shows the phone AND an explicit "no name"', () => {
  const src = read(CONTACTS_PAGE);
  assert.ok(src.includes('c.name?.trim() || c.channel_user_id'), 'falls back to the channel identifier');
  assert.ok(src.includes('<Meta>no name</Meta>'), 'and says so, rather than rendering a blank cell');
});

test('contacts: an overdue row is marked by SHAPE + color, not color alone', () => {
  const src = read(CONTACTS_PAGE);
  assert.ok(src.includes('u-row-danger'), 'the row carries the overdue treatment');
  assert.ok(src.includes('OVERDUE'), 'and a text chip, so the state survives grayscale');
  const css = read('app/globals.css');
  // Pink wash + a 3px BRAND-RED left bar. Distinct from .u-row-overdue, which is the
  // inbox's amber "needs a human" state — attention-worthy but not late.
  assert.ok(/\.u-row-danger[^}]*box-shadow:\s*inset 3px 0 0 0 var\(--brand-rule\)/s.test(css), '3px red left bar');
  assert.ok(/\.u-row-danger[^}]*var\(--brand\) 6%/s.test(css), 'pink wash from the brand');
});

test('contacts: loading / empty / error states exist and the empty state can clear filters', () => {
  const src = read(CONTACTS_PAGE);
  assert.ok(src.includes('No contacts match these filters.'), 'filtered-empty is distinct…');
  assert.ok(src.includes('No contacts yet.'), '…from genuinely-empty');
  assert.ok(src.includes('Clear filters'), 'the filtered-empty state offers a way out');
});

// ─────────────────────────── Contact record ─────────────────────────────────

test('record: the three-region model survives the restyle', () => {
  const src = read(RECORD);
  assert.ok(src.includes('<ContactProperties'), 'left: identity + properties + custom fields');
  assert.ok(src.includes('<ContactTimeline'), 'center: the timeline');
  assert.ok(src.includes('<ContactAssociations'), 'right: appointments + tasks + tags');
  assert.ok(src.includes('xl:grid-cols-['), 'three columns at wide viewports, stacked below');
});

test('record: the compact header carries identity + the operative facts + both actions', () => {
  const src = read(RECORD);
  for (const needle of ['summary.displayName', '<StageChip', 'Source', 'Owner', 'Visits', 'No-shows']) {
    assert.ok(src.includes(needle), `header shows ${needle}`);
  }
  assert.ok(src.includes('Open conversation'), 'Open conversation is present');
  assert.ok(src.includes('Book appointment'), 'Book appointment is present');
});

test('record: the primary actions exist EXACTLY once (they moved out of the rail)', () => {
  const rail = read('components/contacts/ContactAssociations.tsx');
  assert.ok(!rail.includes('Open conversation'), 'the rail no longer duplicates Open conversation');
  assert.ok(!rail.includes('Book appointment'), 'the rail no longer duplicates Book appointment');
  // Count RENDERED occurrences only — the file's own doc comment names both actions.
  const record = stripComments(read(RECORD));
  assert.equal(record.match(/Open conversation/g)?.length, 1, 'exactly one Open conversation');
  assert.equal(record.match(/Book appointment/g)?.length, 1, 'exactly one Book appointment');
});

test('record: scheduling actions stay behind the module gate', () => {
  const src = read(RECORD);
  assert.ok(src.includes('schedulingEnabled ? ('), 'Book appointment renders only when scheduling is enabled');
});

// ───────────────────────────────── Inbox ────────────────────────────────────

test('inbox: the restyle preserved ?c=, the workflow scope, search and polling', () => {
  const src = read(WORKSPACE);
  assert.ok(src.includes('searchParams.get("c")'), 'selection still reads ?c=');
  assert.ok(src.includes('p.set("c", id)'), 'selecting still sets ?c= …');
  assert.ok(src.includes('searchParams.toString()'), '… preserving the other params');
  assert.ok(src.includes('No in-panel workflow selector'), 'the header remains the single workflow selector');
  assert.ok(src.includes('POLL_MS'), 'polling is intact');
  assert.ok(src.includes('Reconnecting…'), 'the stale/reconnecting state is intact');
});

test('inbox: three columns + the details collapse and drawer are intact', () => {
  const src = read(WORKSPACE);
  assert.ok(src.includes('aria-label="Conversations"'), 'left list column');
  assert.ok(src.includes('aria-label="Conversation"'), 'center chat column');
  assert.ok(src.includes('aria-label="Customer details"'), 'right details column/drawer');
  assert.ok(src.includes('setDetailsInline'), 'desktop collapse');
  assert.ok(src.includes('setDetailsDrawer'), 'tablet/mobile drawer');
});

test('inbox: the real groups and the real pending count still drive the queue', () => {
  const src = read(WORKSPACE);
  assert.ok(src.includes('groupConversations('), 'grouping comes from the pure state mapping');
  assert.ok(src.includes('pendingCount('), 'the counter is computed from the real list');
  assert.ok(src.includes('{pending} pending'), 'and is rendered');
});

test('inbox: the selected row is marked by a soft fill AND a left rule', () => {
  const src = read(WORKSPACE);
  assert.ok(src.includes('u-row-selected'), 'selection uses the shared treatment');
  const css = read('app/globals.css');
  assert.ok(/\.u-row-selected[^}]*box-shadow:\s*inset 2px 0/s.test(css), 'which includes the 2px left rule');
});

test('inbox: customer / bot / human-agent messages stay visually distinct', () => {
  const src = read('components/MessageTranscript.tsx');
  assert.ok(src.includes('const isUser = msg.sender === "user"'), 'customer is identified');
  assert.ok(src.includes('const isAgent = msg.sender === "human_agent"'), 'the human agent is identified');
  // Three different fills — a light → mid → dark ramp, no hue spent.
  assert.ok(src.includes('border border-bubble-in-border bg-bubble-in text-bubble-in-fg'), 'customer bubble');
  assert.ok(src.includes('bg-bubble-agent text-bubble-agent-fg'), 'human-agent bubble (the brand red)');
  assert.ok(src.includes('border border-bubble-bot-border bg-bubble-bot text-bubble-bot-fg'), 'bot bubble');
  // A FAILED agent send must not be mistaken for a normal one now that both are red:
  // normal is the SOLID fill, failed is OUTLINED.
  assert.ok(src.includes('border border-danger bg-danger/12 text-danger'), 'failed is outlined, not solid');
});

test('inbox: the bot fill is clearly separated from the canvas in BOTH themes', () => {
  const css = read('app/globals.css');
  // At --subtle the bot bubble sat within ~2% lightness of the thread background and
  // effectively vanished in light mode; it now has its own token, well below the canvas.
  assert.ok(/--bubble-in:\s*#eef0f3/.test(css), 'light inbound is cool light grey');
  assert.ok(/--bubble-bot:\s*#dcdfe5/.test(css), 'light bot is a darker step of the same grey');
  assert.ok(/--bubble-in:\s*#1a1c20/.test(css), 'dark inbound');
  assert.ok(/--bubble-bot:\s*#26292f/.test(css), 'dark bot');
  assert.ok(css.includes('--color-bubble-bot: var(--bubble-bot)'), 'exposed as a utility');
  // Inbound and bot must not collapse into the same fill in either theme.
  assert.notEqual('#eef0f3', '#dcdfe5');
  assert.notEqual('#1a1c20', '#26292f');
  // The agent's red is the SAME red as the rail's active mark, in both themes.
  assert.equal(css.match(/--bubble-agent:\s*#e60a2f/g)?.length, 2, 'one agent red, light + dark');
  assert.ok(/--nav-active:\s*#e60a2f/.test(css), 'and it matches the nav active red (spec accent)');
  // No BUBBLE may use green — that hue is reserved for success/positive state (the
  // "Active" pill and the assigned-agent dot legitimately keep it, via --success).
  const transcript = read('components/MessageTranscript.tsx');
  assert.ok(!/emerald|green-\d/.test(transcript), 'the live transcript spends no hue on senders');
  const history = read('components/InboxThread.tsx');
  assert.ok(!/bg-emerald/.test(history), 'the reconstructed history no longer paints the bot green');
  assert.ok(history.includes('bg-bubble-bot'), 'it shares the live bot treatment instead');
});

test('inbox: no function crosses the server→client boundary', () => {
  const page = read('app/clients/[clientId]/inbox/page.tsx');
  // The server page passes data + scalars only; callbacks are created INSIDE the
  // client component. A function prop here would break serialization at runtime.
  assert.ok(!/\bon[A-Z]\w*=\{/.test(page), 'the server page passes no function props');
  assert.ok(page.includes('viewerIsFullAccess={hasFullAccess(scope)}'), 'permissions cross as a boolean');
});

// ───────────────────────── Light / dark parity ──────────────────────────────

test('theme: light and dark are the SAME structure — tokens flip, markup does not', () => {
  const css = read('app/globals.css');
  // Every color the redesign uses is a semantic token defined in BOTH themes.
  const root = css.slice(css.indexOf(':root {'), css.indexOf('.dark {'));
  const dark = css.slice(css.indexOf('.dark {'), css.indexOf('@theme inline {'));
  for (const token of ['--background', '--surface', '--sidebar', '--brand', '--brand-soft', '--warn', '--foreground', '--muted', '--faint']) {
    assert.ok(root.includes(`${token}:`), `${token} has a light value`);
    assert.ok(dark.includes(`${token}:`), `${token} has a dark value`);
  }
  // The redesigned surfaces must not branch their LAYOUT on the theme.
  for (const rel of [CONTACTS_PAGE, RECORD, WORKSPACE, TOOLBAR]) {
    const src = read(rel);
    const structural = src.match(/dark:(?:flex|grid|hidden|block|w-|h-|p-|m-|gap-|col-|order-)/g);
    assert.equal(structural, null, `${rel} has no dark-only structural classes`);
  }
});

test('theme: the dark sidebar is layered against the content canvas, not lighter than it', () => {
  const css = read('app/globals.css');
  const dark = css.slice(css.indexOf('.dark {'), css.indexOf('@theme inline {'));
  // Spec: sidebar slightly DARKER than the content; surfaces raised by contrast.
  assert.ok(/--sidebar:\s*#0a0a0b/.test(dark), 'the dark sidebar is the darkest layer');
  assert.ok(/--background:\s*#101012/.test(dark), 'the content canvas sits above it');
  assert.ok(/--surface:\s*#171719/.test(dark), 'panels are raised above the canvas');
});

test('theme: no gradients, no glassmorphism, and no shadows on the redesigned surfaces', () => {
  for (const rel of [CONTACTS_PAGE, RECORD, WORKSPACE, TOOLBAR, 'components/ui/primitives.tsx']) {
    const src = read(rel);
    assert.ok(!src.includes('bg-gradient'), `${rel} uses no gradient`);
    assert.ok(!/backdrop-blur-(?!none)/.test(src), `${rel} uses no glassmorphism`);
    assert.ok(!/\bshadow-(sm|md|lg|xl)\b/.test(src), `${rel} uses no drop shadows`);
  }
});

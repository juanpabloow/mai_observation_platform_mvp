import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
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
/** Every .tsx under web/, so a "defined exactly once" assertion can look everywhere
 *  rather than at the handful of files someone remembered to list. */
const allTsx = (dir = ''): string[] =>
  readdirSync(`${web}${dir}`, { withFileTypes: true }).flatMap((e) => {
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.name === 'node_modules' || e.name === '.next') return [];
    if (statSync(`${web}${rel}`).isDirectory()) return allTsx(rel);
    return rel.endsWith('.tsx') ? [rel] : [];
  });

const CONTACTS_PAGE = 'app/clients/[clientId]/contacts/page.tsx';
const TOOLBAR = 'components/contacts/ContactsToolbar.tsx';
const RECORD = 'components/contacts/ContactRecord.tsx';
const WORKSPACE = 'components/ClientInboxWorkspace.tsx';
const SIDEBAR = 'components/AppSidebar.tsx';

// ───────────────────────────── Shell / sidebar ──────────────────────────────

test('sidebar: exactly ONE active treatment, and it is the solid brand fill', () => {
  const src = read(SIDEBAR);
  // The active row is the single strongest mark in the shell.
  assert.ok(src.includes('bg-nav-active font-semibold text-white'), 'active row uses the fixed solid red');
  // Activity is always derived from the pathname — never from a second source that
  // could light up two rows at once.
  assert.ok(src.includes('active: pathname.startsWith('), 'active state derives from the pathname');
  // The badge-bearing Inbox item must use the SAME active treatment, or two rows
  // could render as "current" in different styles.
  const tab = read('components/InboxTabLink.tsx');
  assert.ok(tab.includes('bg-nav-active font-semibold text-white'), 'the Inbox item shares the active treatment');
  // …and the same GEOMETRY. The two are separate components, so the row height is the
  // thing that silently drifts: the Inbox row stayed 40px tall for one commit while its
  // neighbours went to the design's 32px, which is visible as a single loose row.
  // …and the same GEOMETRY, from ONE constant rather than three class strings. The row
  // height is what drifts silently when each component spells it out: one of them sat at
  // 40px for a commit while the others went to 32, which reads as a single loose row.
  assert.ok(src.includes('${RAIL_ROW}') && tab.includes('${RAIL_ROW}'), 'both read the shared row constant');
  const rail = read('components/railRow.ts');
  assert.ok(rail.includes('export const RAIL_ROW'), 'which is declared in one place');
  // Its own module, because AppSidebar imports InboxTabLink — exporting it from there and
  // importing it back would be a cycle.
  assert.equal(/import .*InboxTabLink/.test(rail), false, 'and that place has no rail imports of its own');
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
    ['--topbar-height', '44px'],
    ['--content-pad', '16px'],
    ['--panel-pad', '16px'],
    ['--control-h', '38px'],
    ['--row-h', '41px'],
  ] as const) {
    assert.ok(css.includes(`${token}: ${value}`), `${token} is ${value}`);
  }
  // The root scale is a PREFERENCE now (lib/textScale.ts), not a constant: 100% by
  // default, with the original 90% kept as "Compact". The point of the assertion
  // stands — chrome is px and does not ride it, content is rem and does.
  assert.ok(/html\s*{\s*font-size:\s*100%/.test(css), 'content scales from the root…');
  assert.ok(/html\[data-text-scale='compact'\]\s*{\s*font-size:\s*90%/.test(css), '…and Compact is the old density');
  // Radius is retuned once, at the scale — not with per-component overrides.
  //
  // Re-tuned again by the CRM/Inbox rework (docs/ui-redesign-crm-inbox.md §1): the
  // artboard is deliberately NOT on one radius, it steps by the SIZE of the object —
  // a 14px card, an 11px control, a 9px chip, a 7px badge. The assertion that matters
  // is that the steps are ordered and declared here rather than sprinkled per
  // component, so this checks the ladder, not one value.
  const radius = (name: string): number => {
    const m = new RegExp(`--radius-${name}:\\s*(\\d+)px`).exec(css);
    assert.ok(m, `--radius-${name} is declared at the scale`);
    return Number(m![1]);
  };
  const [sm, md, lg, xl] = [radius('sm'), radius('md'), radius('lg'), radius('xl')];
  assert.ok(sm < md && md < lg && lg < xl, `the ladder ascends: ${sm} < ${md} < ${lg} < ${xl}`);
  assert.equal(xl, 14, 'THE card radius is the artboard\'s 14px');
  assert.equal(lg, 11, 'a control is 11px');
  assert.equal(md, 9, 'a chip is 9px');
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
  // And every screen that has a TITLE BAND is titled by the one band, at one size.
  for (const rel of ['components/scheduling/AgendaView.tsx', 'components/ClientInboxWorkspace.tsx']) {
    assert.ok(read(rel).includes('<PageTitle'), `${rel} uses the shared page title`);
  }
  // Contacts is the exception, and deliberately so (docs/ui-redesign-crm-inbox.md §2.1):
  // its title row is ONE line holding the title, the search field, the two data actions
  // and the primary — a shape PageTitle cannot express, since PageTitle's contract is
  // "a title, counters, and a right-aligned scope line". What must still hold is the
  // SIZE, so the screen's name is the same weight as every other screen's.
  const contactsPage = read('app/clients/[clientId]/contacts/page.tsx');
  assert.ok(
    /<h1[^>]*text-\[15px\][^>]*font-semibold/.test(contactsPage.replace(/\s+/g, ' ')),
    'contacts titles itself at the shared size even though it does not use PageTitle',
  );
});

test('sidebar: the footer row is a GRID, so the label cannot overlap the avatar', () => {
  const src = read('components/AppSidebar.tsx');
  // The earlier min-w-0/overflow-hidden fix only governed truncation on the RIGHT;
  // it could not stop the label from starting on top of the avatar. Grid tracks
  // cannot overlap: track 2 begins after the avatar's track plus the gap.
  assert.ok(src.includes('grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3'), 'two real tracks with a gap');
  // minmax(0,1fr) is what still allows the label to shrink and truncate.
  assert.ok(src.includes('minmax(0,1fr)'), 'the label track can shrink below its content');
  assert.ok(src.includes('truncate text-[0.8125rem] font-medium leading-tight text-sidebar-fg'), 'long names still truncate on the right');
  // The avatar must not pick up the RED hover token as its fill.
  assert.ok(!/bg-sidebar-hover text-xs font-semibold/.test(src), 'the avatar is not filled with the hover red');
  // It is now the SAME two-tone gradient sphere every other person in the app gets
  // (`.u-avatar-*`), seeded from the account's own identifier. It used to be a flat
  // --sidebar-border fill, which made the one person always on screen the only person
  // without an identity colour.
  assert.ok(src.includes('avatarColor(seed)'), 'the rail disc is coloured from the shared avatar hash');
  assert.ok(src.includes('seed={account.email}'), 'seeded on the email, which cannot be edited away');
});

test('contacts: the panel gutter is actually VISIBLE against the canvas', () => {
  const css = read('app/globals.css');
  // The margin existed before but #f8f9fb vs #ffffff is ~2.7%/channel — invisible,
  // so the card read as full-bleed. The canvas is now a genuinely distinguishable grey.
  assert.ok(css.includes('--background: #eff0f3'), 'the canvas is distinguishable from the panel');
  assert.ok(css.includes('--surface: #ffffff'), 'the panel stays white');
  assert.ok(css.includes('--content-pad: 16px'), 'and the gutter is wide enough to read');
  // The gutter is the LAYOUT's (see the dedicated test); the page only supplies the
  // card's own radius + hairline.
  assert.ok(
    read('app/layout.tsx').includes('overflow-y-auto p-[var(--content-pad)]'),
    'the shell pads on all four sides',
  );
  // The card's radius + hairline now come from the SHARED page shell, not from a
  // class string copied into this page (that duplication is exactly why the
  // floating-card look kept landing on some screens and not others).
  assert.ok(/<PageShell\b/.test(read(CONTACTS_PAGE)), 'the page renders the shared shell');
  assert.ok(
    read('components/ui/PageShell.tsx').includes('rounded-xl border border-line bg-surface'),
    'the shell has the radius + hairline + fill',
  );
});

test('page shell: ONE component owns the floating card, and all three screens use it', () => {
  const shell = read('components/ui/PageShell.tsx');
  // The full contract, in two halves.
  // REGION (both surfaces): the height chain that lets it grow to the bottom of the
  // scrolling region. Screens that float several cards of their own opt out of the
  // card chrome with surface="canvas", but never out of this.
  assert.ok(shell.includes('flex min-h-0 min-w-0'), 'it is a flex column that can shrink');
  assert.ok(shell.includes('grow ? "flex-1" : "shrink-0"'), 'and fills the region unless the page stacks several cards');
  // CARD (the default surface): fill + hairline + radius, clipping children to the
  // rounded corners.
  // The clip is now conditional (a card hosting a dropdown opts out), so the assertion
  // is on the pieces plus the fact that clipping is still what you get by default.
  assert.ok(shell.includes('rounded-xl border border-line bg-surface'), 'the default surface is a card: fill + hairline + radius');
  assert.ok(shell.includes('clip = true') && /clip \? "overflow-hidden"/.test(shell), 'and it clips its children unless told not to');
  assert.ok(shell.includes('surface === "card"'), 'the card chrome is what the surface prop switches');
  for (const f of [CONTACTS_PAGE, 'components/scheduling/AgendaView.tsx', 'components/ClientInboxWorkspace.tsx']) {
    assert.ok(read(f).includes('from "@/components/ui/PageShell"'), `${f} imports the shared shell`);
    assert.ok(read(f).includes('<PageShell'), `${f} renders it`);
  }
  // And nobody hand-rolls the old string any more.
  for (const f of [CONTACTS_PAGE, 'components/scheduling/AgendaView.tsx', 'components/ClientInboxWorkspace.tsx']) {
    assert.ok(
      !read(f).includes('flex-col overflow-hidden rounded-lg border border-line bg-surface'),
      `${f} no longer copies the panel classes`,
    );
  }
});

test('sidebar: the footer labels the person, not a truncated email', () => {
  const src = read('components/AppSidebar.tsx');
  assert.ok(src.includes('const label = account.name?.trim() || account.email;'), 'name is the primary label…');
  assert.ok(src.includes('{label}</span>'), '…and it is what renders');
  assert.ok(src.includes('title={account.email}'), 'the email survives as the tooltip');
  // The server actually supplies it.
  assert.ok(read('components/AppSidebarServer.tsx').includes('name={name}'), 'the server passes the display name');
});

/** The table's own component. The rework moved the rows out of the page (§2.3) — the
 *  design's row is a 7-track GRID with three two-line cells, which a `<table>` cannot
 *  lay out to fixed proportions. */
const CONTACTS_TABLE = 'components/contacts/ContactsTable.tsx';

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

test('contacts: ONE card holds the screen, with the table recessed inside it', () => {
  const src = read(CONTACTS_PAGE);
  // THREE cards on the canvas: title+filters, table, panel. The first sizes to its
  // content (grow={false}); only the table absorbs the leftover height.
  assert.ok(/<PageShell grow=\{false\}( clip=\{false\})?>/.test(src), 'the title card sizes to its content');
  // The rework split the old single toolbar into three places (§2.1–2.2): the SEARCH is
  // in the title row, the common facets are a server-rendered pill row inside the table
  // card, and what is left sits behind Filtrar / Orden / Columnas beside the pills.
  assert.ok(src.includes('<ContactsSearch />'), 'the search renders in the title row');
  assert.ok(src.includes('<FacetPills'), 'the facet pills render');
  assert.ok(src.includes('<ContactsFilterMenu owners={ownerOptions} />'), 'the residual facets render');
  assert.ok(
    src.indexOf('<PageShell grow={false}') < src.indexOf('<ContactsSearch />'),
    'and the title row is inside that first card, not floating above it',
  );
  assert.equal((src.match(/<PageShell/g) ?? []).length, 2, 'title and table are two separate cards');
  // The table is its own card DIRECTLY on the canvas — no card-inside-a-card, which is
  // what the three-box layout replaced (a recessed grey ground inside a white shell).
  assert.equal(/bg-background p-3/.test(src), false, 'the table is not recessed inside another card');
  assert.ok(src.includes('min-h-0 flex-1 overflow-auto'), 'the table region grows inside its card');
  // The end-of-list marker became a PAGER (§2.4): page numbers instead of "load more",
  // and a range line that names the whole filtered set.
  assert.ok(src.includes('Mostrando {firstShown}'), 'the range line lives in that same surface');
  assert.ok(src.includes('<Pagination'), 'and the pager sits beside it');
  assert.ok(src.includes('gap-[var(--content-pad)]'), 'block rhythm is the token');
});

test('contacts: the controls are ONE row each, and share one height', () => {
  const toolbar = read(TOOLBAR);
  // The old single wrapping toolbar became two rows by design (§2.1–2.2), so "it stops
  // wrapping at lg" no longer describes anything. What still has to hold — and is what
  // that assertion was really protecting — is that every control in the band is the same
  // height, so the row cannot look ragged.
  // The height now comes from the SHARED shell + the shared primary rather than being
  // re-typed in the toolbar, which is what the assertion was protecting: three screens
  // used to draw three search boxes at three heights.
  const primitives = read('components/ui/primitives.tsx');
  for (const cls of ['SEARCH_SHELL_CLS', 'TOOLBAR_PRIMARY_CLS', 'GHOST_ACTION_CLS']) {
    const decl = primitives.slice(primitives.indexOf(`export const ${cls} =`), primitives.indexOf(`export const ${cls} =`) + 400);
    assert.ok(decl.includes('h-[var(--control-h)]'), `${cls} is control height`);
  }
  assert.ok(toolbar.includes('SEARCH_SHELL_CLS'), 'and the toolbar reads them rather than re-typing a box');
  const page = read(CONTACTS_PAGE);
  // The title row is a single non-wrapping line: the search takes the slack (flex-1) and
  // everything else is shrink-0, which is what stops the primary from being pushed off.
  assert.ok(/<div className="flex items-center gap-1 px-3 py-2">/.test(page), 'the title row does not wrap');
  assert.ok(toolbar.includes('min-w-0 max-w-\[420px\] flex-1') || toolbar.includes('max-w-[420px] flex-1'), 'the search absorbs the slack, capped at the artboard\'s 420px');
});

test('contacts: "Nuevo contacto" is LIVE, and creation goes through the identity chokepoint', () => {
  const src = read(CONTACTS_PAGE);
  // This button was disabled for as long as there was no creation path that went
  // through C-2's spine. It is enabled now, so the contract flips: the assertion that
  // matters is no longer "it is inert" but "the thing behind it cannot INSERT".
  assert.ok(src.includes('<NewContactButton'), 'the button occupies its designed slot');
  assert.ok(!src.includes('aria-disabled="true"'), 'it is no longer inert');
  assert.ok(!src.includes('TODO(crm)'), 'and the TODO that tracked this is gone');
  // IMPORT is still deliberately absent. The artboard draws it, but it is a FEATURE
  // (file upload, column mapping, dedup against the identity spine), not a restyle, and
  // a button that opens nothing is worse than one that is not there.
  assert.ok(!src.includes('Import contacts'), 'import stays out entirely');
  assert.ok(!/>\s*Importar\s*</.test(src), 'and it is absent under its Spanish label too');
  // EXPORT is the one that shipped, and it exports the FILTERED view rather than
  // "everything", which is the classic export bug.
  assert.ok(src.includes('<ContactsExportLink'), 'export is offered');

  // The real guarantee, checked at the source: the create action resolves through the
  // spine and never issues its own INSERT.
  const actions = read('lib/contactActions.ts');
  assert.ok(actions.includes('export async function createContactAction'), 'a create action exists');
  assert.ok(actions.includes('resolveContactByIdentity'), 'it goes through the C-2 chokepoint');
  assert.ok(
    !/INSERT\s+INTO\s+contacts/i.test(actions),
    'and it never inserts a contact directly — that is the duplicate the chokepoint prevents',
  );
});

test('contacts: the create form cannot be submitted without a phone or an email', () => {
  // The identity rule is enforced in THREE places and all three must hold: the pure
  // helper (unit-tested in contactForm.test.ts), the server validator, and the button.
  const validation = read('lib/contactActionValidation.ts');
  assert.ok(validation.includes('NEEDS_IDENTITY'), 'the server states the rule');
  assert.ok(
    validation.includes('if (phones.length === 0 && emails.length === 0)'),
    'and enforces it on the PAIR, not per field',
  );
  const form = read('components/contacts/form/ContactCreateForm.tsx');
  assert.ok(form.includes('disabled={pending || !identity.canSubmit}'), 'the button reflects it');
  // Name must never gate the save.
  assert.ok(!/required/.test(form), 'nothing in the create form is marked required');
});

test('contacts: there is exactly ONE contact editor, and the old modal is gone', () => {
  // A second editor is not a cosmetic duplication. The deleted modal ("Edit client
  // details") held ONE email and ONE phone, so on a contact with two addresses it
  // could not see the second and saving silently overwrote whichever one it held —
  // and it reached updateContact without the "at least one identity" rule, without the
  // duplicate check and without E.164 normalisation. It was a back door around the very
  // spine this feature exists to protect. If it ever comes back, this fails.
  assert.equal(
    existsSync(`${web}components/contacts/ContactEditDialog.tsx`),
    false,
    'the old one-email/one-phone modal must stay deleted',
  );
  for (const rel of [
    CONTACTS_PAGE,
    'components/contacts/ContactSidePanel.tsx',
    'components/contacts/ContactRecord.tsx',
    'components/contacts/ContactProperties.tsx',
  ]) {
    assert.equal(read(rel).includes('ContactEditDialog'), false, `${rel} no longer references it`);
    assert.equal(read(rel).includes('Edit client details'), false, `${rel} drops its title too`);
  }
});

test('contacts: EVERY door into editing opens the same drawer', () => {
  // Two doors exist: the record header and the list's customer panel (which the row's
  // "+ Add email" / "+ Add number" links also open via ?edit=1). Both must mount
  // ContactEditForm — the point of removing the modal was to end up with one editor,
  // not with a newer second one.
  const panel = read('components/contacts/ContactSidePanel.tsx');
  assert.ok(panel.includes('<ContactEditForm'), 'the customer panel opens the drawer');
  assert.ok(panel.includes('openEdit'), 'and still honours ?edit=1 from the row prompts');

  const button = read('components/contacts/form/EditContactButton.tsx');
  assert.ok(button.includes('<ContactEditForm'), 'the record header opens the same drawer');

  // The row prompts still route through the panel's ?edit=1 one-shot.
  const list = read(CONTACTS_TABLE);
  assert.ok(list.includes('hrefWith({ c: c.id, edit: "1" })'), 'the empty-cell prompts still open editing');
});

test('contacts: both doors build their payload from ONE server loader', () => {
  // The modal took a hand-rolled four-field snapshot while the record built something
  // else. That divergence is what let the two surfaces disagree about the same person,
  // so the shape and the query now live in one place.
  for (const rel of [CONTACTS_PAGE, 'app/clients/[clientId]/contacts/[contactId]/page.tsx']) {
    assert.ok(read(rel).includes('loadContactEditPayload('), `${rel} uses the shared loader`);
  }
  const loader = read('lib/contactPanel.ts');
  assert.ok(loader.includes('export async function loadContactEditPayload'), 'the loader is the single source');
  // It must read identities from BOTH surfaces: most rows predate the spine and carry
  // only the scalar column, and an identities-only read makes them look unreachable.
  assert.ok(loader.includes('contact.phone_e164') && loader.includes('contact.email'), 'scalar columns included');
  // And no page may reconstruct the shape itself any more.
  assert.equal(
    read('app/clients/[clientId]/contacts/[contactId]/page.tsx').includes('const editInitial ='),
    false,
    'the record page no longer hand-builds the payload',
  );
});

test('contacts: the surviving editor keeps the guarantees the modal lacked', () => {
  const form = read('components/contacts/form/ContactEditForm.tsx');
  // Multiple identities, not one email and one phone.
  assert.ok(form.includes('initial.phones') && form.includes('initial.emails'), 'identities are LISTS');
  assert.ok(form.includes('checkIdentity('), 'the "at least one" rule is enforced');
  // New identities go through the spine-backed section, which runs the duplicate check.
  // It now lives in the shared two-mode body, so follow the chain: the form renders
  // ContactSections in edit mode, and THAT mounts IdentitySection.
  assert.ok(form.includes('mode="edit"') && form.includes('<ContactSections'), 'the form renders the shared body');
  assert.ok(form.includes('excludeContactId: initial.contactId'), 'and the contact never flags itself');
  const body = read('components/contacts/form/ContactSections.tsx');
  assert.ok(body.includes('<IdentitySection'), 'new identities use the deduplicating section');
  // Only-what-changed, so an unrelated save cannot re-stamp consent or custom fields.
  assert.ok(form.includes('buildEditPatch('), 'the patch is minimised');
});

test('contacts: a duplicate WARNS and never blocks', () => {
  const identity = read('components/contacts/form/IdentitySection.tsx');
  // Warning tone, not error tone: amber, and an explicit way forward.
  assert.ok(identity.includes('border-warn/35 bg-warn-soft'), 'the match panel is amber, not red');
  assert.ok(identity.includes('COPY.continueAnyway'), 'there is a "continue anyway" escape');
  assert.ok(identity.includes('Abrir'), 'and a way to open the contact found');
  // The check is read-only — it must not be able to create what it is warning about.
  const actions = read('lib/contactActions.ts');
  const lookup = actions.slice(actions.indexOf('export async function lookupIdentityAction'));
  assert.ok(!lookup.includes('resolveContactByIdentity'), 'the live check never resolves (which would create)');
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

test('contacts: the list is OFFSET-paged with page numbers, and the keyset still exists', () => {
  // THE CONTRACT INVERTED, deliberately (docs/ui-redesign-crm-inbox.md §2.4). The design
  // paginates by NUMBER, which needs a total COUNT and an OFFSET read. The trade is real:
  // offset paging can skip or repeat a row if the set changes while someone is on page 3.
  // For a contacts book that changes a few times an hour that is acceptable and page
  // numbers are worth more; for the executions log it is not, which is why the keyset
  // codec below must SURVIVE rather than be deleted.
  const src = read(CONTACTS_PAGE);
  assert.ok(src.includes('offset: (requestedPage - 1) * PAGE_SIZE'), 'the page number becomes an offset');
  assert.ok(src.includes('withTotal: true'), 'and the read asks for the count the pager needs');
  assert.ok(src.includes('const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))'), 'the page count is derived from that total');
  // ONE page size, read by the query, the offset arithmetic and the range line.
  assert.ok(read('lib/contactColumns.ts').includes('export const PAGE_SIZE'), 'the page size is a single constant');

  const repo = readFileSync(fileURLToPath(new URL('../../src/db/repositories/contacts.ts', import.meta.url)), 'utf8');
  assert.ok(repo.includes('ORDER BY c.last_contact_at DESC, c.id DESC'), 'the ordering is unchanged');
  assert.ok(repo.includes('encodeContactCursor'), 'the keyset codec still exists for the callers that need it');
  // Both may not apply at once, or a keyset caller would be silently re-paged.
  assert.ok(repo.includes('const offset = cursor ? 0 : Math.max(0'), 'a cursor wins over an offset');
  // The offset is BOUND, never interpolated.
  assert.ok(repo.includes('LIMIT $${limitIdx} OFFSET $${offsetIdx}'), 'the offset is a bound parameter');
});

test('contacts: `from` (the origin workflow) survives search, facets, paging and row clicks', () => {
  const src = read(CONTACTS_PAGE);
  // Every generated href merges the CURRENT params, `from` included.
  assert.ok(
    /const merged: Record<string, string \| undefined> = \{\s*q,\s*from,/.test(src),
    'hrefWith merges from (and the open panel)',
  );
  assert.ok(src.includes('page: page > 1 ? String(page) : undefined'), 'and the page number rides along');
  assert.ok(src.includes('const fromQS = from ? `?from=${encodeURIComponent(from)}` : ""'), 'from is preserved…');
  // The row now SELECTS (?c=) rather than navigating away, so `from` rides hrefWith;
  // the link on into the full record lives in the panel and still carries fromQS.
  assert.ok(read(CONTACTS_TABLE).includes('href={hrefWith({ c: c.id })}'), '…on the row link, which opens the panel');
  assert.ok(src.includes('recordHref={`${base}/${panelId}${fromQS}`}'), '…and on the panel link into the record');
  // The toolbar preserves whatever is in the URL rather than rebuilding it.
  const toolbar = read(TOOLBAR);
  assert.ok(toolbar.includes('new URLSearchParams(searchParams.toString())'), 'the toolbar preserves existing params');
});

test('contacts: changing a facet RESETS paging (a stale page would show different people)', () => {
  const toolbar = read(TOOLBAR);
  // Both pagers are dropped, not just the one this screen uses: `page` because page 3 of
  // the previous filter set points at different people, and `cursor` because a keyset
  // cursor from it is meaningless.
  assert.ok(toolbar.includes('const PAGING_PARAMS = ["page", "cursor"] as const'), 'both pagers are named in one place');
  assert.ok(toolbar.includes('for (const k of PAGING_PARAMS) p.delete(k)'), 'every facet write drops them');
  // …except the COLUMNS control, which cannot change which rows match.
  assert.ok(toolbar.includes('{ keepPaging: true }'), 'a purely presentational write keeps the page');
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
  assert.ok(toolbar.includes('apply({ cols: next.join(",") }, { keepPaging: true })'), 'Columns only writes ?cols=');
  assert.ok(read(CONTACTS_PAGE).includes('<ContactsColumnsMenu visibleColumns={visibleColumns} />'), 'rendered in the stats row');
  const page = read(CONTACTS_PAGE);
  // `cols` must never be forwarded into a query — it is parsed for rendering only.
  assert.ok(page.includes('const visibleColumns = parseColumns(cols)'), 'cols is parsed for rendering');
  assert.ok(!/filters\s*=\s*{[^}]*cols/s.test(page), 'cols never enters the filter set');
});

test('contacts: the row is fully clickable via ONE real link (no duplicate tab stops)', () => {
  const src = read(CONTACTS_TABLE);
  assert.ok(src.includes('after:absolute after:inset-0'), 'the name link stretches over the row');
  // 54px, the artboard's row (§2.3) — up from 46px, because the name cell is now two
  // lines. Still not the dense --row-h: this is the customer list, not a log.
  assert.ok(src.includes('h-[54px]'), 'the row is the artboard height');
  assert.ok(src.includes('className={`relative grid h-[54px]'), 'the row is the positioning context');
  // A grid, not a table — and the head and the rows read the SAME template, which is
  // what keeps the sticky head aligned with its body.
  assert.ok((src.match(/gridTemplateColumns: template/g) ?? []).length === 2, 'head and rows share one template');
  // Semantics are preserved explicitly rather than inherited from the tag.
  for (const role of ['role="table"', 'role="row"', 'role="columnheader"', 'role="cell"']) {
    assert.ok(src.includes(role), `the grid still announces ${role}`);
  }
  // Underline is a hover/focus affordance only — never a permanent decoration.
  assert.ok(src.includes('no-underline'), 'the name link is not permanently underlined');
  assert.ok(src.includes('hover:underline focus-visible:underline'), '…but underlines on hover AND focus');
});

test('contacts: a number without a name shows the phone, in mono so it reads as an id', () => {
  const src = read(CONTACTS_TABLE);
  assert.ok(src.includes('c.name?.trim() || c.channel_user_id'), 'falls back to the channel identifier');
  // The "no name" chip is gone: the design's name cell is two lines, and the identifier
  // rendering in MONO where every other row shows a proper name in sans already says
  // "this is an id, not a person's name" — without spending a chip on it. The mono
  // fallback is the assertion that replaces it.
  assert.ok(src.includes('named ? "" : "u-mono"'), 'an unnamed contact renders its id in mono');
});

test('contacts: an overdue row is marked by SHAPE + color, not color alone', () => {
  const src = read(CONTACTS_TABLE);
  // It moved from `.u-row-danger` (a red wash + 3px red bar) to `.u-row-overdue` (amber),
  // because red is no longer available for it: the redesign spends red on the active nav
  // item, `Agendar cita`, and the "a human is handling this" marker. "Late" is exactly
  // what --warn is for, and the amber still carries a LEFT RULE, so the state is a shape
  // as well as a colour.
  assert.ok(src.includes('u-row-overdue'), 'the row carries the overdue treatment');
  const css = read('app/globals.css');
  assert.ok(/\.u-row-overdue[^}]*box-shadow:\s*inset 2px 0 0 0 var\(--warn-rule\)/s.test(css), 'a left rule, not colour alone');
  assert.ok(/\.u-row-overdue[^}]*background-color:\s*var\(--warn-soft\)/s.test(css), 'and an amber wash');
});

test('contacts: loading / empty / error states exist and the empty state can clear filters', () => {
  const src = read(CONTACTS_PAGE);
  assert.ok(src.includes('Ningún contacto coincide con estos filtros.'), 'filtered-empty is distinct…');
  assert.ok(src.includes('Todavía no hay contactos.'), '…from genuinely-empty');
  assert.ok(src.includes('Quitar los filtros'), 'the filtered-empty state offers a way out');
});

// ─────────────────────────── Contact record ─────────────────────────────────

test('record: the three-region model survives the restyle', () => {
  const src = read(RECORD);
  assert.ok(src.includes('<ContactProperties'), 'left: identity + properties + custom fields');
  assert.ok(src.includes('<ContactTimeline'), 'center: the timeline');
  assert.ok(src.includes('<ContactAssociations'), 'right: appointments + tasks + tags');
  assert.ok(src.includes('xl:grid-cols-['), 'three columns at wide viewports, stacked below');
});

test('record + drawer: ONE component declares the sections, their order and their fields', () => {
  // Viewing and editing had drifted into two products. The fix is structural, not
  // cosmetic: both surfaces render the SAME component, so a field added to one is
  // necessarily in the other. If either stops doing that, they can diverge again.
  const body = read('components/contacts/form/ContactSections.tsx');
  // Sentence case, per the rework — `SectionHeading` moved to sans/590 and the labels
  // stopped shouting (§2.5). "COMUNICACIÓN" also became "Mensajería", matching the
  // artboard's own word for that group.
  const order = ['Contacto', 'Asignación', 'Mensajería', 'Interno'].map((t) => body.indexOf(`title="${t}"`));
  assert.ok(order.every((i) => i > 0), 'all four sections are declared in one place');
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'and in a fixed order');
  // The optional divider and the tenant-configured block come last, in both modes.
  assert.ok(body.indexOf('<OptionalDivider') > order[3], 'the optional divider follows INTERNO');
  assert.ok(body.indexOf('COPY.businessConfigured') > body.indexOf('<OptionalDivider'), 'client fields come last');

  assert.ok(read('components/contacts/ContactProperties.tsx').includes('mode="read"'), 'the record reads it');
  assert.ok(read('components/contacts/form/ContactEditForm.tsx').includes('mode="edit"'), 'the drawer edits it');
});

test('record: the left column is READ-ONLY — there is one place a contact is written', () => {
  // Comments stripped: the file's own doc comment NAMES updateContactAction to explain
  // why it survives, and prose must not satisfy or break a "does not contain" check.
  const col = stripComments(read('components/contacts/ContactProperties.tsx'));
  // Field-by-field editing was a second editor competing with the drawer.
  for (const gone of ['updateContactAction', 'useTransition', '<input', '<select', 'onCommit', 'EditableRow']) {
    assert.equal(col.includes(gone), false, `the record column no longer contains ${gone}`);
  }
  // In read mode the shared body must not mount controls either.
  const body = read('components/contacts/form/ContactSections.tsx');
  const readBranches = body.match(/mode === "read" \? \(([\s\S]*?)\) : \(/g) ?? [];
  assert.ok(readBranches.length >= 4, 'every section has an explicit read branch');
  // …but the action itself must SURVIVE: the drawer is its caller.
  assert.ok(
    read('lib/contactActions.ts').includes('export async function updateContactAction'),
    'updateContactAction stays — the drawer uses it',
  );
  assert.ok(read('components/contacts/form/ContactEditForm.tsx').includes('updateContactAction('), 'and calls it');
});

test('contacts: stored enums are never printed raw', () => {
  // "new", "manual" and "unknown" are storage. An operator reading "unknown" next to
  // Consent cannot tell "nobody asked" from "they said no".
  const labels = read('lib/contactLabels.ts');
  for (const [stored, human] of [
    ['new', 'Nuevo'],
    ['active', 'Activo'],
    ['customer', 'Cliente'],
    ['unknown', 'Sin confirmar'],
    ['opted_in', 'Aceptado'],
    ['opted_out', 'Rechazado'],
    ['manual', 'Manual'],
  ] as const) {
    assert.ok(new RegExp(`${stored}:\\s*"${human}"`).test(labels), `${stored} → ${human}`);
  }
  // The chip every surface uses prints the label, not the value — so the list, the
  // record and the drawer cannot disagree.
  assert.ok(read('components/ui/primitives.tsx').includes('{stageLabel(stage)}'), 'StageChip humanises');
  // And nothing renders the raw value inline instead of going through the helper.
  const body = stripComments(read('components/contacts/form/ContactSections.tsx'));
  assert.equal(/>\s*\{?\s*props\.read\.stage\s*\}?\s*</.test(body), false, 'stage is never printed bare');
  assert.ok(body.includes('consentLabel(') && body.includes('channelLabel('), 'consent + channel go through the helper');
});

test('contacts: no out-of-palette green survives in the CRM surfaces', () => {
  // --accent is emerald and means links / success ticks. A composer's submit button is
  // neither, and it read as "already saved". Same correction as Inbox and Staff.
  for (const rel of [
    'components/contacts/shared/NotesSection.tsx',
    'components/contacts/shared/TasksSection.tsx',
    'components/contacts/ContactTimeline.tsx',
    'components/contacts/DuplicateCandidates.tsx',
    'components/contacts/FieldDefinitions.tsx',
  ]) {
    assert.equal(read(rel).includes('bg-accent'), false, `${rel} is off the emerald accent`);
  }
  assert.ok(read('components/contacts/shared/NotesSection.tsx').includes('bg-brand'), 'Add note uses the brand token');
  // No raw hex anywhere in these files — colour comes from tokens.
  for (const rel of ['components/contacts/shared/NotesSection.tsx', 'components/contacts/form/ContactSections.tsx']) {
    assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(stripComments(read(rel))), false, `${rel} has no hard-coded colour`);
  }
});

test('panel + rail + drawer: section headings share ONE component', () => {
  // The panel's headings used to be a bare <p className="u-th">, the rail's a
  // PanelHeader, the drawer's an icon + rule. Three near-misses read as three products.
  // It now lives in the NEUTRAL primitives, because the staff roster's panel draws it
  // too and scheduling must not import from contacts to get a heading.
  const heading = read('components/ui/primitives.tsx');
  assert.ok(heading.includes('export function SectionHeading'), 'the heading is its own component');
  assert.ok(heading.includes('<SectionHeading title={title}'), 'PanelSection composes it, rather than duplicating it');
  assert.ok(
    read('components/contacts/form/formPrimitives.tsx').includes("export { SectionHeading } from \"@/components/ui/primitives\""),
    'the contact form re-exports the one definition instead of keeping a copy',
  );
  // EXACTLY ONE definition in the whole app — a second `function SectionHeading` is the
  // drift this test exists to catch, wherever it appears.
  const defs = allTsx().filter((rel) => /(export )?function SectionHeading\(/.test(read(rel)));
  assert.deepEqual(defs, ['components/ui/primitives.tsx'], `one definition only, found: ${defs.join(', ')}`);
  for (const rel of ['components/contacts/ContactSidePanel.tsx', 'components/contacts/ContactAssociations.tsx']) {
    const src = read(rel);
    // Either the heading alone or the whole section card — both route through
    // SectionHeading, which is the point.
    assert.ok(/<(SectionHeading|FormSection)\b/.test(src), `${rel} uses the shared heading`);
    assert.equal(/<p className="u-th">/.test(src), false, `${rel} no longer hand-rolls one`);
    assert.equal(src.includes('<PanelHeader'), false, `${rel} no longer uses the older bar`);
  }
  // Icons on all of them or none — never half and half.
  for (const rel of [
    'components/contacts/ContactSidePanel.tsx',
    'components/contacts/ContactAssociations.tsx',
    'components/contacts/form/ContactSections.tsx',
  ]) {
    const src = read(rel);
    const headings = src.match(/<(SectionHeading|FormSection)\b/g)?.length ?? 0;
    const icons = src.match(/icon=\{</g)?.length ?? 0;
    assert.equal(icons, headings, `${rel}: every section heading carries an icon (${icons}/${headings})`);
  }
});

test('quick view + drawer: same components, deliberately different geometry', () => {
  const panel = read('components/contacts/ContactSidePanel.tsx');
  const drawer = read('components/contacts/form/ContactFormDrawer.tsx');
  const editForm = read('components/contacts/form/ContactEditForm.tsx');

  // SAME COMPONENTS — sections, heading, identity block, metric tiles.
  assert.ok(panel.includes('<FormSection'), 'the quick view uses the drawer section card');
  assert.equal(/className="flex flex-col gap-2 border-t border-line pt-3"/.test(panel), false, 'no flat divided blocks left');
  for (const src of [panel, editForm]) {
    // Both compose the header through the shared helper, so neither can restate the
    // identity differently from the other.
    assert.ok(src.includes('<ContactPanelHeader'), 'both use the shared header');
  }
  const shell = read('components/contacts/shared/ContactPanelShell.tsx');
  assert.ok(shell.includes('<ContactHeaderBlock'), 'which composes the identity block');
  // THE METRIC STRIP IS GONE, and with it ContactMetrics. It was a CITAS / ÚLTIMA / CANAL
  // band that the artboard (22a) does not draw, and every one of the three was restated
  // within 200px: CITAS is now "· 14 citas" on the name line, CANAL is "Canal preferido"
  // in Mensajería, ÚLTIMA is derivable from the appointments one tab away. It spent ~56px
  // of a 380px panel repeating the panel.
  assert.equal(/<ContactMetrics/.test(shell), false, 'and no longer a metric strip');
  assert.equal(
    /export function ContactMetrics/.test(read('components/contacts/shared/ContactHeaderBlock.tsx')),
    false,
    'the component went with it rather than being kept unused',
  );

  // DIFFERENT BEHAVIOUR, on purpose: looking must not interrupt, changing must.
  // The drawer no longer DIMS (it opens on the quick view's own box, so a scrim was a
  // jolt for a panel that does not move) — but it still intercepts clicks, or a stray
  // tap on a table row would navigate away from unsaved edits.
  assert.ok(/fixed inset-0 z-40/.test(drawer), 'the drawer still catches outside clicks');
  assert.equal(/bg-black\/\d+/.test(drawer), false, 'without darkening the window');
  assert.ok(drawer.includes('u-panel-in'), 'motion announces the swap instead');
  assert.ok(drawer.includes('useTrappedPanel'), 'and it traps focus while there are unsaved changes');
  assert.equal(/fixed inset-0/.test(panel), false, 'the quick view intercepts nothing');
  assert.equal(panel.includes('role="dialog"'), false, 'it is a card beside the table, not a dialog');
  assert.ok(panel.includes('aria-label="Detalles del contacto"'), 'it stays an aside');
  // The quick view saves nothing, so it must not grow a save bar.
  for (const bar of ['unsavedLabel(', 'Guardar cambios', '<footer']) {
    assert.equal(panel.includes(bar), false, `the quick view has no ${bar}`);
  }
  // …and its actions stay at the TOP, above the tab strip.
  assert.ok(
    panel.indexOf('CRM_COPY.actions.openRecord') < panel.indexOf('role="tablist"'),
    'the actions sit above the tabs, not in a footer',
  );
});

test('panel header: the wash is the CONTACT\'S OWN tone, from the avatar hash', () => {
  // A header tinted from a second derivation would put a teal disc on a purple header.
  const block = read('components/contacts/shared/ContactHeaderBlock.tsx');
  assert.ok(block.includes('export function contactToneSeed'), 'one seed rule');
  // The discs became two-tone gradient SPHERES, so the wash fades the same PAIR rather
  // than a single hex — otherwise the header and the avatar 40px above it disagree.
  assert.ok(block.includes('avatarToneStyle(contactToneSeed('), 'and the tone comes from the avatar hash');
  const avatar = read('lib/avatarColor.ts');
  assert.ok(avatar.includes('export function avatarToneIndex'), 'the index is shared');
  assert.ok(/avatarColor\(id: string\): string \{\s*return `u-avatar-\$\{avatarToneIndex\(id\)\}`/.test(avatar),
    'the disc class derives from that same index, not a second hash');
  // The var, never a hex: the eight tones stay defined in globals.css alone.
  assert.ok(/return `var\(--avatar-\$\{avatarToneIndex\(id\)\}\)`/.test(avatar), 'the tone is a var, not a literal');
  // The discs became two-tone gradient SPHERES ("avatares esfera"), so a wash needs BOTH
  // stops of the pair or the header disagrees with the avatar above it.
  assert.ok(avatar.includes('export function avatarToneStyle'), 'a pair-aware helper exists');
  assert.ok(/"--tone-a": `var\(--avatar-\$\{i\}-a\)`/.test(avatar), 'it emits the first stop');
  assert.ok(/"--tone-b": `var\(--avatar-\$\{i\}-b\)`/.test(avatar), '…and the second');

  // The RAMP lives in one place so the two panels cannot drift.
  const css = read('app/globals.css');
  assert.ok(/\.u-contact-wash \{[\s\S]*?linear-gradient\(/.test(css), 'the wash recipe is a single class');
  // The ramp now fades the PAIR — 10% of the first stop into 3.5% of the second, which
  // is the artboard's own recipe (§2.5).
  assert.ok(/--tone-a[\s\S]*?10%[\s\S]*?--tone-b[\s\S]*?3\.5%/.test(css), '10% of A → 3.5% of B, as the artboard');
  // ONE gradient recipe for all eight discs, keyed off the pair each class declares.
  assert.ok(/\[class\*='u-avatar-'\] \{[\s\S]*?linear-gradient\(\s*135deg/.test(css), 'and one disc recipe for all eight tones');

  // Both panels feed it; the create form does NOT — there is no contact to be the
  // colour of yet.
  assert.ok(read('components/contacts/ContactSidePanel.tsx').includes('headerToneStyle={contactToneStyle('), 'the quick view tints');
  assert.ok(read('components/contacts/form/ContactEditForm.tsx').includes('headerToneStyle={contactToneStyle('), 'the drawer tints');
  assert.equal(read('components/contacts/form/ContactCreateForm.tsx').includes('headerTone'), false, 'creating tints nothing');
  // And the wash only ever paints the header, never the scrolling body.
  const shell = read('components/contacts/shared/ContactPanelShell.tsx');
  const body = shell.slice(shell.indexOf('ref={bodyRef}'));
  assert.equal(body.includes('u-contact-wash'), false, 'the body stays a neutral reading surface');
});

test('quick view: the contact READS without opening the editor, now inside Resumen', () => {
  const panel = read('components/contacts/ContactSidePanel.tsx');
  // The gap this closes is unchanged: owner, consent and "no contactar" were readable
  // only by opening the edit drawer — reading through an editing surface, which is
  // exactly the pattern the record page dropped when its left column went read-only.
  //
  // What changed is WHERE. The separate `Datos` tab folded into `Resumen` (§2.5): "the
  // contact's fields" and "a summary of this contact" were never two different
  // questions, and splitting them cost two clicks in a panel with room for neither tab.
  assert.equal(panel.includes('"data"'), false, 'the separate Datos tab is gone');
  assert.ok(/tab === "summary" \?/.test(panel), 'Resumen is what renders');
  // It must still be the SHARED read-mode body, not a second spelling of what a contact is.
  assert.ok(/<ContactSections\s+mode="read"/.test(panel), 'it renders the shared sections in read mode');
  // …fed by the payload the panel ALREADY loaded for the Editar button: no new query.
  assert.ok(panel.includes('edit.initial.consent'), 'from the existing payload');
  // No new query: the panel takes the loader's payload as a PROP and only imports its
  // type (a value import of a `server-only` loader into this client component would
  // not even build).
  assert.ok(/import type \{[^}]*ContactEditPayload/.test(panel), 'the payload arrives as a prop, type-only');
  assert.equal(/loadContactEditPayload\s*\(/.test(panel), false, 'the panel never calls the loader itself');
  // Read mode only: the facts block must not smuggle an editing control back in.
  const facts = panel.slice(panel.indexOf('<ContactSections'), panel.indexOf('<FormSection'));
  assert.equal(/mode="edit"|<input/.test(facts), false, 'the facts block writes nothing');
  // ONE column at the panel's 380px — two would leave ~70px for a phone number.
  assert.ok(facts.includes('columns={1}'), 'and it is a single column of fact rows');
});

test('quick view + drawer: ONE panel interior — no double frame, one fill, one width', () => {
  const shell = read('components/contacts/shared/ContactPanelShell.tsx');
  const panel = read('components/contacts/ContactSidePanel.tsx');
  const drawer = read('components/contacts/form/ContactFormDrawer.tsx');

  // Both render the same interior; neither hand-rolls header/body chrome.
  for (const [rel, src] of [['panel', panel], ['drawer', drawer]] as const) {
    assert.ok(src.includes('<ContactPanelShell'), `the ${rel} renders the shared interior`);
    assert.equal(/overflow-y-auto[^"]*bg-background/.test(src), false, `the ${rel} has no grey interior`);
  }

  // TWO TONES, ONE FRAME: `--surface` chrome, `--subtle` body. Never the canvas grey —
  // that is what read as a card inside a card. And never all-white either, which left
  // the section cards (also `--surface`) defined by a hairline alone.
  assert.equal(shell.includes('bg-background'), false, 'the interior is never the canvas grey');
  // ONE surface, divided by hairlines: each section brings its own padding and closes
  // with a rule, so the body adds neither padding nor gaps of its own.
  assert.ok(/overflow-y-auto bg-surface/.test(shell), 'the scrolling body is the plain surface');
  assert.equal(/overflow-y-auto[^"]*\bp-3\b/.test(shell), false, 'and adds no padding of its own');
  assert.ok(
    read('components/ui/primitives.tsx').includes('border-b border-line px-4 py-4 last:border-b-0'),
    'sections are hairline-separated blocks, not bordered cards',
  );

  // ONE width, exported so neither can drift.
  assert.ok(shell.includes('export const CONTACT_PANEL_WIDTH'), 'the width is a shared constant');
  for (const src of [panel, drawer]) assert.ok(src.includes('CONTACT_PANEL_WIDTH'), 'both use it');
  assert.equal(/w-\[3[0-9]{2}px\]|2xl:w-\[/.test(panel), false, 'the quick view no longer hard-codes its own width');

  // The body is declared once, in the shell, and pads nothing: sections bring their own.
  assert.ok(/flex min-h-0 flex-1 flex-col overflow-y-auto bg-surface/.test(shell), 'one body rhythm');
  for (const src of [panel, drawer]) {
    assert.equal(/<div className="p-3">/.test(src), false, 'no surface re-declares the body padding');
  }
});

test('both panels are THREE zones — fixed header, one scrolling body, fixed footer', () => {
  const shell = read('components/contacts/shared/ContactPanelShell.tsx');
  // Exactly one scrolling region. Two would mean nested scrollbars; zero would mean the
  // panel grows with its content, which is what made every tab a different height.
  assert.equal((shell.match(/overflow-y-auto/g) ?? []).length, 1, 'exactly one scrolling zone');
  assert.ok(/min-h-0 flex-1[^"]*overflow-y-auto/.test(shell), 'the body is min-h-0 + flex-1, so it scrolls instead of stretching');
  // Header, subheader, banner and footer are all shrink-0: none of them may scroll away.
  // Header, subheader, banner and footer must all be shrink-0 — none of them may
  // scroll away or be squeezed by a long body. (Matched on the zone divs themselves,
  // not on their fill, so re-toning a zone cannot silently drop the assertion.)
  const zoneDivs = (shell.match(/<div className="shrink-0[^"]*"/g) ?? []).length;
  assert.ok(zoneDivs >= 3, `the fixed zones are shrink-0 (found ${zoneDivs})`);
  assert.ok(/\{footer \? <div className="shrink-0/.test(shell), 'including the footer');
  // Short content stays at the TOP — no centring, no artificial filler.
  assert.equal(/justify-center|items-center/.test(shell), false, 'the body never centres short content');
  assert.equal(/min-h-\[|h-\[\d+px\]/.test(shell), false, 'and never pads to a fixed pixel height');

  // The quick view takes its height from the ROW, not from the active tab.
  const panel = read('components/contacts/ContactSidePanel.tsx');
  assert.ok(/min-h-0 flex-1 \$\{CONTACT_PANEL_FRAME\}/.test(panel), 'the panel stretches to its container');
  // The frame now comes from the neutral chrome (the staff panel draws the same card),
  // so the clip is asserted where it is actually defined.
  assert.ok(read('components/ui/panelChrome.tsx').includes('overflow-hidden'),
    'and the shared frame clips the body scrollbar to its radius');
  assert.ok(read('components/contacts/shared/ContactPanelShell.tsx').includes('CONTACT_PANEL_FRAME = PANEL_FRAME'),
    'the contact frame IS the shared one, not a copy of its classes');
  assert.ok(panel.includes('scrollResetKey={tab}'), 'switching tabs returns the body to the top');
  // Its wrapper must be a flex column, or the aside sizes to content again.
  const page = read(CONTACTS_PAGE);
  // TWO SIBLING CARDS. The panel inside the shell cut the title band short of the right
  // edge (square top-right corner against a round top-left) and pushed the panel a
  // gutter below the shell's top. As siblings in one row they share a top and a bottom.
  assert.ok(/<div className="flex min-h-0 flex-1 gap-3">/.test(page), 'the shell and the panel share a row');
  // The table card now opts out of clipping, because the facet row beside it hosts the
  // Filtrar / Orden / Columnas popovers and a card's overflow-hidden cuts an
  // absolutely-positioned menu off at its edge.
  assert.ok(page.indexOf('<PageShell clip={false}>') > page.indexOf('flex min-h-0 flex-1 gap-3'), 'the shell is inside that row');
  assert.ok(page.indexOf('<ContactSidePanel') > page.indexOf('</PageShell>'), 'and the panel is its sibling, not its child');
  assert.equal(/xl:block/.test(page), false, 'the panel column is never a block');
  // The panel must not GROW on the row axis: `flex-1` there swallowed its own width and
  // took half the screen from the table.
  const shellSrc = read('components/contacts/shared/ContactPanelShell.tsx');
  const regionVal = shellSrc.slice(shellSrc.indexOf('CONTACT_PANEL_REGION =')).match(/"([^"]*)"/)?.[1] ?? '';
  assert.equal(/flex-1/.test(regionVal), false, `the region never grows on its own: "${regionVal}"`);
  assert.ok(panel.includes('shrink-0'), 'the panel holds its width in the row');
});

test('quick view and drawer are the SAME box — one geometry, one anchor', () => {
  const shell = read('components/contacts/shared/ContactPanelShell.tsx');
  const panel = read('components/contacts/ContactSidePanel.tsx');
  const drawer = read('components/contacts/form/ContactFormDrawer.tsx');

  // Width, radius, hairline and fill are declared ONCE.
  assert.ok(shell.includes('export const CONTACT_PANEL_FRAME'), 'the box is a shared constant');
  for (const [rel, src] of [['quick view', panel], ['drawer', drawer]] as const) {
    assert.ok(src.includes('CONTACT_PANEL_FRAME'), `the ${rel} uses the shared frame`);
    assert.ok(src.includes('CONTACT_PANEL_WIDTH'), `the ${rel} uses the shared width`);
    // Neither may re-declare the box's own look.
    assert.equal(/rounded-xl border border-line bg-surface/.test(src), false, `the ${rel} does not re-spell the frame`);
  }

  // ONE ANCHOR. The drawer is absolute inside the page's panel region — NOT fixed to
  // the window, which is what made it span the whole viewport while the quick view
  // stopped at the table card. `fixed` here would silently break the alignment again.
  assert.ok(drawer.includes('absolute inset-y-0 right-0'), 'the drawer anchors to the region');
  assert.equal(/className=\{?`?[^`"]*\bfixed inset-y-0/.test(drawer), false, 'the drawer is never window-fixed');
  assert.ok(shell.includes('export const CONTACT_PANEL_REGION'), 'the region is a shared constant');
  assert.ok(panel.includes('CONTACT_PANEL_REGION'), 'the list wraps its panel column in one');
  assert.ok(
    read('app/clients/[clientId]/contacts/[contactId]/page.tsx').includes('relative flex w-full flex-1 flex-col'),
    'and the record makes its content column one too',
  );

  // The click-catcher stays window-wide; it is about protecting unsaved edits, not
  // about geometry, so it does not follow the panel's box.
  assert.ok(/fixed inset-0 z-40/.test(drawer), 'the catcher spans the window');

  // The region must not ship a display utility: it is composed with `hidden xl:flex`,
  // and two display utilities of equal specificity resolve by stylesheet order.
  const regionValue = shell.slice(shell.indexOf('CONTACT_PANEL_REGION =')).match(/"([^"]*)"/)?.[1] ?? '';
  // The bare `flex` utility, not `flex-1` / `flex-col`.
  assert.equal(/(^|\s)flex(\s|$)/.test(regionValue), false, `the region declares no display: "${regionValue}"`);
  assert.ok(regionValue.includes('relative'), 'but it does establish the positioning context');
});

test('M-4: the customer panel is reachable at EVERY width — a sheet below xl, not display:none', () => {
  // The bug: the region was `hidden ... xl:flex`, so below 1280px a row click selected the
  // row and rendered NOTHING, with no sheet and no explanation. The fix is the shared
  // overlay contract (the same one the staff drawer and inbox details use): a scrim + a
  // fixed sheet below the beside-breakpoint, a focus trap while it covers the table, and
  // Esc / scrim close by navigating ?c= away. At xl+ the layer is display:contents, so the
  // beside-card row is byte-identical to before.
  const panel = stripComments(read('components/contacts/ContactSidePanel.tsx')); // a comment may quote the old class
  assert.equal(/hidden[^"'`]*\bxl:flex\b/.test(panel), false, 'the region no longer hides itself below xl with no fallback');
  assert.ok(panel.includes('OVERLAY_SCRIM'), 'it renders the shared scrim below the breakpoint');
  assert.ok(panel.includes('useIsOverlayWidth(1279.98)'), 'it knows when it is an overlay (below xl, matching xl:contents)');
  assert.ok(panel.includes('useTrappedPanel'), 'the overlay traps focus + closes on Esc');
  assert.ok(/role=\{overlaying \? "dialog"/.test(panel), 'dialog semantics only while it covers the table');
  assert.ok(panel.includes('xl:contents'), 'the positioning layer vanishes at xl+, leaving the beside-card row untouched');
});

test('panel widths are inline styles, not scanner-invisible Tailwind classes', () => {
  // The hazard is interpolating a VALUE inside an arbitrary-value bracket —
  // `max-w-[min(${CONST},100vw)]` is not an extractable candidate, so the utility only
  // exists while some earlier build happens to have emitted it. (Interpolating a
  // variable that itself holds literal class strings, as the tab strip does, is fine:
  // the scanner sees those literals.)
  const interpolatedArbitrary = /\[[^\]\n]*\$\{[^}\n]*\}[^\]\n]*\]/;
  for (const rel of ['components/contacts/form/ContactFormDrawer.tsx', 'components/contacts/ContactSidePanel.tsx']) {
    const src = stripComments(read(rel));
    assert.equal(interpolatedArbitrary.test(src), false, `${rel} interpolates nothing into an arbitrary value`);
    assert.ok(src.includes('CONTACT_PANEL_WIDTH'), `${rel} takes its width from the shared constant`);
  }
});

test('quick view: the header facts come from the same payload the drawer opens with', () => {
  const panel = read('components/contacts/ContactSidePanel.tsx');
  // A second source for a header fact is how the two surfaces start quoting different
  // numbers for one contact.
  assert.ok(panel.includes('edit?.initial.activityCount'), 'activity count comes from the shared payload');
  // The visit count on the name line comes from the panel payload's own summary, which is
  // the SAME derivation the list and the record read (summarizeAppointments) — not a
  // second count computed here.
  assert.ok(panel.includes('visitCount: data.summary.visitCount'), 'and the visit count from the summary');
  // `lastContactAt` / `sourceChannel` were the metric strip's inputs. That strip is gone
  // (see the case above), so requiring them here would be requiring dead plumbing.
  assert.equal(panel.includes('edit.initial.sourceChannel'), false, 'the metric inputs are no longer threaded');
  const loader = read('lib/contactPanel.ts');
  assert.ok(loader.includes('isCustomer: appts.some('), 'the customer flag is derived once, in the loader');
});

test('panel: the CRM surfaces speak Spanish, from the shared helper', () => {
  const labels = read('lib/contactLabels.ts');
  assert.ok(labels.includes('export const CRM_COPY'), 'the copy is centralised');
  // No inline English left on the surfaces that compose the panel and the rail.
  const surfaces = [
    'components/contacts/ContactSidePanel.tsx',
    'components/contacts/ContactAssociations.tsx',
    'components/contacts/shared/AppointmentsSection.tsx',
    'components/contacts/shared/TasksSection.tsx',
    'components/contacts/shared/TagsSection.tsx',
    'components/contacts/shared/NotesSection.tsx',
  ];
  const banned = [
    'Next appointment', 'Open tasks', '>Tags<', 'No upcoming appointment', 'No open tasks',
    'No tags.', 'No notes yet', 'Add task', 'New tag', 'Book appointment', 'Open record',
    'Add a note', 'Task title', '>Complete<', '>Delete<', '>Cancel<', '>Create<',
  ];
  for (const rel of surfaces) {
    const src = stripComments(read(rel));
    for (const phrase of banned) {
      assert.equal(src.includes(phrase), false, `${rel} still renders "${phrase}"`);
    }
  }
});

test('panel: appointment status is humanised and tinted from tokens', () => {
  const appts = read('components/contacts/shared/AppointmentsSection.tsx');
  assert.ok(appts.includes('appointmentStatusLabel(status)'), 'the badge prints the label, not the enum');
  assert.equal(/STATUS_LABEL/.test(stripComments(appts)), false, 'no local English label map survives');
  const labels = read('lib/contactLabels.ts');
  for (const [stored, human] of [
    ['scheduled', 'Agendada'],
    ['completed', 'Completada'],
    ['no_show', 'No asistió'],
  ] as const) {
    assert.ok(new RegExp(`${stored}:\\s*"${human}"`).test(labels), `${stored} → ${human}`);
  }
  // Tones come from --success/--warn, which flip with the theme; raw Tailwind does not.
  assert.ok(appts.includes('bg-success/10 text-success') && appts.includes('bg-warn-soft text-warn'), 'token tones');
});

test('CRM surfaces carry no raw palette colour', () => {
  for (const rel of [
    'components/contacts/ContactSidePanel.tsx',
    'components/contacts/ContactAssociations.tsx',
    'components/contacts/DuplicateBanner.tsx',
    'components/contacts/DuplicateCandidates.tsx',
    'components/contacts/shared/AppointmentsSection.tsx',
    'components/contacts/shared/TasksSection.tsx',
    'components/contacts/shared/TagsSection.tsx',
    'components/contacts/shared/NotesSection.tsx',
    'components/contacts/ContactTimeline.tsx',
  ]) {
    const src = stripComments(read(rel));
    assert.equal(/\b(emerald|amber|green|red|blue)-[0-9]{3}\b/.test(src), false, `${rel} uses tokens, not raw Tailwind`);
    assert.equal(src.includes('bg-accent'), false, `${rel} is off the emerald accent`);
    assert.equal(/#[0-9a-fA-F]{6}\b/.test(src), false, `${rel} has no hard-coded hex`);
  }
});

test('record: the compact header carries identity + the operative facts + both actions', () => {
  const src = read(RECORD);
  for (const needle of ['summary.displayName', '<StageChip', 'Origen', 'Dueño', 'Visitas', 'No-shows']) {
    assert.ok(src.includes(needle), `header shows ${needle}`);
  }
  assert.ok(src.includes('Ver conversación'), 'the conversation action is present');
  assert.ok(src.includes('Agendar cita'), 'the booking action is present');
  // The origin channel is a stored machine string; the header must not print it raw.
  assert.ok(src.includes('sourceLabel(source)'), 'the source is humanised, never the raw column');
});

test('record: the primary actions exist EXACTLY once (they moved out of the rail)', () => {
  const rail = read('components/contacts/ContactAssociations.tsx');
  for (const label of ['Open conversation', 'Book appointment', 'Ver conversación', 'Agendar cita']) {
    assert.ok(!rail.includes(label), `the rail no longer duplicates ${label}`);
  }
  // Count RENDERED occurrences only — the file's own doc comment names both actions.
  const record = stripComments(read(RECORD));
  assert.equal(record.match(/Ver conversación/g)?.length, 1, 'exactly one conversation action');
  assert.equal(record.match(/Agendar cita/g)?.length, 1, 'exactly one booking action');
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
  // Spanish, and sentence case (§3.1): it was a mono uppercase badge, which on the pane's
  // own title read as a status chip rather than as a count.
  assert.ok(src.includes('{pending === 1 ? "te necesita" : "te necesitan"}'), 'and is rendered, pluralised');
});

test('inbox: the selected row is marked by a fill AND a shape, and never shifts', () => {
  const src = read(WORKSPACE);
  // The queue row is a ROUNDED inset card, so its mark is a fill + a 1px BORDER —
  // an inset 2px left rule cannot follow a 15px radius and read as a dark sliver
  // clipped against the lane header. The red .u-row-selected stays in use on the
  // surfaces where selection really is urgency; the inbox is not one of them.
  // The queue column is WHITE (the reference's), so selection is the GREY CARD on
  // it — the inverse of tinting the whole column and darkening one row.
  assert.ok(src.includes('border-transparent bg-queue-row-active'), 'selected = the grey card on the white queue');
  assert.ok(!src.includes('u-row-selected'), 'the inbox no longer paints selection brand-red');
  // EVERY state carries a border (transparent when idle) so selecting a row cannot
  // move its neighbours by a pixel.
  assert.ok(src.includes('border-transparent hover:bg-queue-row-active/50'), 'the idle row reserves the same border');
  assert.ok(src.includes('border-warn/25 bg-warn-soft'), 'a pending row keeps its own amber mark');
});

test('inbox: customer / bot / human-agent messages stay visually distinct', () => {
  const src = read('components/MessageTranscript.tsx');
  assert.ok(src.includes('const isUser = msg.sender === "user"'), 'customer is identified');
  assert.ok(src.includes('const isAgent = msg.sender === "human_agent"'), 'the human agent is identified');
  // Three different fills — a light → mid → dark ramp, no hue spent.
  assert.ok(src.includes('border border-bubble-in-border bg-bubble-in text-bubble-in-fg'), 'customer bubble');
  // The human agent is WHITE with an INK edge — it sits on the business side but must not
  // be mistaken for the bot, so it keeps the side and drops the dark fill (§3.3).
  assert.ok(src.includes('border border-bubble-agent-border bg-bubble-agent text-bubble-agent-fg'), 'human-agent bubble (ink-edged, on the business side)');
  // The bot is a SOLID near-black fill with no border — a border on a dark fill is
  // invisible and only existed to keep the old three-grey ramp apart.
  assert.ok(src.includes('bg-bubble-bot text-bubble-bot-fg'), 'bot bubble');
  // THE TAIL is what says who is speaking, alongside the fill: three corners take
  // --radius-bubble and the one pointing at the speaker collapses to the tail token.
  assert.ok(src.includes('rounded-bl-bubble-tail'), 'the customer\'s tail points bottom-left');
  assert.ok(src.includes('rounded-br-bubble-tail'), 'the business side points bottom-right');
  // A FAILED agent send must not be mistaken for a normal one now that both are red:
  // normal is the SOLID fill, failed is OUTLINED.
  assert.ok(src.includes('border border-danger bg-danger/12 text-danger'), 'failed is outlined, not solid');
});

test('inbox: the timestamp sits OUTSIDE the bubble, so it steals width from no line', () => {
  const src = stripComments(read('components/MessageTranscript.tsx'));
  // THE CONTRACT INVERTED — and the regression it was written for is now impossible
  // rather than merely guarded.
  //
  // The old arrangement tucked the stamp into the bubble's last line, which needed an
  // INVISIBLE copy of it to reserve room: making the stamp a flex sibling of the text
  // subtracted its width from EVERY line, so a two-line message wrapped into three and
  // the bubble read as crushed. The design (§3.3) puts the stamp below the bubble,
  // outside it, which deletes the whole mechanism: the text flows at the full bubble
  // width with nothing to route around, and there is no width to steal.
  assert.equal(/className="invisible ml-2/.test(src), false, 'no invisible spacer is needed any more');
  assert.equal(src.includes('absolute bottom-0 right-0'), false, 'nor an absolutely-positioned stamp');
  assert.equal(src.includes('const tucked ='), false, 'nor a tucked/untucked split');
  // The stamp is a SIBLING OF THE BUBBLE, in the column that wraps it.
  assert.ok(/flex min-w-0 max-w-full flex-col gap-1/.test(src), 'the bubble and its stamp are a column');
  // `sending` / `failed` replace the stamp with a status and a Retry, on the same line.
  assert.ok(src.includes('Reintentar'), 'a failed send still offers a retry');
  // And the text still wraps on its own terms.
  assert.ok(src.includes('whitespace-pre-wrap break-words'), 'the body keeps its own wrapping');
});

test('inbox: the three voices stay distinguishable — by fill, edge AND side', () => {
  const css = read('app/globals.css');
  // The transcript now has its OWN grey ground, which is what lets the customer bubble
  // be white. Before, the transcript was white and the customer was grey — the two
  // swapped together, because a #eef0f3 bubble on a #eff1f5 ground is a 1% difference.
  assert.ok(/--thread-bg:\s*#edeef1/.test(css), 'light transcript is the grey ground');
  assert.ok(/--thread-bg:\s*#101012/.test(css), 'dark transcript too');
  assert.ok(
    read('components/InboxThread.tsx').includes('bg-[var(--thread-bg)]'),
    'and the thread actually paints it (not bg-surface)',
  );

  // Resolve the tokens PER THEME down to a literal colour and compare THOSE. Two of the
  // light fills are `var()` aliases (--surface, --brand-soft), so comparing the declared
  // text would compare "var(--surface)" against "#22262e" and pass no matter what those
  // aliases point at — the collision this guards against is exactly an alias quietly
  // resolving onto another bubble's colour.
  const themeVars = (theme: 'light' | 'dark') => {
    const map = new Map<string, string>();
    // Dark INHERITS light and overrides it, so the dark map is light + every .dark block.
    const outside: string[] = [];
    const inside: string[] = [];
    // Depth-count braces so a nested at-rule cannot end a block early.
    for (let i = 0; i < css.length; ) {
      const at = css.indexOf('.dark {', i);
      if (at === -1) {
        outside.push(css.slice(i));
        break;
      }
      outside.push(css.slice(i, at));
      let depth = 0;
      let j = css.indexOf('{', at);
      const bodyStart = j + 1;
      for (; j < css.length; j += 1) {
        if (css[j] === '{') depth += 1;
        else if (css[j] === '}') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      inside.push(css.slice(bodyStart, j));
      i = j + 1;
    }
    const declare = (text: string) => {
      for (const m of text.matchAll(/(--[a-z0-9-]+):\s*([^;{}]+);/gi)) map.set(m[1], m[2].trim());
    };
    outside.forEach(declare);
    if (theme === 'dark') inside.forEach(declare);
    return map;
  };
  const resolve = (map: Map<string, string>, name: string): string | undefined => {
    let v = map.get(`--${name}`);
    for (let hops = 0; v && hops < 8; hops += 1) {
      const alias = /^var\(\s*(--[a-z0-9-]+)\s*\)$/i.exec(v);
      if (!alias) return v;
      v = map.get(alias[1]);
    }
    return v;
  };
  for (const theme of ['light', 'dark'] as const) {
    const map = themeVars(theme);
    const inbound = resolve(map, 'bubble-in');
    const bot = resolve(map, 'bubble-bot');
    const agent = resolve(map, 'bubble-agent');
    assert.ok(inbound && bot && agent, `${theme}: all three fills are defined`);
    // TWO fills, not three — and that is the design (§3.3), not a regression.
    //
    // The customer and the human agent are BOTH white. What separates them is the EDGE
    // (a hairline vs a 1px INK border) and the SIDE (left vs right). The old third fill
    // was a brand-red wash on the agent, which put a fourth colour in a thread that only
    // needs to answer "who said this" — and red is now spent elsewhere.
    //
    // So the assertion that matters is no longer "three fills". It is: the BOT is
    // unmistakable by fill alone, and the two white bubbles are told apart by something
    // that is not colour. The border half is asserted below, on the markup.
    assert.notEqual(bot, inbound, `${theme}: the bot's fill is not the customer's`);
    assert.notEqual(bot, agent, `${theme}: nor the agent's`);
    assert.equal(inbound, agent, `${theme}: the two white bubbles share a fill, by design`);
    // None of them may be the ground itself, or that bubble has no edge but its border.
    assert.notEqual(inbound, resolve(map, 'thread-bg'), `${theme}: inbound is not the ground`);
    assert.notEqual(bot, resolve(map, 'thread-bg'), `${theme}: bot is not the ground`);
  }
  assert.ok(css.includes('--color-bubble-bot: var(--bubble-bot)'), 'exposed as a utility');

  // THE AGENT'S EDGE is what carries the distinction the fill no longer does: white with
  // an INK border, in both themes, so a colleague's reply is as loud as the bot's without
  // spending a hue on it.
  assert.equal(css.match(/--bubble-agent-border:\s*var\(--ink\)/g)?.length, 2, 'ink-edged in both themes');
  const transcript = read('components/MessageTranscript.tsx');
  assert.ok(
    transcript.includes('border border-bubble-agent-border bg-bubble-agent'),
    'and the bubble actually draws that edge',
  );
  // …plus the SIDE, which is the redundant cue that makes the pair survive greyscale.
  assert.ok(transcript.includes('rounded-bl-bubble-tail'), 'the customer sits left');
  assert.ok(transcript.includes('rounded-br-bubble-tail'), 'the business sits right');
  // The bot's fill needs no border — a border on a dark fill is invisible and only
  // existed to keep the old three-grey ramp apart.
  assert.equal(/border border-bubble-bot-border/.test(transcript), false, 'the bot is a solid fill, unbordered');
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

test('theme: no gradients, no glassmorphism, and every shadow from a token', () => {
  // The rule moved from "no shadows at all" to "one shadow, from one token", and the
  // rework widened it to THREE tokens — still not to ad-hoc values, which is the thing
  // this test actually protects:
  //   --shadow-card   the 1px lift that separates a card from the canvas
  //   --shadow-float  something that floats OVER content: a dropdown, the composer
  //   --shadow-book   the one red-tinted lift, on `Agendar cita`
  // Three because the three say different things; declared in globals.css because
  // "elevation is a system decision, not a value re-typed per screen" is the rule.
  const SHADOW_TOKENS = ['--shadow-card', '--shadow-float', '--shadow-book'];
  const css = read('app/globals.css');
  for (const t of SHADOW_TOKENS) {
    assert.ok(css.includes(`${t}:`), `${t} is declared at the theme`);
  }
  // GRADIENTS are still banned as a FILL — with one carved-out exception, the avatar
  // spheres, whose whole point is a two-tone gradient (see `[class*='u-avatar-']`). That
  // exception lives in CSS, on one class, which is why the per-component ban below is
  // unchanged: no COMPONENT may reach for `bg-gradient`.
  for (const rel of [CONTACTS_PAGE, RECORD, WORKSPACE, TOOLBAR, 'components/ui/primitives.tsx']) {
    const src = read(rel);
    assert.ok(!src.includes('bg-gradient'), `${rel} uses no gradient`);
    assert.ok(!/backdrop-blur-(?!none)/.test(src), `${rel} uses no glassmorphism`);
    // Tailwind's shadow scale is still banned: it is a value nobody chose.
    assert.ok(!/\bshadow-(sm|md|lg|xl|2xl)\b/.test(src), `${rel} uses no off-the-shelf shadow scale`);
    // …and so is a hand-rolled one. `shadow-[inset_…]` is exempt: an inset rule is a
    // SHAPE (a left marker), not elevation — the same thing `.u-row-selected` does.
    const adHoc = new RegExp(
      `shadow-\\[(?!inset_)(?!var\\((?:${SHADOW_TOKENS.map((t) => t.replace('--', '--')).join('|')})\\))`,
    );
    assert.equal(adHoc.test(src), false, `${rel} rolls no shadow of its own`);
  }

  // The card surfaces DO carry it, and both take the same token.
  for (const rel of ['components/ui/PageShell.tsx', 'components/ui/panelChrome.tsx']) {
    assert.ok(read(rel).includes('shadow-[var(--shadow-card)]'), `${rel} lifts its card with the shared token`);
  }
  assert.ok(/--shadow-card:\s*0 1px 2px/.test(css), 'the token is defined for light');
  // Dark needs its own value: 4% black over a #101012 canvas is a no-op.
  const dark = css.slice(css.indexOf('.dark {'));
  assert.ok(/--shadow-card:/.test(dark), 'and re-defined for dark rather than inherited');
});

test('focus: ONE treatment app-wide, and it does not deform the control', () => {
  const css = read('app/globals.css');
  // The ring is derived from --brand but is NOT --brand: a full-saturation #e60a2f edge
  // fires on every click and was the loudest thing on the screen.
  assert.ok(/--focus-edge:\s*color-mix\(in srgb, var\(--brand\) \d+%, var\(--line-strong\)\)/.test(css), 'the edge is a brand mix');
  // ONE ring, entirely OUTSIDE the control: the border does not change. Tinting it as
  // well drew a second, inner edge, and two concentric red lines around one field read as
  // a slab rather than a highlight.
  assert.equal(/--focus-halo/.test(css), false, 'no inner halo token left behind');
  // IN @layer base, so a utility can override it. Unlayered CSS beats every layer
  // regardless of specificity, which is why `outline-none` on an input never worked and
  // every field drew its own ring INSIDE its wrapper's.
  const layered = css.slice(css.indexOf('App-wide visible focus'));
  assert.ok(/@layer base \{\s*:where\(a, button, input/.test(layered), 'the base focus rule is layered');
  const rule = layered.slice(layered.indexOf(':focus-visible {'));
  const block = rule.slice(0, rule.indexOf('}'));
  assert.ok(block.includes('outline: 2px solid var(--focus-edge)'), 'still a 2px SHAPE, so not colour alone');
  assert.equal(block.includes('var(--brand)'), false, 'and no longer the raw brand');
  // THE BUG. The rule used to set `border-radius: 4px` on the focused element, so any
  // control with a bigger radius snapped its corners the moment it took focus. An outline
  // already follows the element's own radius — there is nothing to set.
  assert.equal(/border-radius/.test(block), false, 'focus never rewrites the control\'s radius');

  // The shared treatment for a control that owns its border, wrapper case included.
  assert.ok(css.includes('.u-focus:focus-visible'), 'u-focus exists');
  assert.ok(css.includes('.u-focus:has(:focus-visible)'), 'and lights a wrapper for the input inside it');
  const uf = css.slice(css.indexOf('.u-focus:focus-visible'), css.indexOf('}', css.indexOf('.u-focus:has(:focus-visible)')));
  assert.ok(uf.includes('outline: 2px solid var(--focus-edge)'), 'the outer ring IS the whole indicator');
  assert.ok(uf.includes('outline-offset: 2px'), 'and it sits clear of the control');
  assert.equal(/border-color/.test(uf), false, 'the control\'s own border is untouched — no inner line');
  assert.equal(/box-shadow/.test(uf), false, 'and no second ring inside it');
  // ONLY THE OUTSIDE, everywhere: a control inside such a wrapper draws nothing at all.
  const inner = css.slice(css.indexOf('.u-focus :focus-visible'));
  assert.ok(inner.slice(0, 60).includes('outline: none'), 'the wrapper\'s ring is the whole indicator');

  // NOTHING is left with an invisible focus. Every control that suppresses its own
  // outline must sit inside a `u-focus` wrapper, or carry a focus style of its own —
  // layering the base rule means `outline-none` now really does suppress the ring, so a
  // field that opted out and had no wrapper would take focus showing nothing at all.
  // A wrapper's `u-focus` often arrives through a shared class constant, so resolve
  // those first rather than only looking for the literal in each file.
  const primitivesSrc = read('components/ui/primitives.tsx');
  const carriers = [...primitivesSrc.matchAll(/export const (\w+) =\s*\n?\s*"([^"]*)"/g)]
    .filter((m) => m[2].includes('u-focus'))
    .map((m) => m[1]);
  assert.ok(carriers.includes('SEARCH_SHELL_CLS'), 'the search shell is one of them');
  for (const rel of allTsx()) {
    const src = read(rel);
    if (!/outline-none/.test(src)) continue;
    const covered =
      /u-focus/.test(src) ||
      carriers.some((c) => src.includes(c)) ||
      /focus:bg-|focus-within:bg-|focus:border|focus-visible/.test(src);
    assert.ok(covered, `${rel} suppresses its outline, so something there must still show focus`);
  }

  // NO second or third vocabulary anywhere. Before this there were three: the global
  // brand outline, `focus:border-brand` on assorted inputs, and a near-black
  // `focus:ring-foreground` in the contact form — so clicking into a field looked
  // different depending on which screen you were on.
  for (const rel of allTsx()) {
    const src = read(rel);
    assert.equal(/focus(-within)?:border-brand/.test(src), false, `${rel} rolls no brand focus border`);
    assert.equal(/focus(-within)?:ring-(foreground|brand)/.test(src), false, `${rel} rolls no focus ring`);
  }
});

test('a card that hosts a dropdown does not clip it away', () => {
  const shell = read('components/ui/PageShell.tsx');
  // The clip is still the DEFAULT — it is what makes the radius survive a full-bleed
  // table — but it is now opt-out, because `overflow-hidden` on an ancestor clips
  // absolutely-positioned descendants too.
  assert.ok(shell.includes('clip = true'), 'clipping stays the default');
  assert.ok(/clip \? "overflow-hidden" : ""/.test(shell), 'and can be turned off per card');

  // The COLUMNAS menu is absolute inside the toolbar card, so that card must opt out.
  // Without this the menu was cut off a few px below the button and looked like it
  // never opened.
  const page = read(CONTACTS_PAGE);
  // BOTH cards opt out now: the title card so the search field's focus ring is not
  // clipped, and the TABLE card because the facet row beside it hosts the Filtrar /
  // Orden / Columnas popovers.
  assert.ok(page.includes('<PageShell grow={false} clip={false}>'), 'the title card opts out');
  assert.ok(page.includes('<PageShell clip={false}>'), 'and so does the table card, which holds the menus');
  const toolbarSrc = read('components/contacts/ContactsToolbar.tsx');
  // The three menus (Filtrar / Orden / Columnas) share ONE popover, so the positioning is
  // interpolated (`right-0` or `left-0`) rather than a fixed literal. What must hold is
  // that it is absolutely positioned inside the card at all.
  assert.ok(/absolute \$\{align === "right" \? "right-0" : "left-0"\} top-full z-50/.test(toolbarSrc),
    'because the menu it holds is positioned inside it');
  // ONE popover for all three, so they cannot drift into three dismissal behaviours.
  assert.equal((toolbarSrc.match(/top-full z-50/g) ?? []).length, 1, 'and there is exactly one such popover');
  // A card that opts out must have nothing full-bleed to clip — the toolbar card's rows
  // are padded, so there is no radius to protect.
  const card1 = page.slice(page.indexOf('clip={false}'), page.indexOf('CARD 2 —'));
  assert.equal(/className="[^"]*\b(-mx-|w-screen)/.test(card1), false, 'and nothing in it bleeds to the edge');

  // Any OTHER card holding a top-full menu would need the same opt-out; assert there is
  // no second one silently clipped.
  const offenders = allTsx().filter(
    (rel) => /absolute[^"]*top-full/.test(read(rel)) && rel !== 'components/contacts/ContactsToolbar.tsx',
  );
  assert.deepEqual(offenders, [], `every top-full menu is accounted for, found: ${offenders.join(', ')}`);
});

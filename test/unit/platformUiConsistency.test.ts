import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CORE_TEMPLATE,
  TABLET_TEMPLATE,
  mobileRowLines,
  templateMinWidth,
  withOptionalTracks,
} from '../../web/lib/contactListLayout.js';
import { createDraftKey, type ContactFormValues } from '../../web/lib/contactForm.js';
import { keyboardInset } from '../../web/lib/keyboardInset.js';
import { formatDayLabelEs, formatLocalDate, formatLocalDateTime, formatTime24 } from '../../web/lib/format.js';
import { agendaDateKey } from '../../web/lib/contactShared.js';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../../web/${rel}`, import.meta.url)), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ── Block 1: ONE control vocabulary ─────────────────────────────────────────────

test('the Scheduling controls are the shared ones, re-exported unchanged', () => {
  const sys = read('components/scheduling/ui/system.tsx');
  assert.ok(sys.includes('export * from "@/components/ui/controls";'));
  const controls = read('components/ui/controls.tsx');
  // The reference geometry, verbatim: 44px on touch, 40/36 from lg; ink primary.
  assert.ok(controls.includes('md: "h-[44px] px-4 lg:h-[40px]"'));
  assert.ok(controls.includes('primary: "bg-ink font-semibold text-ink-fg hover:bg-ink-hover"'));
  assert.ok(controls.includes('size-[44px]') && controls.includes('lg:size-[36px]'), 'icon buttons are 44px on touch');
  // Scheduling's own pieces stay in its file.
  for (const name of ['StatusChip', 'AttentionChip', 'Avatar']) assert.ok(sys.includes(`export function ${name}`), name);
});

test('the contact forms build from the shared controls, not the 32px BTN_* set', () => {
  for (const rel of [
    'components/contacts/form/ContactCreateForm.tsx',
    'components/contacts/form/ContactEditForm.tsx',
    'components/contacts/form/ContactFormDrawer.tsx',
  ]) {
    const src = strip(read(rel));
    assert.doesNotMatch(src, /\bBTN_(PRIMARY|SECONDARY|QUIET|DANGER)\b/, `${rel}: no legacy footer buttons`);
    assert.doesNotMatch(src, /PANEL_CLOSE_CLS/, `${rel}: no 23px close control`);
  }
  assert.match(read('components/contacts/form/ContactCreateForm.tsx'), /buttonClass\(\{ variant: "primary" \}\)/);
  assert.match(read('components/contacts/form/ContactEditForm.tsx'), /buttonClass\(\{ variant: "destructive" \}\)/, 'Sí, eliminar is the destructive variant');
  assert.match(read('components/contacts/form/ContactFormDrawer.tsx'), /<IconButton label="Cerrar"/, 'Cerrar is the shared 44px icon button');
});

test('form fields are real 44px touch targets with 16px text on phones, desktop unchanged', () => {
  const p = read('components/contacts/form/formPrimitives.tsx');
  assert.match(p, /export const INPUT_CLS =\s*"[^"]*max-lg:min-h-\[44px\] max-md:text-\[16px\]"/);
  assert.match(p, /max-lg:h-\[42px\] max-md:text-\[16px\]/, 'the text input inside its 1px border = 44px');
  assert.match(p, /h-\[44px\] w-\[52px\][\s\S]{0,200}h-5 w-9/, 'the switch is a 44px button around the same 20×36 track');
});

test('an invalid identity is an ERROR at its field — red edge, danger text, described-by', () => {
  const s = read('components/contacts/form/IdentitySection.tsx');
  assert.match(s, /invalid=\{invalid\}\s*ariaDescribedBy=\{invalid \? errorId : undefined\}/);
  assert.match(s, /<p id=\{errorId\} className="[^"]*text-danger"/);
  // The focus ring stays the shared outline; the error is the BORDER (TextInput), so the
  // two never read as the same thing.
  assert.match(read('components/contacts/form/formPrimitives.tsx'), /invalid \? "border-danger" : "border-line-strong"/);
});

// ── Block 2.1: the header's opt-in phone layout ────────────────────────────────

test('ModuleHeader: the two-row phone layout is opt-in; other modules keep their markup', () => {
  const h = read('components/ui/ModuleHeader.tsx');
  assert.ok(h.includes('if (primary !== undefined) {'), 'only callers that pass `primary` get it');
  // The default (Agenda, Staff, Reuniones…) is the grid it always was.
  assert.ok(h.includes('grid-cols-[minmax(0,1fr)_auto] items-center gap-2.5 px-3 py-2.5 sm:px-4 md:grid-cols-[auto_minmax(15rem,1fr)_auto]'));
  assert.ok(h.includes('order-3 h-0 basis-full md:hidden'), 'below md, search + actions always start row two');
  assert.ok(h.includes('[&>button]:!h-[44px]') && h.includes('lg:[&>button]:!h-[34px]'), '44px on phones/tablets, 34px only on desktop');
  const toolbar = read('components/contacts/ContactsToolbar.tsx');
  assert.ok(toolbar.includes('max-lg:h-[44px]') && toolbar.includes('max-lg:size-[44px]'), 'nested filter, overflow and search controls retain touch targets through tablet');
  const page = read('app/clients/[clientId]/contacts/page.tsx');
  assert.ok(page.includes('primary={<NewContactButton />}'), 'Contacts opts in');
  for (const rel of ['app/clients/[clientId]/scheduling/agenda/page.tsx', 'components/scheduling/staff/StaffHeaderCard.tsx']) {
    assert.ok(!/<ModuleHeader[^>]*\bprimary=/.test(read(rel)), `${rel} does not opt in`);
  }
});

// ── Block 2.2: the list at three widths ────────────────────────────────────────

test('tablet: the table fits the ~723px a 768px screen leaves; desktop keeps the design', () => {
  assert.ok(templateMinWidth(TABLET_TEMPLATE) <= 723, `tablet needs ${templateMinWidth(TABLET_TEMPLATE)}px`);
  assert.ok(templateMinWidth(CORE_TEMPLATE) <= 860, 'the desktop floor stays the designed 860px');
  assert.equal(CORE_TEMPLATE.split(' ').length, 7, 'seven desktop columns');
  assert.equal(TABLET_TEMPLATE.split(' ').length, 6, 'tablet drops only Visitas');
  assert.ok(TABLET_TEMPLATE.endsWith(' 44px'), 'and its record link is a 44px target');
  // Optional columns splice in before the record link on both.
  assert.equal(withOptionalTracks('a b c', 2), 'a b minmax(110px,1fr) minmax(110px,1fr) c');
  const t = read('components/contacts/ContactsTable.tsx');
  assert.match(t, /<span role="columnheader" className="max-lg:hidden">Visitas<\/span>/);
  assert.match(t, /className="hidden md:block md:min-w-\[680px\] lg:min-w-\[860px\]"/);
});

test('phone: one compact row — who, how to reach them, and a 44px way into the record', () => {
  assert.deepEqual(mobileRowLines({ name: ' Ana ', channel_user_id: 'wa1', phone_e164: '+573001112233', email: 'a@b.co' }), {
    title: 'Ana',
    titleIsId: false,
    identity: '+573001112233',
    identityKind: 'phone',
  });
  assert.equal(mobileRowLines({ name: null, channel_user_id: 'wa1', phone_e164: null, email: 'a@b.co' }).identity, 'a@b.co');
  assert.equal(mobileRowLines({ name: null, channel_user_id: 'wa1', phone_e164: null, email: null }).identityKind, 'none');
  assert.equal(mobileRowLines({ name: null, channel_user_id: 'wa1', phone_e164: null, email: null }).identity, 'Ver datos en la ficha', 'a sparse list projection must not claim canonical identities are absent');
  assert.equal(mobileRowLines({ name: '', channel_user_id: 'wa1', phone_e164: null, email: null }).titleIsId, true);
  const t = read('components/contacts/ContactsTable.tsx');
  assert.match(t, /<ul aria-label="Contactos" className="md:hidden">/);
  assert.match(t, /href=\{hrefWith\(\{ c: c\.id \}\)\}[\s\S]{0,400}after:absolute after:inset-0/, 'the row opens the quick view');
  assert.match(t, /min-h-\[72px\]/, 'each row is a tall target');
  assert.match(t, /size-\[44px\][^"]*"[\s\S]{0,40}<span aria-hidden>→<\/span>/, 'the record link is 44×44');
});

// ── Block 2.3–2.4: drafts and the keyboard ─────────────────────────────────────

const BLANK: ContactFormValues = {
  name: '',
  stage: 'new',
  assignedTo: 'u1',
  preferredChannel: null,
  doNotContact: false,
  consent: 'unknown',
  customFields: {},
  tags: [],
};

test('a draft is "dirty" only with REAL changes', () => {
  const clean = createDraftKey(BLANK, [''], [''], '');
  assert.equal(createDraftKey(BLANK, ['', '  '], [''], '   '), clean, 'empty rows and whitespace are nothing');
  assert.equal(createDraftKey({ ...BLANK, name: '  ' }, [''], [''], ''), clean);
  assert.notEqual(createDraftKey(BLANK, ['+57300'], [''], ''), clean, 'a typed phone is a draft');
  assert.notEqual(createDraftKey({ ...BLANK, doNotContact: true }, [''], [''], ''), clean, 'a toggle is a draft');
  assert.notEqual(createDraftKey({ ...BLANK, assignedTo: 'u2' }, [''], [''], ''), clean, 'a different owner is a draft');
  assert.equal(
    createDraftKey({ ...BLANK, tags: ['b', 'a'], customFields: { y: 1, x: 2 } }, [''], [''], ''),
    createDraftKey({ ...BLANK, tags: ['a', 'b'], customFields: { x: 2, y: 1 } }, [''], [''], ''),
    'order does not make a change',
  );
});

test('the keyboard inset is what the keyboard covers, ignoring browser-chrome jitter', () => {
  assert.equal(keyboardInset(844, 844, 0), 0);
  assert.equal(keyboardInset(844, 800, 0), 0, '44px of URL bar settling is not a keyboard');
  assert.equal(keyboardInset(844, 508, 0), 336);
  assert.equal(keyboardInset(844, 508, 20), 316, 'a scrolled visual viewport counts its offset');
  const drawer = read('components/contacts/form/ContactFormDrawer.tsx');
  assert.match(drawer, /style=\{keyboard \? \{ bottom: keyboard \} : undefined\}/, 'the sheet rises above the keyboard');
});

test('the phone form sheet is full width; sm+ keeps the shared panel width', () => {
  for (const rel of ['components/contacts/form/ContactFormDrawer.tsx', 'components/contacts/ContactSidePanel.tsx']) {
    const src = read(rel);
    assert.ok(src.includes('fixed inset-y-0 right-0 z-50 flex xl:contents max-sm:left-0'), `${rel}: full-bleed on a phone`);
    assert.ok(src.includes('flex w-full shrink-0 self-stretch sm:w-[var(--contact-panel-region-w)] sm:max-w-[90vw]'), `${rel}: one region geometry`);
    assert.ok(src.includes('"--contact-panel-region-w": CONTACT_PANEL_WIDTH'), `${rel}: from the shared constant`);
  }
});

// ── Block 2.5 + copy: the record ───────────────────────────────────────────────

test('record header on a phone: actions on their own row, 44px; desktop row unchanged', () => {
  const r = read('components/contacts/ContactRecord.tsx');
  assert.match(r, /flex shrink-0 flex-wrap items-center gap-2 max-sm:basis-full max-sm:\[&>\*\]:flex-1/);
  assert.match(r, /max-sm:h-\[44px\]/);
  assert.match(r, /max-sm:\[&_button\]:min-h-\[44px\] max-sm:\[&_button\]:min-w-\[44px\] max-sm:\[&_a\]:min-h-\[44px\] max-sm:\[&_a\]:min-w-\[44px\]/, 'scoped to the record, not the shared sections');
  assert.match(r, /xl:grid-cols-\[300px_minmax\(0,1fr\)_340px\]/, 'three columns on desktop');
});

test('dates read like Scheduling: Spanish, 24-hour, in the site timezone — never a hard-coded city', () => {
  const at = '2026-10-09T20:30:00.000Z';
  assert.equal(formatLocalDateTime(at, 'America/Bogota'), '9 oct 2026, 15:30');
  assert.equal(formatLocalDateTime(at, 'Europe/Madrid'), '9 oct 2026, 22:30');
  assert.equal(formatLocalDateTime('2026-09-09T20:30:00.000Z', 'America/Mexico_City'), '9 sep 2026, 14:30', 'three-letter months');
  assert.equal(formatTime24(at, 'America/Bogota'), '15:30');
  assert.equal(formatLocalDate(at, 'America/Bogota'), '9 oct 2026');
  const now = new Date();
  assert.equal(formatDayLabelEs(now, now), 'Hoy');
  assert.equal(formatDayLabelEs(new Date(now.getTime() - 86_400_000), now), 'Ayer');
  assert.equal(formatLocalDateTime('nope'), '—');
  for (const rel of [
    'components/contacts/shared/AppointmentsSection.tsx',
    'components/contacts/ContactTimeline.tsx',
    'components/contacts/shared/NotesSection.tsx',
    'components/contacts/shared/TasksSection.tsx',
  ]) {
    const src = read(rel);
    assert.doesNotMatch(src, /formatDateTime\(|formatChatTime\(|formatDayLabel\(/, `${rel}: no English 12-hour formatter`);
    assert.doesNotMatch(src, /America\/Bogota/, `${rel}: no hard-coded timezone`);
  }
  assert.match(read('components/contacts/shared/AppointmentsSection.tsx'), /formatLocalDateTime\(appt\.startAt, appt\.siteTimezone\)/);
  assert.match(read('components/contacts/shared/TasksSection.tsx'), /vence el/);
});

test('Spanish labels on the touched surfaces; internal keys unchanged', () => {
  assert.match(read('components/contacts/form/ContactFormSections.tsx'), /<Field label="Etapa">/);
  assert.match(read('components/contacts/form/ContactSections.tsx'), /<ReadField label="Etapa">/);
  assert.match(read('lib/contactColumns.ts'), /\{ key: "stage", label: "Etapa" \}/, 'the key stays `stage`');
});

test('appointment links use their OWN site-local day across midnight', () => {
  const iso = '2026-10-10T02:15:00.000Z';
  assert.equal(agendaDateKey(iso, 'America/Bogota'), '2026-10-09');
  assert.equal(agendaDateKey(iso, 'Europe/Madrid'), '2026-10-10');
  assert.equal(agendaDateKey(iso), '2026-10-10', 'legacy callers retain the UTC fallback');
  const record = read('components/contacts/ContactRecord.tsx');
  assert.match(record, /appointmentTimezones=\{Object.fromEntries/);
  assert.doesNotMatch(record, /timezone=\{props.appointments.next/);
  assert.match(read('components/contacts/ContactTimeline.tsx'), /appointmentTimezones\[str\(it.ref.appointmentId\)/);
  assert.match(read('components/contacts/shared/AppointmentsSection.tsx'), /agendaDateKey\(a.startAt, a.siteTimezone\)/);
});

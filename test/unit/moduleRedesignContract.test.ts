import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { MODULE_RAIL_COOKIE, moduleRailCookie, parseModuleRailOpen } from '../../web/lib/moduleRail.ts';

/**
 * SOURCE CONTRACT for the module redesign (Catálogo, Presencia y marketing, Configuración
 * on the shared components/ui/module kit). The screens are client components behind
 * server gates that cannot run headless, so the invariants that protect behaviour —
 * status codes, who sees what, what is NOT offered — are pinned at the source, like the
 * other UI contracts. Behaviour of the server actions keeps its own integration tests.
 */

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (path: string) => readFileSync(`${root}${path}`, 'utf8');
/** Source without comments, so a rule written in a doc comment never trips a check. */
const code = (path: string) => read(path).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const C = 'web/app/clients/[clientId]';
const MODULE_ROUTES = [
  'scheduling/services',
  'scheduling/promotions',
  'scheduling/booking-page',
  'scheduling/reviews',
  'scheduling/sites',
  'scheduling/rules',
  'catalog',
  'campaigns',
  'contacts/fields',
  'team',
];

test('module rail preference: open by default, folded only on an explicit 0', () => {
  assert.equal(parseModuleRailOpen(undefined), true);
  assert.equal(parseModuleRailOpen(''), true);
  assert.equal(parseModuleRailOpen('junk'), true);
  assert.equal(parseModuleRailOpen('1'), true);
  assert.equal(parseModuleRailOpen('0'), false);
  assert.match(moduleRailCookie(false), new RegExp(`^${MODULE_RAIL_COOKIE}=0; path=/;`));
  assert.match(moduleRailCookie(true), new RegExp(`^${MODULE_RAIL_COOKIE}=1; path=/;`));
  // Read during SSR (no hydration mismatch), like the sidebar's collapsed cookie.
  const layout = read('web/app/layout.tsx');
  assert.ok(layout.includes('parseModuleRailOpen(jar.get(MODULE_RAIL_COOKIE)?.value)'));
  assert.ok(layout.includes('moduleRailOpen={moduleRailOpen}'));
});

test('denied module pages keep answering 404: no loading boundary in front of the gate', () => {
  // A loading.tsx streams the response before the page's permission gate runs; a denied
  // page then answered HTTP 200 (+noindex) instead of 404. The routes keep error.tsx and
  // not-found.tsx (neither changes the status) and must not regain a loading.tsx.
  for (const r of MODULE_ROUTES) {
    assert.equal(existsSync(`${root}${C}/${r}/loading.tsx`), false, `${r} has no loading.tsx`);
    assert.ok(existsSync(`${root}${C}/${r}/not-found.tsx`), `${r} has its no-access state`);
    assert.ok(existsSync(`${root}${C}/${r}/error.tsx`), `${r} has its load-error state`);
    assert.ok(read(`${C}/${r}/error.tsx`).includes('retry={unstable_retry}'), `${r} retries by re-fetching`);
  }
});

test('the module surface is the shell panel itself — no card inside the panel', () => {
  const surface = read('web/components/ui/module/ModuleSurface.tsx');
  const main = surface.slice(surface.indexOf('export function ModuleSurface'), surface.indexOf('/** Title band'));
  assert.ok(main.includes('-m-[var(--content-pad)]'), 'cancels the content gutter');
  assert.ok(!/rounded-|border |shadow-/.test(main), 'draws no border, radius or shadow of its own');
});

test('list filters live in the URL and are synced into the router', () => {
  const hook = read('web/components/ui/module/useUrlState.ts');
  assert.ok(hook.includes('window.history.replaceState(rest'), 'replaceState, no history entry per keystroke');
  assert.ok(hook.includes('__NA: _na'), 'strips the router state so useSearchParams re-syncs');
});

test('Reseñas: the importer link is for PLATFORM admins only; imported reviews are read-only', () => {
  const page = read(`${C}/scheduling/reviews/page.tsx`);
  assert.ok(page.includes('requirePlatformAdmin()'), 'decided by the platform allow-list');
  assert.ok(page.includes('canImport={platform !== null}'));
  assert.ok(page.includes('requireClientModulePage(clientId, "scheduling", "reviews.moderate")'), 'the page gate: module + reviews.moderate');
  const screen = read('web/components/scheduling/reviews/ReviewsScreen.tsx');
  assert.ok(screen.includes('canImport ? (') && screen.includes('href="/platform/reviews"'), 'only a link to the existing importer');
  assert.ok(!screen.includes('platformReviewActions'), 'the business screen never calls platform actions');
  // Only the business's own reviews are moderated from here; imported ones can only be asked about.
  assert.ok(screen.includes('requestExternalReviewAction(clientId, row.id, request, note)'));
  assert.ok(!/Verificada por una cita/i.test(screen), 'an imported review is never presented as verified by an M_AI appointment');
});

test('Productos: an informative catalogue — no images, booking-page toggle, «A consultar», cart or stock counts', () => {
  const src = read('web/components/catalog/CatalogPanel.tsx');
  for (const forbidden of ['type="file"', 'public_visible', 'priceMode', 'quantity', 'stock_qty', 'cart']) {
    assert.ok(!code('web/components/catalog/CatalogPanel.tsx').includes(forbidden), `no ${forbidden}`);
  }
  assert.ok(src.includes('Los productos no admiten «A consultar»'), 'the price rule is explained, not a new option');
  assert.ok(src.includes('canManage ?') && src.includes('<ReadOnlyBanner>'), 'setters read (and toggle stock) only');
});

test('Campañas: nothing on the screen sends or schedules a message', () => {
  const src = read('web/components/campaigns/CampaignsPanel.tsx');
  const imports = src.slice(src.indexOf('from "@/lib/campaignsActions"') - 400, src.indexOf('from "@/lib/campaignsActions"'));
  assert.ok(!/send|schedule|dispatch/i.test(imports), 'only the existing campaign / ad actions');
  assert.ok(!/En preparación|Programada|Enviada/.test(code('web/components/campaigns/CampaignsPanel.tsx')), 'no invented campaign states');
  assert.ok(src.includes('active: "Activa"') && src.includes('paused: "En pausa"') && src.includes('ended: "Finalizada"'));
});

test('Promociones: real states only, and the 2×1 is decided by the day of the appointment', () => {
  const src = read('web/components/scheduling/promotions/PromotionsSection.tsx');
  assert.ok(src.includes('draft: "Borrador", published: "Publicada", paused: "Pausada", archived: "Archivada"'));
  assert.ok(!/Programada|Finalizada/.test(code('web/components/scheduling/promotions/PromotionsSection.tsx')), 'no derived states presented as statuses');
  assert.ok(src.includes('día de la cita'), 'the appointment window is explained as the appointment day');
  assert.ok(src.includes('canMove(row.status, "published")') && src.includes('setPromotionStatusAction('), 'moves stay the allowed ones');
});

test('Servicios: «A consultar» (NULL) and a price of 0 stay different', () => {
  const editor = read('web/components/scheduling/services/ServiceEditor.tsx');
  assert.ok(editor.includes('price: priceMode === "consultar" ? "" : form.price'), 'A consultar saves NULL');
  assert.ok(editor.includes('Escribe el precio o elige «A consultar».'), 'a fixed price must be written (0 is valid)');
  assert.ok(editor.includes('Un precio de 0 se muestra como $0'), 'the difference is said beside the field');
});

test('Usuarios y accesos: one definition of who may act on a login, shared by both team screens', () => {
  const members = read('web/components/TeamMembers.tsx');
  const access = read('web/components/team/ClientAccessScreen.tsx');
  assert.ok(members.includes('export function canActOnMember('));
  assert.ok(members.includes('const manageable = canActOnMember(member, viewer);'));
  assert.ok(access.includes('const manageable = canActOnMember(member, viewer);'));
  // The roles offered are exactly those the viewer may grant — computed on the SERVER
  // (canGrantRole: the Dueño only for the agency), never re-derived in the browser.
  assert.ok(access.includes('const choices = viewer.assignable;'));
  assert.ok(access.includes('const roleOptions = choices.map((c) => ({ value: c.value, label: c.label }));'));
  // The page still loads no staff row (PII contract) and keeps its gate.
  const page = read(`${C}/team/page.tsx`);
  assert.ok(page.includes('if (!can(scope, "access.users.view", clientId)) notFound();'));
  assert.ok(page.includes('canGrantRole(scope, clientId, { kind: "system", key: k }).ok'));
  // Who may act on each row is decided on the SERVER with the delegation rules.
  assert.ok(page.includes('canManage: ref ? canManageMember(scope, clientId, { userId: m.user_id, role: ref }).ok : false'));
});

test('Campos personalizados: key and type are fixed, nothing is deleted', () => {
  const src = read('web/components/contacts/FieldDefinitions.tsx');
  assert.ok(src.includes('No se puede cambiar: es como la guardan los contactos y la API.'));
  assert.ok(src.includes('El tipo no se puede cambiar'));
  assert.ok(!/deleteFieldDefinition|Eliminar campo/.test(src), 'no delete');
  // Editing a select only ADDS options: the stored ones are kept.
  assert.ok(src.includes('const allOptions = [...new Set([...f.options, ...added])];'));
});

test('shared search: the input IS the 44px target and the clear button has its own strip', () => {
  const src = read('web/components/ui/module/ModuleSurface.tsx');
  const field = src.slice(src.indexOf('export function SearchField'), src.indexOf('/**\n * Side menu + content.'));
  // The input covers the whole box, border included — not a shorter field in a 44px frame.
  assert.ok(field.includes('absolute -inset-y-px -left-px'), 'the input fills the box (tapping the edge focuses it)');
  assert.ok(field.includes('h-[44px]'), 'a 44px box on phones');
  assert.ok(field.includes('pointer-events-none absolute left-3'), 'the icon lets the tap through to the input');
  // «Borrar búsqueda»: 44 wide, full height, and the input stops before it (no overlap).
  assert.ok(field.includes('aria-label="Borrar búsqueda"') && field.includes('absolute -inset-y-px -right-px inline-flex w-11'));
  assert.ok(field.includes('value ? "right-11 pr-1 lg:right-10" : "-right-px pr-3"'), 'the input yields the strip to the button');
});

test('Página de reservas: a rejected WhatsApp / Maps value is marked on its own input', () => {
  const src = read('web/components/scheduling/settings/BookingPageScreen.tsx');
  assert.ok(src.includes('aria-invalid={invalid === "publicWhatsapp" || undefined}'));
  assert.ok(src.includes('aria-describedby={invalid === "publicWhatsapp" ? CONTACT_ERROR_ID.publicWhatsapp : undefined}'));
  assert.ok(src.includes('publicWhatsapp: "bp-contact-whatsapp-error"'), 'a stable id for the message');
  assert.ok(src.includes('<FieldError id={CONTACT_ERROR_ID.publicWhatsapp}>'), 'the message carries that id');
  assert.ok(src.includes('Lo que escribiste se conserva.'), 'the value stays as written');
  // The server names the field; the rules themselves are unchanged (siteContactValidation.test.ts).
  const actions = read('web/lib/schedulingAdminActions.ts');
  assert.ok(actions.includes('return { ok: false, error: contact.error, field: contact.field };'));
});

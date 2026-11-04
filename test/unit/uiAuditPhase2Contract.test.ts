import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

/**
 * Auditoría UI 2026-11-03, fase 2 (F04): every scheduling screen that needs a site draws
 * the SAME «Aún no hay sedes» — the approved pattern Sedes uses — keeps its own header,
 * and offers «Ir a Sedes» only to a login that may create sites.
 */
const read = (rel: string) => readFileSync(new URL(`../../web/${rel}`, import.meta.url), 'utf8');

const SCREENS: Array<[string, string]> = [
  ['app/clients/[clientId]/scheduling/agenda/page.tsx', 'Agenda'],
  ['components/scheduling/staff/StaffWorkspace.tsx', 'Equipo'],
  ['components/scheduling/schedule/HoursScreen.tsx', 'Horarios'],
  ['components/scheduling/settings/RulesScreen.tsx', 'Reglas'],
  ['components/scheduling/OccupancyPanel.tsx', 'Ocupación'],
  ['components/scheduling/settings/BookingPageScreen.tsx', 'Página de reservas'],
];

test('the shared no-site state is the approved EmptyState, with the action gated', () => {
  const src = read('components/scheduling/NoSitesState.tsx');
  assert.ok(src.includes('import { EmptyState } from "@/components/ui/module/States"'));
  assert.ok(src.includes('title="Aún no hay sedes"'));
  assert.match(src, /\{canManageSites \? \([\s\S]{0,400}?<Link href=\{schedulingHref\(clientId, "sites"\)\}/, '«Ir a Sedes» only with the permission');
  assert.ok(src.includes('Pide a quien administra el negocio'), 'without it, who can do it');
  // Inside the agenda family (.u-ag) the compact density drops buttons to 32px from 768px:
  // the action keeps a 44px touch floor below lg, desktop keeps its density.
  assert.ok(src.includes('buttonClass({ variant: "primary", className: "max-lg:min-h-[44px]" })'), '44px touch floor below lg');
});

test('every no-site screen uses it, and none keeps an old variant', () => {
  for (const [file, name] of SCREENS) {
    const src = read(file);
    assert.ok(src.includes('<NoSitesState'), `${name} draws the shared state`);
    assert.ok(!src.includes('Configuración de agenda primero') && !src.includes('Configuración → Sedes'), `${name}: no stale «Configuración» route`);
  }
  const agenda = read(SCREENS[0][0]);
  assert.ok(!agenda.includes('border-dashed'), 'Agenda: no dashed frame');
  assert.ok(agenda.includes('<SurfaceHeader title="Agenda" />'), 'Agenda keeps its title');
  const hours = read(SCREENS[2][0]);
  const noSite = hours.slice(hours.indexOf('if (!site) {'), hours.indexOf('if (!site) {') + 700);
  assert.ok(noSite.includes('<AgPageHeader id="hours-title" title="Horarios y ausencias"'), 'Horarios keeps its header without a site');
});

test('the permission comes from the server, per page', () => {
  for (const page of ['hours', 'rules', 'booking-page', 'staff']) {
    assert.ok(read(`app/clients/[clientId]/scheduling/${page}/page.tsx`).includes('can(scope, "settings.sites", client.id)'), page);
  }
  assert.ok(read('app/clients/[clientId]/scheduling/agenda/page.tsx').includes('canManageSites={can(scope, "settings.sites", client.id)}'));
  assert.equal((read('lib/occupancyData.ts').match(/canSites: can\(scope, "settings\.sites", client\.id\)/g) ?? []).length, 2, 'both occupancy results');
});

test('no controls for a frame that cannot fill', () => {
  const occ = read('components/scheduling/OccupancyPanel.tsx');
  assert.ok(occ.includes('{noSites ? null : ('), 'Ocupación hides Día/Semana/Mes and ‹ › without a site');
  const bp = read('components/scheduling/settings/BookingPageScreen.tsx');
  assert.match(bp, /\{preview \? \(\s*<button[\s\S]*?Ocultar vista previa/, 'no preview toggle without a preview');
});

test('the phone rules screen says the same and gates the same', () => {
  const src = read('components/scheduling/mobile/config/RulesMobile.tsx');
  assert.ok(src.includes('Aún no hay sedes'));
  assert.match(src, /\{canSites \? \(\s*<MButton kind="primary" onClick=\{\(\) => nav\.go\("sedes"\)\}>/);
});

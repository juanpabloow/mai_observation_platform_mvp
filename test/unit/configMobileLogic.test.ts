import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  addDays,
  blockDraft,
  blockPayload,
  blockWhen,
  dayError,
  dayFromIntervals,
  daySummary,
  intervalsFromDay,
  openDaysSummary,
  ruleExample,
  ruleLabel,
  ruleOptions,
  slugify,
  storedFromWeek,
  suggestPause,
  timeOptions,
  tzLabel,
  weekFromStored,
  formatThousands,
} from '../../web/components/scheduling/mobile/config/logic.js';
import { gridFromWeekly, weeklyFromGrid } from '../../web/components/scheduling/HoursGrid.js';

/**
 * BEHAVIOUR of the phone Configuración helpers (web/components/scheduling/mobile/config/
 * logic.ts) — hours with pauses, block wording and payloads, booking-rule examples.
 * Bogotá is UTC-5 all year, so 13:00 local = 18:00Z.
 */
const TZ = 'America/Bogota';

test('a day with a lunch pause round-trips losslessly (pauses = gaps between intervals)', () => {
  const stored = [{ start: '09:00', end: '13:00' }, { start: '14:00', end: '19:00' }];
  const day = dayFromIntervals(stored);
  assert.deepEqual(day, { on: true, start: '09:00', end: '19:00', pauses: [{ start: '13:00', end: '14:00' }] });
  assert.deepEqual(intervalsFromDay(day), stored);
  assert.deepEqual(dayFromIntervals([]), { on: false, start: '09:00', end: '18:00', pauses: [] });
  assert.deepEqual(intervalsFromDay({ ...day, on: false }), [], 'a closed day stores nothing');
  const week = weekFromStored({ mon: stored, sat: [{ start: '10:00', end: '14:00' }] });
  assert.deepEqual(storedFromWeek(week), { mon: stored, sat: [{ start: '10:00', end: '14:00' }] });
});

test('a pause outside the new hours is dropped, never saved as a negative interval', () => {
  assert.deepEqual(intervalsFromDay({ on: true, start: '09:00', end: '12:00', pauses: [{ start: '13:00', end: '14:00' }] }), [
    { start: '09:00', end: '12:00' },
  ]);
});

test('day validation says what is wrong', () => {
  assert.equal(dayError({ on: true, start: '18:00', end: '09:00', pauses: [] }), 'El cierre debe ser después de la apertura.');
  assert.equal(dayError({ on: true, start: '09:00', end: '18:00', pauses: [{ start: '08:00', end: '10:00' }] }), 'La pausa debe quedar dentro del horario del día.');
  assert.equal(
    dayError({ on: true, start: '09:00', end: '18:00', pauses: [{ start: '12:00', end: '14:00' }, { start: '13:00', end: '15:00' }] }),
    'Las pausas no pueden solaparse.',
  );
  assert.equal(dayError({ on: true, start: '09:00', end: '18:00', pauses: [{ start: '13:00', end: '14:00' }] }), null);
  assert.equal(dayError({ on: false, start: '18:00', end: '09:00', pauses: [] }), null, 'a closed day is never invalid');
});

test('a new pause defaults to lunch when it fits, else the middle of the free stretch', () => {
  assert.deepEqual(suggestPause({ on: true, start: '09:00', end: '19:00', pauses: [] }), { start: '13:00', end: '14:00' });
  const morning = suggestPause({ on: true, start: '06:00', end: '12:00', pauses: [] });
  assert.ok(morning && dayError({ on: true, start: '06:00', end: '12:00', pauses: [morning] }) === null, 'the suggestion is itself valid');
  assert.equal(suggestPause({ on: true, start: '09:00', end: '09:30', pauses: [] }), null, 'no room → no button');
});

test('the desktop hours grid keeps a pause made on the phone', () => {
  const weekly = { mon: [{ start: '09:00', end: '13:00' }, { start: '14:00', end: '19:00' }] };
  const grid = gridFromWeekly(weekly as never);
  assert.equal(grid.mon.start, '09:00');
  assert.equal(grid.mon.end, '19:00');
  assert.deepEqual(weeklyFromGrid(grid), weekly, 'saving from desktop does not drop the afternoon');
  assert.deepEqual(weeklyFromGrid({ ...grid, mon: { ...grid.mon, end: '20:00' } }).mon, [
    { start: '09:00', end: '13:00' },
    { start: '14:00', end: '20:00' },
  ]);
  const single = gridFromWeekly({ tue: [{ start: '10:00', end: '18:00' }] } as never);
  assert.deepEqual(weeklyFromGrid(single), { tue: [{ start: '10:00', end: '18:00' }] }, 'a plain day is unchanged');
});

test('summaries: open days, a day with its pauses, time options keep stored values', () => {
  assert.equal(openDaysSummary({ mon: [{ start: '9:00', end: '1' }], tue: [{ start: '1', end: '2' }], wed: [{ start: '1', end: '2' }], thu: [{ start: '1', end: '2' }], fri: [{ start: '1', end: '2' }], sat: [{ start: '1', end: '2' }] }), 'Lun – Sáb');
  assert.equal(openDaysSummary({ mon: [{ start: '1', end: '2' }], wed: [{ start: '1', end: '2' }], fri: [{ start: '1', end: '2' }] }), 'Lun, Mié, Vie');
  assert.equal(openDaysSummary({}), 'Sin horario');
  assert.deepEqual(daySummary([{ start: '09:00', end: '13:00' }, { start: '14:00', end: '19:00' }]), {
    open: true,
    value: '09:00 – 19:00',
    pauses: ['Pausa 13:00 – 14:00'],
  });
  assert.equal(daySummary(undefined).value, 'Cerrado');
  assert.ok(timeOptions(['09:15']).includes('09:15'), 'an off-grid stored time stays selectable');
});

test('site fields: slug from the name, timezone label', () => {
  assert.equal(slugify('Sede Chapinero Alto'), 'sede-chapinero-alto');
  assert.equal(slugify('  Peluquería «Ñoño» #2 '), 'peluqueria-nono-2');
  assert.equal(tzLabel('America/Bogota'), 'Bogotá (GMT-5)');
  assert.equal(tzLabel('Not/AZone'), 'Not/AZone');
});

test('blocks are worded in the SITE zone: today, ranges, all-day', () => {
  const today = '2026-10-09';
  assert.equal(blockWhen({ starts_at: '2026-10-09T18:00:00.000Z', ends_at: '2026-10-09T19:00:00.000Z' }, TZ, today), 'Hoy · 13:00 – 14:00');
  assert.equal(blockWhen({ starts_at: '2026-10-12T05:00:00.000Z', ends_at: '2026-10-13T05:00:00.000Z' }, TZ, today), 'Lun 12 oct · todo el día');
  assert.equal(blockWhen({ starts_at: '2026-10-12T05:00:00.000Z', ends_at: '2026-10-17T05:00:00.000Z' }, TZ, today), 'Lun 12 – vie 16 oct · todo el día');
  assert.equal(blockWhen({ starts_at: '2026-10-22T13:00:00.000Z', ends_at: '2026-10-22T15:00:00.000Z' }, TZ, today), 'Jue 22 oct · 08:00 – 10:00');
});

test('templates only PREFILL a draft; the payload is the wall-clock pair the action expects', () => {
  const today = '2026-10-09';
  const vac = blockDraft('site-1', today, 'Vacaciones');
  assert.equal(vac.tpl, 'Vacaciones');
  assert.equal(vac.scope, 'staff');
  assert.deepEqual(blockPayload(vac), { ok: false, field: 'staff', error: 'Elige el profesional.' }, 'a professional must still be chosen');
  const ok = blockPayload({ ...vac, staffId: 'st-1' });
  assert.deepEqual(ok, { ok: true, startsAt: '2026-10-10T00:00', endsAt: '2026-10-15T00:00' }, 'all-day ends at midnight after the last day');
  const lunch = blockPayload(blockDraft('site-1', today, 'Almuerzo'));
  assert.deepEqual(lunch, { ok: true, startsAt: '2026-10-09T13:00', endsAt: '2026-10-09T14:00' });
  assert.equal(blockPayload({ ...blockDraft('site-1', today), to: '2026-10-08' }).ok, false);
  assert.equal(blockPayload({ ...blockDraft('site-1', today), allDay: false, h1: '14:00', h2: '13:00' }).ok, false);
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
});

test('booking rules: labels, options keep the stored value, examples change with the value', () => {
  assert.equal(ruleLabel('min_notice_min', 0), 'Sin mínimo');
  assert.equal(ruleLabel('min_notice_min', 120), '2 h');
  assert.equal(ruleLabel('min_notice_min', 90), '1 h 30 min');
  assert.equal(ruleLabel('booking_horizon_days', 1), '1 día');
  assert.ok(ruleOptions('slot_interval_min', 25).includes(25), 'a non-preset stored value is still offered');
  const ctx = { todayKey: '2026-10-09', firstOpen: '09:00' };
  assert.equal(ruleExample('min_notice_min', 120, ctx), 'Ej.: si son las 10:00, el primer horario reservable es a partir de las 12:00.');
  assert.equal(ruleExample('min_notice_min', 1440, ctx), 'Ej.: si son las 10:00, se puede reservar desde mañana a las 10:00.');
  assert.equal(ruleExample('booking_horizon_days', 60, ctx), 'Ej.: hoy (9 oct) se puede reservar hasta el 8 dic.');
  assert.equal(ruleExample('slot_interval_min', 15, ctx), 'Ej.: 09:00, 09:15, 09:30, 09:45…');
  assert.equal(ruleExample('slot_interval_min', 20, { ...ctx, firstOpen: '09:10' }), 'Ej.: 09:20, 09:40, 10:00, 10:20…', 'the grid is aligned to midnight, like the engine');
  assert.equal(formatThousands('60000'), '60.000');
});

/** WIRING of the phone screens — they reuse the real actions, never a parallel path. */
const web = (rel: string): string => readFileSync(fileURLToPath(new URL(`../../web/${rel}`, import.meta.url)), 'utf8');

test('the phone tree is mounted below md and the desktop panel is kept from md up', () => {
  const panel = web('components/scheduling/AdminPanel.tsx');
  assert.ok(panel.includes('<ConfigMobile'), 'AdminPanel renders the phone tree');
  // Pages with a phone screen hide their desktop editors below md; the others (Horarios,
  // Excepciones, Promociones, Página de reservas) render the same responsive editors.
  assert.ok(panel.includes('<main className={`${entry ? "hidden md:flex" : "flex"} min-h-0 w-full flex-1 flex-col gap-[var(--content-pad)]`}>'), 'desktop is hidden only below md');
  assert.ok(panel.includes('{entry ? (\n        <ConfigMobile'), 'and the phone tree is mounted only where it exists');
  const root = web('components/scheduling/mobile/config/ConfigMobile.tsx');
  assert.ok(root.includes('md:hidden'), 'the phone tree is hidden from md up');
  assert.ok(root.includes('useTheme()') && root.includes('setTheme(dark ? "light" : "dark")'), 'dark mode uses the existing next-themes mechanism');
  assert.ok(web('components/scheduling/mobile/config/ui.tsx').includes('window.history.pushState'), 'screens live in the URL (browser back works)');
});

test('the phone screens save through the existing actions', () => {
  const services = web('components/scheduling/mobile/config/ServicesMobile.tsx');
  assert.ok(services.includes('saveServiceForm(clientId, persisted.current'), 'the service editor uses the shared runServiceSave path');
  assert.ok(web('components/scheduling/services/ServiceEditor.tsx').includes('const out = await safeAction(() => saveServiceForm(clientId, persisted.current, effective, sites, staff));'), 'desktop uses the same save (through safeAction, so a dropped connection keeps the draft)');
  assert.ok(services.includes('countUpcomingAppointmentsAction(clientId, "service"') && services.includes('deactivateServiceAction') && services.includes('activateServiceAction'));
  assert.ok(services.includes('cancelLabel="Seguir editando"'), 'discard keeps "Seguir editando" as the safe option');
  const sites = web('components/scheduling/mobile/config/SitesMobile.tsx');
  for (const fn of ['countUpcomingAppointmentsAction(clientId, "site"', 'deactivateSiteAction', 'activateSiteAction', 'updateSiteAction', 'createSiteAction']) assert.ok(sites.includes(fn), fn);
  const blocks = web('components/scheduling/mobile/config/BlocksMobile.tsx');
  // Audit 23 Oct: the phone's Bloqueos lists dated blocks AND series and opens the SAME
  // editors as the desktop (which save through the exception and series actions).
  assert.ok(blocks.includes('listScheduleSeriesAction(clientId, id)') && blocks.includes('<BlockPanel') && blocks.includes('<SeriesPanel'), 'blocks and series through the shared editors');
  const rules = web('components/scheduling/mobile/config/RulesMobile.tsx');
  assert.ok(rules.includes('schedulingConfig: { ...cfg, [edit.key]: edit.value }'), 'a rule edit merges over the stored config (buffers preserved)');
});

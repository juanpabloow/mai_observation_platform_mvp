import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * SOURCE-LEVEL CONTRACT for the Agenda after merging origin/main into the redesign.
 *
 * The merge had to keep TWO things that pull in opposite directions: main's
 * deactivation + canonical-identity rules, and the redesigned time-grid calendar
 * (main still shipped the old horizontal card list). These assertions pin the
 * combination so a later edit can't quietly restore one at the other's expense.
 */

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel: string): string => readFileSync(`${root}${rel}`, 'utf8');

const VIEW = 'web/components/scheduling/AgendaView.tsx';
const PAGE = 'web/app/clients/[clientId]/scheduling/agenda/page.tsx';
const REPO = 'src/db/repositories/scheduling/appointments.ts';

// ─────────────── main's rules: deactivation lifecycle ───────────────

test('an INACTIVE barber still gets a lane when they have appointments in range', () => {
  const page = read(PAGE);
  // The server loads everyone, then keeps actives PLUS anyone holding an
  // appointment in the visible window — deactivation is forward-looking, it must
  // never hide history that already points at that resource.
  assert.ok(page.includes('includeInactive: true'), 'staff are loaded including inactive');
  assert.ok(page.includes('const apptStaffIds = new Set(appts.map((a) => a.staff_id))'), 'ids of booked staff');
  assert.ok(
    page.includes('allStaff.filter((s) => s.active || apptStaffIds.has(s.id))'),
    'lanes = active OR has an appointment in range',
  );
  // The lane set is derived from `appts` — the VISIBLE range — so a barber
  // deactivated mid-week still appears on the week that contains their bookings.
  assert.ok(page.includes('from: rangeStart, to: rangeEnd'), 'appts use the visible day/week range');
  assert.ok(page.includes('active: s.active'), 'the active flag reaches the client');
});

test('an inactive barber is LABELLED, and their appointments stay openable', () => {
  const src = read(VIEW);
  // The shape has grown (workingHours drives the "closed" lanes), so match the
  // FIELD rather than the whole declaration — the contract is `active`, not the
  // exact list of siblings it travels with.
  assert.ok(/interface StaffOpt \{[^}]*active: boolean/.test(src), 'StaffOpt carries active');
  assert.ok(src.includes('inactive: !st.active'), 'the column knows the barber is inactive');
  // The chip reads "Inactivo" now (the surface is in Spanish); the CONTRACT is that an
  // inactive lane is still labelled in words, not the exact string.
  assert.ok(src.includes('>\n                        Inactivo\n                      </span>'), 'the header shows an Inactivo chip');
  // Accessible: the chip explains itself rather than relying on colour/'!'.
  const chip = src.slice(src.indexOf('col.inactive ? ('), src.indexOf('Inactivo\n'));
  assert.ok(/title="[^"]*nuevas reservas/i.test(chip), 'the chip explains the consequence on hover');
  // Nothing filters cards out by staff.active — their history renders and the card
  // is the same <button> that opens the drawer.
  assert.ok(!/\.filter\([^)]*staff[^)]*\.active[^)]*\)[^;]*appointments/i.test(src), 'appointments are not filtered by active');
});

test('an inactive barber is NEVER offered for a new booking or a reschedule', () => {
  const src = read(VIEW);
  // The modal's professional picker is the only staff control that creates/moves an
  // appointment; the server refuses inactive staff too, so this keeps the operator
  // from reaching a guaranteed error. It is now a visual chip group rather than a select.
  assert.ok(src.includes('const activeStaff = props.staff.filter((staff) => staff.active)') && src.includes('activeStaff.map((candidate) => {'), 'the booking picker filters to active');
  const pickerStart = src.indexOf('<legend className="u-th">Profesional</legend>');
  const picker = src.slice(pickerStart, src.indexOf('</fieldset>', pickerStart));
  assert.ok(picker.includes('activeStaff.map((candidate)'), '…in the Profesional picker specifically');
});

// ─────────────── main's rules: canonical identity ───────────────

test('identity is canonical — primary_identity replaced the raw phone column', () => {
  const repo = read(REPO);
  assert.ok(repo.includes('primary_identity: string | null;'), 'the row type exposes primary_identity');
  assert.ok(repo.includes('pid.value AS primary_identity'), 'projected from the lateral join');
  assert.ok(repo.includes('LEFT JOIN LATERAL'), 'ONE lateral join — never a per-row lookup');
  assert.ok(repo.includes('si.timezone AS site_timezone'), 'per-row site timezone survives');
  // The redesign's own column is gone everywhere, not just shadowed.
  for (const rel of [REPO, PAGE, VIEW]) {
    assert.ok(!/\bcontact_phone\b/.test(read(rel).replace(/\/\*[\s\S]*?\*\//g, '')), `${rel} no longer reads contact_phone`);
  }
});

test('the drawer shows name then identity — never the internal UUID', () => {
  const src = read(VIEW);
  assert.ok(src.includes('{appt.contact_name ?? "Sin cita"}'), 'the name is the title');
  assert.ok(src.includes('{appt.primary_identity}'), 'the identity is the subtitle');
  assert.ok(src.includes('appt.primary_identity ? ('), 'absent identity renders nothing');
  // public_reference is still carried for other uses, but must not be the subtitle.
  const subtitle = src.slice(src.indexOf('{appt.contact_name ?? "Sin cita"}'), src.indexOf('{appt.primary_identity}'));
  assert.ok(!subtitle.includes('public_reference'), 'the UUID/reference is not shown as identity');
});

// ─────────────── the redesign that had to survive ───────────────

test('the redesigned CALENDAR survived — main\'s horizontal card list did not', () => {
  const src = read(VIEW);
  for (const marker of ['── CONTROL BAR ──', '── KPI STRIP', '── CALENDAR GRID + DRAWER ──']) {
    assert.ok(src.includes(marker), `${marker} is still present`);
  }
  assert.ok(src.includes('HOUR_PX'), 'the vertical time grid is intact');
  assert.ok(src.includes('GRID_FROM_HOUR') && src.includes('GRID_TO_HOUR'), 'the operating window is intact');
  assert.ok(src.includes('function ApptDrawer('), 'the side drawer is intact');
  // The pre-merge layout was a row of fixed-width per-staff card columns.
  assert.ok(!src.includes('flex min-h-0 flex-1 gap-3 overflow-x-auto'), 'the old card list is gone');
  assert.ok(!src.includes('function ActBtn('), 'the old inline action buttons are gone');
});

test('Day/Week and the KPI comparison survived the merge', () => {
  const page = read(PAGE);
  assert.ok(page.includes('const view = sp.view === "week" ? "week" : "day"'), 'the day/week switch');
  assert.ok(page.includes('const rangeStart =') && page.includes('const rangeEnd ='), 'the visible range');
  assert.ok(page.includes('const prevStart =') && page.includes('const prevEnd ='), 'the previous window');
  assert.ok(page.includes('from: prevStart, to: prevEnd'), 'the second query really runs');
  assert.ok(page.includes('kpis={summarise(appts)}') && page.includes('previousKpis={summarise(prevAppts)}'), 'both summaries');
  // One shared summariser, so current and previous can never drift apart.
  assert.equal(page.match(/const summarise =/g)?.length, 1, 'a single summarise() covers both windows');

  const src = read(VIEW);
  assert.ok(src.includes('function ratioDelta(') && src.includes('function pointDelta('), 'delta maths intact');
  assert.ok(src.includes('higherIsBetter={false}'), 'no-show delta still inverts its colour');
});

test('Week view lays simultaneous appointments into lanes instead of stacking them', () => {
  const src = read(VIEW);
  assert.ok(src.includes('function layoutWeekAppointments('), 'week collision layout exists');
  assert.ok(src.includes('start >= clusterEnd'), 'appointments that only touch do not count as overlapping');
  assert.ok(src.includes('Math.min(2, laneEnds.length)'), 'week never creates more than two visible lanes');
  assert.ok(src.includes('weekLayout.lanes.has(appt.id)'), 'overflow appointments are not painted as illegible cards');
  assert.ok(src.includes('weekLane={weekLayout?.lanes.get(a.id)}'), 'each visible weekly card receives its computed lane');
  assert.ok(src.includes('lane / laneCount') && src.includes('100 / laneCount'), 'weekly cards split horizontal space');
  assert.ok(src.includes('week ?') && src.includes('service_name'), 'week has its own compact card hierarchy');
});

test('Week view matches the weekly reading model without changing Day view', () => {
  const src = read(VIEW);
  assert.ok(src.includes('Ocupación semanal'), 'the weekly summary reports occupancy');
  assert.ok(src.includes('u-appt-swatch'), 'the weekly legend uses the professional pastel colours');
  assert.ok(src.includes('sticky right-0 z-20'), 'week has its time rail on the right');
  assert.ok(src.includes('{!isWeek ? ('), 'the day-only left rail remains conditional');
  assert.ok(src.includes('week={isWeek}'), 'cards explicitly switch between week and day rendering');
  assert.ok(src.includes('+{group.appointments.length} más'), 'overflow is represented by a compact +N marker');
  assert.ok(src.includes('function WeekOverflowDialog('), 'the marker opens an accessible appointment chooser');
});

test('Day view opens in professional columns while keeping the row toggle available', () => {
  const src = read(VIEW);
  assert.ok(src.includes('useState<"rows" | "columns">("columns")'), 'professional columns are the day default');
  assert.ok(src.includes('setDesktopLayout("rows")'), 'the compact row layout remains available');
  assert.ok(src.includes('setDesktopLayout("columns")'), 'the column toggle remains explicit');
});

test('the calendar reads the SITE timezone, never the browser', () => {
  const src = read(VIEW);
  assert.ok(src.includes('const tz = props.timezone;'), 'the site timezone drives the grid');
  assert.ok(src.includes('timeZone: tz'), 'zoned formatting uses it');
  // A bare toLocale*/getHours would silently fall back to the viewer's zone.
  assert.ok(!/new Date\([^)]*\)\.getHours\(\)/.test(src), 'no browser-local hour reads');
});

test('module gating and the real lifecycle actions survived', () => {
  const src = read(VIEW);
  for (const action of [
    'confirmAppointmentAction',
    'completeAppointmentAction',
    'noShowAppointmentAction',
    'rescheduleAppointmentAction',
    'cancelAppointmentAction',
    'createManualAppointmentAction',
  ]) {
    assert.ok(src.includes(action), `${action} is still wired`);
  }
  // Contact / conversation links only when the owning module is enabled.
  assert.ok(src.includes('appt.contact_id && contactsBase'), 'contact link is CRM-gated');
  assert.ok(src.includes('appt.source_conversation_id && inboxBase'), 'conversation link is inbox-gated');
});

test('the TODOs explaining still-missing backend were not dropped', () => {
  const src = read(VIEW);
  // These document why the UI omits things the design showed; losing them in a
  // merge would make the omissions look accidental.
  assert.ok((src.match(/TODO\(agenda\)/g)?.length ?? 0) >= 5, 'the agenda TODOs survived');
  assert.ok(/TODO\(agenda\)[\s\S]*waitlist/i.test(src), 'the waitlist gap is still explained');
});

// ─────────────── the UX consolidation pass (Senior Frontend Engineer) ───────────────

test('selecting an appointment ALWAYS shows its detail — inline on xl, overlay below', () => {
  const src = read(VIEW);
  // The fix for the sub-1280 dead click: the drawer decides its own frame off the
  // viewport width and renders as a right-anchored overlay when it can't sit beside
  // the grid.
  assert.ok(src.includes('useIsOverlayWidth(1279.98)'), 'the drawer keys off the xl beside/overlay line');
  assert.ok(src.includes('fixed inset-y-0 right-0') && src.includes('w-[min(360px,90vw)]'), 'overlay is a right drawer with a mobile-safe width');
  assert.ok(src.includes('xl:flex'), 'the inline desktop column survives');
  // The SAME body renders in both modes — proven by the header title resolving exactly
  // once (a duplicated body would resolve it twice).
  assert.equal(src.match(/STATUS_TITLE\[appt\.status\]/g)?.length, 1, 'the drawer body is written once, not per-mode');
  // Overlay contract: scrim + focus trap (Escape/restore) come from the shared Overlay.
  assert.ok(src.includes('OVERLAY_SCRIM') && src.includes('useTrappedPanel'), 'the overlay has a scrim and a focus trap');
});

test('the calendar speaks 24-hour time, never AM/PM', () => {
  const src = read(VIEW);
  assert.ok(src.includes('hourCycle: "h23"'), 'the time formatter is 24-hour');
  assert.ok(!/hour12:\s*true/.test(src), 'no AM/PM formatting remains');
});

test('the screen has ONE h1 (Agenda) — the date is navigation text, not a heading', () => {
  const src = read(VIEW);
  // The title comes from the shared PageHeading; the view itself defines no <h1> of its
  // own (the date stepper used to be one).
  assert.ok(src.includes('<PageHeading title="Agenda"'), 'the title is the shared heading');
  assert.ok(!src.includes('<h1'), 'the view renders no raw <h1> (so the date is not a second one)');
});

test('the Month view is not offered as a dead disabled control', () => {
  const src = read(VIEW);
  assert.ok(src.includes('>Día<') && src.includes('>Semana<'), 'Día/Semana are the toggle');
  assert.ok(!/>\s*Month\s*</.test(src) && !/>\s*Mes\s*</.test(src), 'Month/Mes is hidden until it exists');
  assert.ok(!src.includes('Seg disabled'), 'no permanently-disabled segment remains');
});

test('the new-appointment modal explains itself — search, empty, and disabled states', () => {
  const src = read(VIEW);
  assert.ok(src.includes('Buscando…'), 'the search shows a loading label');
  assert.ok(src.includes('No hay horarios disponibles para esta combinación.'), 'an empty search says so out loud');
  assert.ok(src.includes('Selecciona un horario para continuar.'), 'the disabled primary explains why');
  // It is a real dialog for assistive tech, and Escape/focus are handled.
  assert.ok(src.includes('role="dialog"') && src.includes('aria-modal="true"'), 'the modal is a labelled dialog');
});

test('manual booking is a three-step operator flow with one rich final confirmation', () => {
  const src = read(VIEW);
  for (const label of ['Cliente y servicio', 'Profesional y hora', 'Confirmar']) {
    assert.ok(src.includes(`label: "${label}"`), `${label} is an explicit step`);
  }
  assert.ok(!src.includes('label: "Detalles"'), 'the low-value details screen is removed');
  assert.ok(src.includes('lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]'), 'client and service share one balanced desktop screen');
  assert.ok(src.includes('lg:grid-cols-[minmax(0,2.08fr)_minmax(21rem,1fr)]'), 'desktop gives the month two thirds and professional/time one third');
  assert.ok(!src.includes('aria-label="Resumen de la selección"'), 'intermediate screens do not repeat a persistent summary');
  assert.equal(src.match(/aria-label="Resumen de la cita"/g)?.length, 1, 'the summary appears once, on the final confirmation screen');
  assert.ok(src.includes('Horario libre') && src.includes('Nada se guarda hasta que confirmes.'), 'the final confirmation explains availability and commit timing');
  assert.ok(src.includes('Color de {selectedStaff?.name') && src.includes('Automático'), 'the automatic professional colour is explained');
  assert.ok(src.includes('Crear cita'), 'the final action names its outcome');
  assert.ok(src.includes('visibleSlots'), 'any-professional availability collapses duplicate clock times');
});

test('manual booking has a real selectable month with concise availability labels', () => {
  const src = read(VIEW);
  assert.ok(src.includes('function siteMidnightIso('), 'selected local days are converted in the site timezone');
  assert.ok(src.includes('function calendarDays(') && src.includes('Mes anterior') && src.includes('Mes siguiente'), 'the full month calendar is navigable');
  assert.ok(src.includes('onClick={() => changeDate(day.key)}'), 'choosing a day refreshes the booking date');
  assert.ok(src.includes('from: siteMidnightIso(monthStart, props.timezone)') && src.includes('to: siteMidnightIso(monthEnd, props.timezone)'), 'one real monthly availability query feeds day and professional counts');
  assert.ok(src.includes('const [serviceId, setServiceId] = useState(props.modal.mode === "reschedule" ? props.modal.appt.service_id : "")'), 'new appointments do not preselect a service');
  assert.ok(src.includes('Hay cupos') && !src.includes('horarios libres hoy'), 'calendar and professional cards avoid noisy slot counts');
  assert.ok(src.includes('className="u-module-modal'), 'the dialog centres against the module canvas');
});

test('control geometry is unified on the toolbar tokens', () => {
  const src = read(VIEW);
  // The date steppers clear the 36×36 minimum on their own; the Today button and the
  // facets ride the shared control primitives / --control-h token.
  assert.ok(src.includes('h-[var(--control-h)] w-9'), 'the steppers are 38×36, not the old 28px discs');
  assert.ok(src.includes('className={CONTROL_CLS}'), 'Hoy reuses the shared control class');
  assert.ok(!src.includes('rounded-md border border-line-strong px-3 text-sm transition-colors hover:bg-hover'), 'the old ad-hoc 9px control string is gone');
});

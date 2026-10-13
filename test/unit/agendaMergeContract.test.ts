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
/** The appointment detail moved out of AgendaView into a side panel of its own. */
const PANEL = 'web/components/scheduling/agenda/AppointmentPanel.tsx';
const PREVIEW = 'web/components/scheduling/agenda/AppointmentPreview.tsx';
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
  assert.ok(src.includes('const activeStaff = props.staff.filter((staff) => staff.active)'), 'the booking roster is the ACTIVE roster');
  // The picker's options are derived from activeStaff (now via a search filter inside
  // the popover), so an inactive barber cannot reach the list at all.
  assert.match(src, /activeStaff\s*\n?\s*\.filter\(\(c\) => c\.name/, 'the picker options come from activeStaff');
  const pickerStart = src.indexOf('aria-label="Elegir profesional"');
  const picker = src.slice(pickerStart, src.indexOf('</div>\n                        </div>', pickerStart));
  assert.ok(picker.includes('activeStaff') && picker.includes('role="option"'), '…in the Profesional popover specifically');
  assert.ok(!picker.includes('props.staff.map'), 'the popover never maps the unfiltered roster');
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

test('the appointment detail shows canonical identity — never the internal UUID', () => {
  for (const rel of [PANEL, PREVIEW]) {
    const src = read(rel);
    assert.ok(src.includes('appt.contact_name ?? "Atención sin cita"'), `${rel}: the name is the title`);
    // The canonical identity (phone-or-email) — absent for a staff login, so only drawn when sent.
    assert.ok(src.includes('appt.primary_identity ?'), `${rel}: the canonical identity is shown when present`);
    // public_reference is still carried for other uses, but must not be shown as identity.
    assert.ok(!src.includes('public_reference'), `${rel}: the UUID/reference is not shown as identity`);
  }
});

// ─────────────── the redesign that had to survive ───────────────

test('the redesigned CALENDAR survived — main\'s horizontal card list did not', () => {
  const src = read(VIEW);
  for (const marker of ['── CONTROL BAR ──', '── KPI STRIP', '── CALENDAR GRID + DRAWER ──']) {
    assert.ok(src.includes(marker), `${marker} is still present`);
  }
  assert.ok(src.includes('HOUR_PX'), 'the vertical time grid is intact');
  assert.ok(src.includes('GRID_FROM_HOUR') && src.includes('GRID_TO_HOUR'), 'the operating window is intact');
  assert.ok(src.includes('<AppointmentPanel'), 'the detail side panel is wired');
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

test('Week groups by hour block: at most two cards, the rest behind an in-flow +N', () => {
  const src = read(VIEW);
  assert.ok(src.includes('function bucketWeekAppointments('), 'week groups appointments into hour blocks');
  assert.ok(src.includes('const WEEK_HOUR_PX = 96'), 'week has its own block scale, separate from the day grid');
  assert.ok(
    src.includes('Math.min(Math.max(zonedParts(appt.start_at, tz).h, fromHour), toHour - 1)'),
    'an out-of-hours booking is clamped into an edge block, never dropped',
  );
  assert.ok(src.includes('const [lead, second, ...rest] = block.appointments'), 'the two earliest appointments in a block keep a card');
  // The +N chip opens EVERY appointment of the block — nothing is hidden for good.
  assert.ok(src.includes('onClick={() => setWeekOverflow(block.appointments)}'), 'the overflow opens the whole block');
  // The whole point of the block model: the "+N" chip is a SIBLING of the cards
  // inside the cell, so it can never be absolutely positioned over another card.
  const chip = src.slice(src.indexOf('onClick={() => setWeekOverflow(block.appointments)}'));
  assert.ok(!chip.slice(0, 600).includes('absolute'), 'the +N indicator is in flow, not floating over neighbours');
  assert.ok(chip.includes('h-5 shrink-0'), 'the +N indicator is a fixed-height flex child of its block');
  assert.ok(src.includes('function WeekBlockCard('), 'week has its own card geometry');
});

test('Week view matches the weekly reading model without changing Day view', () => {
  const src = read(VIEW);
  assert.ok(src.includes('Ocupación semanal'), 'the weekly summary reports occupancy');
  assert.ok(src.includes('u-appt-swatch'), 'the weekly legend uses the professional pastel colours');
  assert.ok(src.includes('sticky left-0 z-20 w-14'), 'the hour rail leads the grid in both views');
  assert.ok(!src.includes('sticky right-0 z-20'), 'no trailing rail — that made week read as a table');
  assert.ok(src.includes('+{rest.length} más'), 'overflow is a compact +N marker');
  assert.ok(src.includes('onClick={() => onMore(cell,'), 'the team view\'s +N opens the whole cell too');
  assert.ok(src.includes('function WeekOverflowDialog('), 'the marker opens an accessible appointment chooser');
  // Day keeps the proportional grid: a 90-minute booking stays twice a 45-minute one.
  assert.ok(src.includes('height={Math.max(22, ((endMin - startMin) / 60) * HOUR_PX - 2)}'), 'day cards keep real duration heights');
});

test('closed columns and professional load are stated, not left to colour alone', () => {
  const src = read(VIEW);
  assert.ok(src.includes('u-closed-hatch'), 'a closed day/lane gets the neutral striped surface');
  assert.ok(src.includes('sub: closed ? "Cerrado" : `${n} cita${n === 1 ? "" : "s"}`'), 'a column header carries its own load');
});

test('avatar initials survive an environment-tagged seed name', () => {
  const src = read(VIEW);
  assert.ok(src.includes('function initialsOf('), 'initials are derived in one shared place');
  // "[DEV] Daniela Ríos" must not collapse to "D" for every professional on the board.
  assert.ok(src.includes('replace(/^\\s*[[(][^\\])]*[\\])]\\s*/, "")'), 'a leading [DEV]/(test) tag is stripped first');
  assert.ok(src.includes('.slice(0, 2)'), 'two words make the initials, as the reference writes them');
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
  assert.ok(src.includes('selected.contact_id && props.contactsBase'), 'contact link is CRM-gated');
  assert.ok(src.includes('selected.source_conversation_id && props.inboxBase'), 'conversation link is inbox-gated');
  assert.ok(src.includes('listAppointmentActivityAction'), 'activity is the real read action');
});

test('the TODOs explaining still-missing backend were not dropped', () => {
  const src = read(VIEW);
  // These document why the UI omits things the design showed; losing them in a
  // merge would make the omissions look accidental.
  assert.ok((src.match(/TODO\(agenda\)/g)?.length ?? 0) >= 5, 'the agenda TODOs survived');
  assert.ok(/TODO\(agenda\)[\s\S]*waitlist/i.test(src), 'the waitlist gap is still explained');
});

// ─────────────── the UX consolidation pass (Senior Frontend Engineer) ───────────────

test('selecting an appointment opens a side panel built from the shared Scheduling system', () => {
  const panel = read(PANEL);
  assert.ok(panel.includes('fixed inset-y-0 right-0 z-50 flex w-full'), 'a right-hand panel; full width on the phone');
  assert.ok(panel.includes('md:w-[min(34rem,calc(100vw-3rem))]'), 'one readable column from md');
  assert.ok(panel.includes('from "../ui/system"') && panel.includes('from "../ui/Menu"'), 'it composes the shared system, not its own controls');
  for (const own of ['function IconButton', 'function ConfirmDialog', 'rounded-[10px]', 'h-[36px]']) {
    assert.ok(!panel.includes(own), `no panel-local "${own}"`);
  }
  // Reading order: when → who → what → history.
  const at = (s: string) => panel.indexOf(s);
  assert.ok(at('id="appt-panel-title"') < at('id="appt-panel-client"') && at('id="appt-panel-client"') < at('id="appt-panel-service"') && at('id="appt-panel-service"') < at('id="appt-panel-activity"'), 'date → client → service → activity');
  // Each action once: "Completar" is the footer primary only; reschedule is the service card's.
  // The rule lives in the shared plan (behaviour-tested in appointmentActionPlan.test.ts).
  assert.ok(read('web/lib/appointmentActionPlan.ts').includes('stateMenu: transitions.filter((t) => t !== "completed")'), 'the state menu does not repeat the footer primary');
  assert.ok(panel.includes('const stateTargets = plan.stateMenu;'), 'and the panel builds its menu from it');
  assert.equal((panel.match(/onClick=\{props\.onReschedule\}/g) ?? []).length, 1, 'one reschedule control on the desktop panel');
  // Below md the detail is the phone sheet (mobile/MobileAppointmentSheet), same props.
  assert.ok(panel.includes('if (phone) {') && panel.includes('<MobileAppointmentSheet'), 'the phone gets its own bottom sheet');
  assert.ok(panel.includes('useTrappedPanel') && panel.includes('const onEscape = useCallback'), 'focus trap with a stable close handler');
  assert.ok(panel.includes('DESTRUCTIVE.has(target)') && panel.includes('<ConfirmDialog'), 'cancel / no-show confirm first');
  assert.ok(read('web/components/scheduling/agenda/status.ts').includes('NEXT_STATUSES'), 'transitions mirror the engine');
  for (const fake of ['Añadir formulario', 'política de pagos', 'recurrencia', 'cita de grupo', 'Ver venta', 'Finalizar compra']) {
    assert.ok(!panel.toLowerCase().includes(fake.toLowerCase()), `no "${fake}" control`);
  }
  assert.ok(read(VIEW).includes('{selected ? (\n          <AppointmentPanel'), 'the panel renders beside the grid, not instead of it');
});

test('hovering an appointment shows an informational, viewport-clamped preview', () => {
  const view = read(VIEW);
  const preview = read(PREVIEW);
  assert.ok(view.includes('e.pointerType !== "mouse"'), 'touch never depends on hover — a tap opens the detail');
  assert.ok(view.includes(':focus-visible'), 'keyboard focus is the hover alternative');
  assert.ok(view.includes('hidePreviewSoon') && view.includes('keepPreview'), 'the pointer can cross into the preview without flicker');
  assert.ok(preview.includes('role="tooltip"') && !preview.includes('<button'), 'the preview is information, never a form');
  assert.ok(preview.includes('vw - margin') && preview.includes('vh - h - margin'), 'it is clamped inside the viewport');
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
  assert.ok(src.includes('No hay horarios libres para esta combinación.'), 'an empty search says so out loud');
  assert.ok(src.includes('Elige un horario para continuar.'), 'the disabled primary explains why');
  // It is a real dialog for assistive tech, and Escape/focus are handled.
  assert.ok(src.includes('role="dialog"') && src.includes('aria-modal="true"'), 'the modal is a labelled dialog');
});

test('manual booking is a three-step operator flow with one rich final confirmation', () => {
  const src = read(VIEW);
  for (const label of ['Cliente y servicio', 'Profesional y hora', 'Confirmar']) {
    assert.ok(src.includes(`label: "${label}"`), `${label} is an explicit step`);
  }
  assert.ok(!src.includes('label: "Detalles"'), 'the low-value details screen is removed');
  assert.ok(src.includes('className="grid min-h-0 flex-1 gap-0 lg:grid-cols-2"'), 'client and service share one balanced desktop screen');
  assert.ok(src.includes('lg:grid-cols-[minmax(0,1fr)_22rem]'), 'the month takes the flexible column and the times a fixed rail');
  assert.ok(!src.includes('aria-label="Resumen de la selección"'), 'intermediate screens do not repeat a persistent summary');
  assert.equal(src.match(/aria-label="Resumen de la cita"/g)?.length, 1, 'the summary appears once, on the final confirmation screen');
  assert.ok(src.includes('Nada se guarda hasta que confirmes.'), 'the final confirmation explains commit timing');
  assert.ok(src.includes('queda reservado para'), 'and says what creating it will reserve');
  assert.ok(src.includes('>Color de la cita<') && src.includes('Automático'), 'the automatic service colour is explained');
  assert.ok(src.includes('Se cambia en Configuración → Servicios.'), 'and says where the family is actually edited');
  // The preview must use the SERVICE'S STORED CATEGORY, not a fresh guess from its
  // name, or step 3 would promise a colour the board then draws differently.
  assert.ok(
    src.includes('serviceCategory(selectedService.name, selectedService.category)'),
    'the colour preview reads the stored category',
  );
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

test('control geometry comes from ONE Scheduling system, not per-screen strings', () => {
  const sys = read('web/components/scheduling/ui/system.tsx');
  assert.ok(sys.includes('md: "h-[44px] px-4 lg:h-[40px]"') && sys.includes('sm: "h-[44px] px-3.5 lg:h-[36px] lg:text-[13px]"'), 'two button sizes, both 44px on touch');
  for (const v of ['primary:', 'secondary:', 'tertiary:', 'destructive:']) assert.ok(sys.includes(v), `variant ${v}`);
  const css = read('web/app/globals.css');
  for (const [k, px] of [['control', 12], ['card', 16], ['modal', 24], ['event', 8]] as const) {
    assert.ok(css.includes(`--sch-radius-${k}: ${px}px`), `radius token ${k} = ${px}px`);
  }
  const src = read(VIEW);
  assert.ok(src.includes('segmentShell("sm")') && src.includes('buttonClass({ variant: "primary"'), 'the toolbar uses the shared segmented control and buttons');
  for (const old of ['rounded-[9px]', 'rounded-[7px]', 'h-[34px]', 'className={CONTROL_CLS}', 'className={OUTLINE_CLS}']) {
    assert.ok(!src.includes(old), `the old ad-hoc "${old}" is gone`);
  }
});

test('control heights are absolute px, because this app scales the rem ramp', () => {
  // The root font-size is a preference (90% compact), so Tailwind's rem steps shrink:
  // h-11 = 39.6px (not 44), h-9 = 32.4px. Control heights are written in px.
  for (const rel of [VIEW, PANEL, 'web/components/scheduling/ui/system.tsx', 'web/components/scheduling/ui/Menu.tsx']) {
    const src = read(rel).replace(/\/\*[\s\S]*?\*\//g, '');
    for (const rem of [' h-7\\b', ' h-8\\b', ' h-9\\b', ' h-11\\b']) {
      assert.ok(!new RegExp(rem).test(src), `${rel}: no rem-scale${rem.replace('\\\\b', '')} control height`);
    }
  }
  assert.ok(read('web/components/scheduling/ui/system.tsx').includes('export const INPUT = `${FIELD} h-[44px] lg:h-[40px]`;'), 'fields are a real 44px on touch');
});

test('a confirmation inside the detail panel is modal: Tab cannot reach the panel behind it', () => {
  const panel = read(PANEL);
  const sys = read('web/components/scheduling/ui/system.tsx');
  // Everything behind the confirmation is inert while it is open (one wrapper).
  assert.ok(panel.includes('const layer = useModalLayer(confirm !== null'), 'the panel uses the shared modal layer');
  assert.ok(panel.includes('<div inert={layer.inert} className="flex min-h-0 flex-1 flex-col">'), 'the panel body is inert behind it');
  // The layer focuses the SAFE choice, and restores focus to what opened it.
  assert.ok(sys.includes('querySelector<HTMLElement>("[data-autofocus]")') && sys.includes('data-autofocus>'), 'focus lands on the safe choice');
  assert.ok(sys.includes('back.isConnected ? back : fallback?.current'), 'focus returns to the opener (or the panel)');
  const overlay = read('web/components/ui/Overlay.tsx');
  assert.ok(overlay.includes('!el.closest("[inert]")'), 'the focus trap ignores inert content');
});

test('blocked time shows in EVERY agenda layout, not only the day columns', () => {
  // The coverage RULES are behaviour-tested in test/unit/agendaBlocks.test.ts.
  const src = read(VIEW);
  assert.ok(src.includes('from "@/lib/agendaBlocks"'), 'one shared helper module');
  assert.equal((src.match(/\{blocksOn\(dayKey\)\.map\(\(b\) => \(/g) ?? []).length, 1, 'the tablet board draws block rows');
  // The phone's list (mobile/MobileAgenda) draws them through lib/mobileAgenda.buildDay,
  // whose behaviour (site-wide + the professional in view, clipped per day) is unit-tested.
  const phone = read('web/components/scheduling/mobile/MobileAgenda.tsx');
  assert.ok(phone.includes('buildDay(visible, props.blocks, props.date, tz, now, { staffInView })'), 'the phone list includes blocks');
  assert.ok(phone.includes('⊘ Bloqueado ·'), 'and draws them as blocks');
  assert.ok(src.includes('...shownDayKeys.filter((dk) => blocksOn(dk).length > 0)'), 'a blocked day without appointments still appears');
  assert.equal((src.match(/\{listDayKeys\.length === 0 \? \(/g) ?? []).length, 1, 'the tablet empty state accounts for blocks');
  assert.ok(src.includes('blocks={blocksOn(shownDayKeys[0])}') && src.includes('bookableStaffIds={bookableStaffIds}'), 'the hour rows know the blocks AND who could take a booking');
  assert.ok(src.includes('const covered = hourState(blocks, hour, bookableStaffIds) === "blocked";'), 'only a fully blocked hour stops offering a booking');
  assert.ok(src.includes('blocksOn(col.key, fromHour * 60, toHour * 60).map('), 'week by hours draws blocks');
  assert.ok(src.includes('className="relative flex flex-col gap-1 border-b border-line-soft p-1"'), 'week hour cells paint ABOVE the block overlay');
});

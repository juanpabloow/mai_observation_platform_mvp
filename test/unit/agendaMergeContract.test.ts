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
/** The Scheduling design system: its own file PLUS the shared controls it re-exports
 *  unchanged (web/components/ui/controls.tsx, promoted so CRM uses the same vocabulary). */
const SYSTEM = (): string => {
  const sys = read('web/components/scheduling/ui/system.tsx');
  assert.ok(sys.includes('export * from "@/components/ui/controls";'), 'system.tsx re-exports the shared controls');
  return `${sys}\n${read('web/components/ui/controls.tsx')}`;
};

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
  // Every control that creates or moves an appointment draws from the ACTIVE roster; the
  // server refuses inactive staff too, so this keeps the operator from a guaranteed error.
  assert.ok(src.includes('const activeStaff = props.staff.filter((staff) => staff.active)'), 'the booking roster is the ACTIVE roster');
  assert.ok(src.includes('const staffChoices = props.lockStaffId ? activeStaff.filter((s) => s.id === props.lockStaffId) : activeStaff;'), 'the booking flow picker is built from activeStaff');
  assert.ok(src.includes('...staffChoices].map((s) =>'), 'and only those options are rendered');
  // Reschedule (inside the detail panel and on the phone) and the walk-in panel too.
  assert.ok(src.includes('staff: props.staff.filter((s) => s.active).map((s) => ({ id: s.id, name: s.name, photoUrl: s.photoUrl })),'), 'reschedule offers only active professionals');
  assert.ok(/<WalkInPanel[\s\S]*?staff=\{props\.staff\.filter\(\(s\) => s\.active\)/.test(src), 'the walk-in panel offers only active professionals');
});

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
    // The title is the contact's name; a walk-in without a contact shows what was typed,
    // and only then the generic label — never a reference.
    assert.ok(/appt\.contact_name \?\? (appt\.guest_name \?\? )?"Atención sin cita"/.test(src), `${rel}: the name is the title`);
    // The canonical identity (phone-or-email) — absent for a staff login, so only drawn when sent.
    assert.ok(src.includes('appt.primary_identity ?'), `${rel}: the canonical identity is shown when present`);
    // public_reference is still carried for other uses, but must not be shown as identity.
    assert.ok(!src.includes('public_reference'), `${rel}: the UUID/reference is not shown as identity`);
  }
});

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
  assert.ok(src.includes('appt.contact_id && props.contactsBase'), 'contact link is CRM-gated');
  assert.ok(src.includes('appt.source_conversation_id && props.inboxBase'), 'conversation link is inbox-gated');
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
  const frame = read('web/components/scheduling/agenda/SidePanel.tsx');
  // ONE side-panel frame for detail, Nueva cita, walk-in and blocks: 520 px, 12 px from the
  // top/bottom/right, the whole height; the agenda is neither darkened nor trapped.
  assert.ok(frame.includes('fixed bottom-3 right-3 top-3 z-50 flex w-[min(520px,calc(100vw-24px))]'), '520 px floating panel with 12 px margins');
  assert.ok(frame.includes('fixed inset-0 z-50 flex flex-col'), 'the whole screen on the phone');
  assert.ok(!frame.includes('bg-black/'), 'no scrim: the agenda stays visible');
  assert.ok(frame.includes('overflow-y-auto') && frame.includes('<footer'), 'the body scrolls; the actions stay visible');
  // Unsaved changes: X, Escape, outside click and links ask «Seguir editando / Descartar cambios».
  assert.ok(frame.includes('cancelLabel="Seguir editando"') && frame.includes('confirmLabel="Descartar cambios"'), 'the discard question');
  assert.ok(frame.includes('useNavigationGuard'), 'links elsewhere are guarded too');
  assert.ok(frame.includes('e.defaultPrevented') && frame.includes('[data-own-escape]'), 'Escape closes only the top layer');
  assert.ok(frame.includes('back.isConnected') , 'focus returns to the opener');
  assert.ok(panel.includes('<SidePanel') && panel.includes('from "../ui/system"'), 'the detail composes the shared frame and system');
  // The state in one touch, from the shared plan (behaviour-tested in appointmentActionPlan.test.ts).
  assert.ok(panel.includes('appointmentActionPlan({') && panel.includes('plan.transitions.includes'), 'transitions come from the shared plan');
  assert.ok(panel.includes('DESTRUCTIVE.has(target)') && panel.includes('<ConfirmLayer'), 'cancel / no-show confirm first');
  // Reagendar happens INSIDE the same panel and moves the same appointment.
  assert.ok(panel.includes('<RescheduleInline') && read('web/components/scheduling/agenda/RescheduleInline.tsx').includes('rescheduleAppointmentAction('), 'reschedule inside the panel, the real move action');
  assert.ok(panel.includes('if (phone) {') && panel.includes('<MobileAppointmentSheet'), 'the phone gets its own bottom sheet');
  assert.ok(read('web/components/scheduling/agenda/status.ts').includes('NEXT_STATUSES'), 'transitions mirror the engine');
  for (const fake of ['Añadir formulario', 'política de pagos', 'cita de grupo', 'Ver venta', 'Finalizar compra']) {
    assert.ok(!panel.toLowerCase().includes(fake.toLowerCase()), `no "${fake}" control`);
  }
  assert.ok(read(VIEW).includes('<AppointmentPanel'), 'the panel renders beside the grid, not instead of it');
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
  assert.ok(src.includes('Sin cupos este día'), 'an empty day says so out loud');
  assert.ok(src.includes('"Elige un horario"'), 'the disabled primary explains why');
  // A real dialog: the booking flow renders through MScreen (role="dialog", aria-modal),
  // full screen on the phone and framed as the 520 px side panel from md up.
  const kit = read('web/components/scheduling/mobile/kit.tsx');
  assert.ok(kit.includes('role="dialog"') && kit.includes('aria-modal="true"'), 'the flow is a labelled dialog');
  assert.ok(src.includes('framed={!isPhone}'), 'framed as the side panel on desktop');
});

test('manual booking is a three-step operator flow with one rich final confirmation', () => {
  const src = read(VIEW);
  assert.ok(src.includes('const stepName = step === 1 ? "Cliente y servicio" : step === 2 ? "Profesional, fecha y hora" : "Confirmar";'), 'three explicit steps');
  assert.ok(!src.includes('label: "Detalles"'), 'the low-value details screen is removed');
  assert.ok(src.includes('"Nada se guarda hasta que confirmes"'), 'the final confirmation explains commit timing');
  // The colour preview uses the SERVICE'S STORED CATEGORY, not a fresh guess from its name.
  assert.ok(src.includes('serviceCategory(selectedService.name, selectedService.category)'), 'the colour preview reads the stored category');
  assert.ok(src.includes('"Crear cita"'), 'the final action names its outcome');
  assert.ok(src.includes('visibleSlots'), 'any-professional availability collapses duplicate clock times');
  // «Sin cita · ahora» hands over to the one-step walk-in panel.
  assert.ok(src.includes('Sin cita · ahora') && src.includes('onWalkIn={() => setModal({ mode: "walkin" })}'), 'walk-in from Nueva cita');
});

test('manual booking has a real selectable month with concise availability labels', () => {
  const src = read(VIEW);
  assert.ok(src.includes('function siteMidnightIso('), 'selected local days are converted in the site timezone');
  assert.ok(src.includes('function calendarDays(') && src.includes('Mes anterior') && src.includes('Mes siguiente'), 'the full month calendar is navigable');
  assert.ok(src.includes('changeDate(day.key)'), 'choosing a day refreshes the booking date');
  assert.ok(src.includes('from: siteMidnightIso(monthStart, props.timezone)') && src.includes('to: siteMidnightIso(monthEnd, props.timezone)'), 'one real monthly availability query feeds day and professional counts');
  assert.ok(src.includes('const [serviceId, setServiceId] = useState(props.modal.mode === "reschedule" ? props.modal.appt.service_id : "")'), 'new appointments do not preselect a service');
  assert.ok(!src.includes('horarios libres hoy'), 'calendar and professional cards avoid noisy slot counts');
});

test('control geometry comes from ONE Scheduling system, not per-screen strings', () => {
  const sys = SYSTEM();
  assert.ok(sys.includes('md: "h-[44px] px-4 lg:h-[40px]"') && sys.includes('sm: "h-[44px] px-3.5 lg:h-[36px] lg:text-[13px]"'), 'two button sizes, both 44px on touch');
  for (const v of ['primary:', 'secondary:', 'tertiary:', 'destructive:']) assert.ok(sys.includes(v), `variant ${v}`);
  const css = read('web/app/globals.css');
  for (const [k, px] of [['control', 12], ['card', 16], ['modal', 24], ['event', 8]] as const) {
    assert.ok(css.includes(`--sch-radius-${k}: ${px}px`), `radius token ${k} = ${px}px`);
  }
  const src = read(VIEW);
  assert.ok(src.includes('segmentShell("sm")') && src.includes('buttonClass({ variant: "primary"'), 'the toolbar uses the shared segmented control and buttons');
  for (const old of ['rounded-[7px]', 'h-[34px]', 'className={CONTROL_CLS}', 'className={OUTLINE_CLS}']) {
    assert.ok(!src.includes(old), `the old ad-hoc "${old}" is gone`);
  }
});

test('control heights are absolute px, because this app scales the rem ramp', () => {
  // The root font-size is a preference (90% compact), so Tailwind's rem steps shrink:
  // h-11 = 39.6px (not 44), h-9 = 32.4px. Control heights are written in px.
  for (const rel of [VIEW, PANEL, 'web/components/scheduling/ui/system.tsx', 'web/components/ui/controls.tsx', 'web/components/scheduling/ui/Menu.tsx']) {
    const src = read(rel).replace(/\/\*[\s\S]*?\*\//g, '');
    for (const rem of [' h-7\\b', ' h-8\\b', ' h-9\\b', ' h-11\\b']) {
      assert.ok(!new RegExp(rem).test(src), `${rel}: no rem-scale${rem.replace('\\\\b', '')} control height`);
    }
  }
  assert.ok(SYSTEM().includes('export const INPUT = `${FIELD} h-[44px] lg:h-[40px]`;'), 'fields are a real 44px on touch');
});

test('a confirmation inside the detail panel is modal: Tab cannot reach the panel behind it', () => {
  const panel = read(PANEL);
  const sys = SYSTEM();
  // The confirmation is a ConfirmLayer (focus trapped, Escape cancels) and the panel body
  // is inert behind it; the panel's own Escape/outside-click stand down while it is open.
  assert.ok(panel.includes('<ConfirmLayer'), 'the confirmation is the shared modal layer');
  assert.ok(panel.includes('<div inert={confirm !== null} className="flex flex-col">'), 'the panel body is inert behind it');
  assert.ok(panel.includes('covered={confirm !== null || props.covered}'), 'the panel does not close underneath it');
  assert.ok(sys.includes('querySelector<HTMLElement>("[data-autofocus]")') && sys.includes('data-autofocus>'), 'focus lands on the safe choice');
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

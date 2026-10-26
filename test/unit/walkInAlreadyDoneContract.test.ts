import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// «Atención sin cita · Esta atención ya se realizó» («Registrar atención realizada»): the SAME
// form, one option; the server decides.
const r = (rel: string) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

test('the walk-in form offers it for any earlier day, at the real start, and asks before saving', () => {
  const panel = r('web/components/scheduling/agenda/WalkInPanel.tsx');
  assert.ok(panel.includes('Esta atención ya se realizó'));
  assert.ok(!panel.includes('past: "1"'), 'no longer the engine grid of today');
  assert.ok(panel.includes('type="date"') && panel.includes('max={today}'), 'a past date, never after today');
  assert.ok(panel.includes('type="time"') && panel.includes('step={60}'), 'the real start, any minute');
  assert.ok(panel.includes('siteLocalToUtc(pastDay, pastTime, tz)'), 'read in the site timezone');
  assert.ok(panel.includes('checkPastAttendanceAction('), 'the server checks the exact interval before the review');
  assert.ok(panel.includes('const confirmOpen = done && reviewed === doneKey && canReview;'), 'a review is only for the data it was made of');
  assert.ok(/const doneKey = `\$\{serviceId\}\|\$\{staffId\}\|\$\{pastStart \?\? ""\}/.test(panel), 'service, professional, date and time key the review');
  assert.ok(panel.includes('Confirmar registro') && panel.includes('onClick={review}'), 'explicit confirmation before it is saved');
  assert.ok(panel.includes('document.querySelector<HTMLElement>(missing[0].focus)?.focus();'), 'what is missing is said and focused');
  assert.ok(panel.includes('alreadyDone: true') && !/alreadyDone: true[\s\S]{0,200}immediate: true/.test(panel), 'never together with «ahora»');
  assert.ok(panel.includes('el cobro queda pendiente y no se envía ningún mensaje'), 'says what it does not do');
  assert.ok(panel.includes('No se cambió ninguna cita.'), 'conflicts are shown, nothing else is changed');
  assert.ok(panel.includes('aquí no se hace ninguna excepción'), 'a schedule rule in the way is explained, never bypassed');
  assert.ok(panel.includes('searchSchedulingContactsAction('), 'the booking form\'s own client search');
});

test('the grid and the booking form keep what was painted and hand it over', () => {
  const view = r('web/components/scheduling/AgendaView.tsx');
  assert.ok(view.includes('Registrar atención realizada'), 'an ended range offers to record it');
  assert.ok(view.includes('setModal({ mode: "walkin", done: true, staffId: col.key, startAt: slotStartIso(slotPop), spanMin: slotPop.to - slotPop.from })'));
  assert.ok(view.includes('onWalkIn={(context) => setModal({ mode: "walkin", ...context })}'), 'booking → walk-in keeps the context');
  assert.ok(view.includes('onSwitchToBooking={(context) => setModal({ mode: "new", ...context, done: undefined })}'), 'walk-in → booking keeps it too');
  assert.ok(view.includes('setStep(3);') && view.includes('setPresetMiss(true)'), 'a painted start that is free is not asked again');
});

test('the server gates it: agenda walk-ins only, ended, exact interval, no overlap but a no-show, atomic', () => {
  const actions = r('web/lib/schedulingActions.ts');
  assert.ok(actions.includes('(input.alreadyDone && (!input.walkIn || input.immediate || input.initialStatus))'), 'walk-in only, never «ahora»');
  assert.ok(actions.includes('pastWalkIn: Boolean(input.walkIn && input.alreadyDone)'));
  assert.ok(!actions.includes('transition("completed", clientId, id'), 'no second, separate «complete» step that could fail half-way');
  assert.ok(actions.includes('if (row?.status !== "completed") return { ok: false'), 'anything but completed is reported');
  const engine = r('src/scheduling/booking.ts');
  assert.ok(engine.includes("if (input.pastWalkIn && (input.origin !== 'walk_in' || input.immediateWalkIn || input.startAt.getTime() >= now.getTime()))"));
  assert.ok(!engine.includes('if (day(input.startAt) !== day(now))'), 'no longer today only');
  assert.ok(engine.includes('const past = await planPastAttendance({'), 'the exact interval, not the slot grid');
  assert.ok(engine.includes("return status === 'scheduled' || status === 'confirmed' || status === 'completed';"), 'a no-show never blocks');
  assert.ok(engine.includes("error: 'past_overlap'"), 'an overlap with an active or completed appointment is refused');
  assert.ok(engine.includes("pg_advisory_xact_lock(hashtext($1))`, [`past-walk-in:${chosenStaffId}`]"), 'serialized per professional, before any write');
  assert.ok(engine.includes("const done = await setStatus(client, input.tenantId, appt.id, 'completed');"), 'completed in the SAME transaction as the insert');
  assert.ok(engine.includes('const linked = (await getAppointmentById(appt.tenant_id, appt.id)) ?? appt;'), 'the sale sees the completed appointment');
  // Nothing outside the agenda can set it: the bot route and the public page never pass it.
  for (const f of ['web/app/api/scheduling/v1/appointments/route.ts', 'web/app/api/booking/[slug]/route.ts']) {
    assert.ok(!r(f).includes('pastWalkIn') && !r(f).includes('alreadyDone'), f);
  }
  // An automation never asks for a review of a visit recorded afterwards.
  const review = r('web/app/api/scheduling/v1/appointments/[id]/review-link/route.ts');
  assert.ok(review.includes('if (isRegisteredAfterService(appt))') && review.includes('"registered_after_service"'));
});

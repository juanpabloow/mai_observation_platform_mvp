import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// «Agenda Lenguaje Tarjeta» (card 5a, S5): the appointment detail and the charge panel share
// one visual language on desktop and phone, without changing functions or permissions.
const r = (rel: string) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

test('the card tokens are the approved sheet’s, Claro and Grafito (palette 3a), scoped to .u-c5', () => {
  const css = r('web/app/globals.css');
  const claro = css.slice(css.indexOf('.u-c5 {'), css.indexOf('.dark .u-c5 {'));
  const grafito = css.slice(css.indexOf('.dark .u-c5 {'), css.indexOf('@layer components {', css.indexOf('.dark .u-c5 {')));
  for (const v of ['--c5-bg: #ffffff', '--c5-bd: #ededef', '--c5-sec: #6e6e73', '--c5-foot: #fafafb', '--c5-pri: #111111', '--c5-amber-bg: #fdf4e3', '--c5-ok-bg: #eef7f1', '--c5-red-fg: #b42318']) assert.ok(claro.includes(v), `Claro ${v}`);
  for (const v of ['--c5-bg: #16171a', '--c5-bd: #2a2c31', '--c5-field: #1f2125', '--c5-foot: #131417', '--c5-pri: #ececee', '--c5-seg-sel: #34363c']) assert.ok(grafito.includes(v), `Grafito ${v}`);
  // Sizes in their own classes so Agenda's compact desktop density does not shrink the card.
  assert.ok(css.includes('.c5-cap { font-size: 11px; line-height: 16px; letter-spacing: 0.06em; text-transform: uppercase;'));
  assert.ok(css.includes('.c5-k { width: 112px;') && css.includes('.c5-row { display: flex; align-items: center; gap: 8px; min-height: 40px; font-size: 14px; }'));
});

test('the detail and the charge wear it on both frames; the phone keeps its sheet', () => {
  assert.ok(r('web/components/scheduling/agenda/AppointmentPanel.tsx').includes('variant="card"'));
  assert.ok(r('web/components/scheduling/agenda/ChargePanel.tsx').includes('variant="card"'));
  const sheet = r('web/components/scheduling/mobile/MobileAppointmentSheet.tsx');
  assert.ok(sheet.includes('tone="card"') && sheet.includes('expandable'), 'the phone: same card inside the expandable bottom sheet');
  assert.ok(r('web/components/scheduling/mobile/kit.tsx').includes('tone === "card" ? "u-ag u-c5 bg-[var(--c5-bg)]'));
});

test('what the sheet marks «Propuesto» is not built, and decisions already taken stay', () => {
  const card = r('web/components/scheduling/agenda/AppointmentCard.tsx');
  for (const proposed of ['Nota interna', 'visitas ·', 'reactivarla']) assert.ok(!card.includes(proposed), `no ${proposed}`);
  // Colour by service on the calendar: no «Servicio | Estado» toggle comes back.
  assert.ok(!r('web/components/scheduling/AgendaView.tsx').includes('Servicio | Estado'));
  // «registrado por ti / por el equipo» is a boolean: no member name is resolved or sent.
  const actions = r('web/lib/paymentActions.ts');
  assert.ok(actions.includes('recordedByMe: v.payment.recorded_by === me'));
  assert.ok(r('web/components/scheduling/agenda/PaymentSection.tsx').includes('registrado {recorded.recordedByMe ? "por ti" : "por el equipo"}'));
  // The review link opens WhatsApp with a drafted text; it never claims to have sent it.
  const review = r('web/components/scheduling/agenda/ReviewLink.tsx');
  assert.ok(review.includes('Abrir en WhatsApp') && !review.includes('Enviar por WhatsApp'));
});

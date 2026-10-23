import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** PY-2 — how the agenda wires the charge step (source contract; behaviour is in paymentsAgenda.test.ts). */
const r = (rel: string) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

test('«Completar» opens the charge step ONLY for payments.record; everyone else completes as before', () => {
  const view = r('web/components/scheduling/AgendaView.tsx');
  assert.ok(view.includes('target === "completed" && props.canRecordPayments\n                ? setCharge({ apptId: appt.id, mode: "complete" })'), 'the step replaces the direct completion');
  assert.ok(view.includes('run(() => completeAppointmentAction(props.clientId, appt.id), "Cita completada · cobro pendiente")'), '«Completar sin registrar cobro» is the existing completion');
  assert.ok(view.includes('window.sessionStorage.setItem(FLASH_KEY, appt.id);') && view.includes('setCharge(null);\n                  setNotice(m);'), 'highlight + notice only after the server answered');
});

test('payment data reaches the page only with payments.view, and only for appointments in reach', () => {
  const page = r('web/app/clients/[clientId]/scheduling/agenda/page.tsx');
  assert.ok(page.includes('const canViewPayments = can(scope, "payments.view", client.id);'));
  assert.ok(page.includes('const paymentStates = canViewPayments\n    ? await paymentStatesForAppointments('), 'no states loaded without the permission');
  assert.ok(page.includes('payment_state: paymentStates.get(a.id) ?? null,'));
  const actions = r('web/lib/paymentActions.ts');
  assert.ok(actions.includes('if (kind === "complete" && !can(g.context.scope, "agenda.book", g.context.client.id))'), 'charging never bypasses agenda.book');
  assert.ok(actions.includes('completeWithPayment({ ...base, requireStarted: true })'), 'nor «only once it has started»');
  assert.equal(actions.match(/appointmentInReach\(/g)?.length, 5, 'reach on record, void, read, history (+ its definition)');
});

test('the charge step: unknown price is empty (not $0), the server computes the total, voiding says it gives no money back', () => {
  const panel = r('web/components/scheduling/agenda/ChargePanel.tsx');
  assert.ok(panel.includes('amount: amountInput(appt.price)') && r('web/lib/chargeDraft.ts').includes('if (price == null) return "";'), 'unknown → empty field');
  assert.ok(panel.includes('No procesa tarjetas ni mueve dinero.'));
  assert.ok(panel.includes('El servidor confirma el total al guardar.'));
  assert.ok(panel.includes('if (sending.current || pending || !valid) return;'), 'no double submit');
  assert.ok(panel.includes('createPortal('), 'mounted outside the desktop-only column (visible on a phone)');
  const section = r('web/components/scheduling/agenda/PaymentSection.tsx');
  assert.ok(section.includes('Anular el registro no devuelve dinero al cliente.'));
  assert.ok(section.includes('registros anulados'), 'voided records stay visible');
});

test('phone: the hamburger lives in the screen header; the strip hides only where a screen integrates it', () => {
  const css = r('web/app/globals.css');
  assert.ok(css.includes('body:has([data-integrated-nav]) .u-topbar { display: none; }') && css.includes('@media (max-width: 767.98px) {\n  body:has([data-integrated-nav])'), 'phone only');
  assert.ok(r('web/components/MobileMenuButton.tsx').includes('data-integrated-nav=""'));
  for (const f of ['web/components/scheduling/mobile/MobileAgenda.tsx', 'web/components/scheduling/mobile/team/TeamList.tsx', 'web/components/scheduling/mobile/config/ui.tsx']) {
    assert.ok(r(f).includes('<MobileMenuButton />'), f);
  }
});

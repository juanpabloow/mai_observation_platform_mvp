import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Grid cards in the card language 5a, compact (approved 2026-10-24): day cards, week chips and
// the phone list. Real duration (HOUR_PX), colour by service, marks that never cover the name.
const r = (rel: string) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');
const view = r('web/components/scheduling/AgendaView.tsx');
const css = r('web/app/globals.css');

test('day card: the content follows the REAL height — nothing is grown to fit', () => {
  assert.ok(view.includes('const HOUR_PX = 72;'));
  assert.ok(view.includes('const h = height - 3;') && view.includes('height: h,'), 'the card is exactly its duration');
  assert.ok(view.includes('const mode = h < 20 ? "xs" : h < 50 ? "one" : h < 66 ? "two" : h < 100 ? "three" : "four";'));
  // 15 min: the name and ONE mark, by priority (! › $ › state).
  assert.ok(view.includes('const marks = mode === "xs" ? [rev ? revMark : pay ? payMark : glyph]'));
  // A narrow lane drops the time / secondary words first and keeps the first mark.
  assert.ok(css.includes('@container (max-width: 109px) {\n  .u-ag .u-appt2 [data-drop] { display: none; }\n  .u-ag .u-appt2 .u-ag-marks > :not(:first-child) { display: none; }'));
});

test('signals: amber only for review, neutral for the pending charge, a red ⊘ for a no-show', () => {
  assert.ok(css.includes('.u-ag .u-ag-mk[data-kind="rev"] { background: var(--warn-soft); color: var(--warn);'));
  assert.ok(css.includes('.u-ag .u-ag-mk[data-kind="pay"] { background: var(--chip); color: var(--ag-ink2);'));
  assert.ok(css.includes('.u-ag .u-ag-noshow { color: var(--danger); }'));
  assert.ok(!/u-appt2\[data-status="no_show"\] \.u-appt2-bar/.test(css), 'the bar keeps the service colour on a no-show');
  assert.ok(!/u-appt2\[data-rev\]|box-shadow: 0 0 0 1px var\(--c5-amber/.test(css), 'no extra ring on a conflict');
  assert.ok(r('web/components/scheduling/agenda/AgendaChrome.tsx').includes('no_show: "⊘"'), '«!» is reserved for review');
  // Cancelled: no charge / review marks (they do not apply).
  assert.ok(view.includes('const rev = review && !cancelled;') && view.includes('const pay = appt.payment_state === "pending" && !cancelled;'));
});

test('week keeps its board (rows = professionals, columns = days) with the same marks', () => {
  assert.ok(view.includes('aria-label="Semana por profesional"') && view.includes('const shown = chips.slice(0, 6);'), 'up to 6 chips per cell, then «+N más»');
  assert.ok(view.includes('data-marked={c.a.status !== "cancelled"'), 'a marked chip');
  assert.ok(css.includes('.u-ag .u-appt2[data-marked] [data-glyph]:not(.u-ag-noshow) { display: none; }'), 'a narrow marked chip gives the state icon’s room to the name');
});

test('the preview spells out what a short card only marks; touch opens the detail', () => {
  const pv = r('web/components/scheduling/agenda/AppointmentPreview.tsx');
  assert.ok(pv.includes('! Requiere revisión') && pv.includes('{reviewReasons.join(" · ")}') && pv.includes('$ Cobro pendiente'));
  assert.ok(view.includes('reviewReasons={[...new Set([...preview.appt.review, ...(conflictIds.has(preview.appt.id) ? ["Dentro de una ausencia o bloqueo"] : [])])]}'));
  // Keyboard: a visible focus shows the preview; touch never opens it (a tap opens the detail).
  assert.ok(view.includes('onFocus: (e: React.FocusEvent<HTMLElement>) => {') && view.includes('!e.currentTarget.matches(":focus-visible")'));
  assert.ok(view.includes('if (e.pointerType !== "mouse" || selectedId || modal) return;'));
});

test('phone list: service bar, amber review, neutral charge, the state as quiet text', () => {
  const m = r('web/components/scheduling/mobile/MobileAgenda.tsx');
  assert.ok(m.includes('className={`w-1 flex-none ${cancelled ? "bg-m-bd" : "bg-[var(--m-dot)]"}`}'));
  assert.ok(m.includes('! Requiere revisión') && m.includes('$ Cobro pendiente'));
  assert.ok(m.includes('<span aria-hidden className={a.status === "no_show" ? "text-m-dn" : ""}>'), 'a red ⊘ for a no-show');
});

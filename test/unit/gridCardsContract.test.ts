import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Grid cards drawn as the approved «M_AI Agenda» capture (2026-10-24, the priority visual
// reference): day cards, week chips and the phone list. Real duration (HOUR_PX), colour by
// service (dot + completed fill), small notices that never cover the name.
const r = (rel: string) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');
const view = r('web/components/scheduling/AgendaView.tsx');
const css = r('web/app/globals.css');

test('the capture’s card: no side bar, neutral ring, soft shadow, pastel when completed', () => {
  assert.ok(!view.includes('u-appt2-bar') && !css.includes('.u-appt2-bar'), 'no vertical side bar');
  assert.ok(css.includes('border: 1px solid rgba(17, 19, 22, 0.08); box-shadow: 0 1px 3px rgba(17, 19, 22, 0.08);'), 'a hairline neutral ring and a soft shadow');
  assert.ok(css.includes('.u-ag .u-appt2[data-status="no_show"] { background: #fbeded; border-color: #f1c6c8; }'), 'no-show: the capture’s soft red');
  assert.ok(view.includes('u-appt2-dot size-[6px] shrink-0 bg-[var(--appt-rule)]'), 'the service dot beside the service');
});

test('day card: the line breaks follow the capture’s, in minutes — nothing is grown to fit', () => {
  assert.ok(view.includes('const HOUR_PX = 88;'), 'the whole grid at the capture’s scale (not per card)');
  assert.ok(view.includes('const h = height - 3;') && view.includes('height: h,'), 'the card is exactly its duration');
  assert.ok(view.includes('const one = h < 56;') && view.includes('const three = h >= 68;'), '< 40 min one line · 40–48 two · ≥ 49 three (the capture’s own)');
  assert.ok(css.includes('.u-ag .u-ag-c-name { font-size: 14px; line-height: 17px; font-weight: 500; }') && css.includes('.u-ag .u-ag-c-sub { font-size: 12.5px;'), 'the capture’s type, not reduced');
  assert.ok(!/formatDurationMin|· \{formatDuration/.test(view), 'no redundant duration: the range says it');
  // A shared lane drops the range first and keeps only the first (most important) mark.
  assert.ok(css.includes('@container (max-width: 109px) {\n  .u-ag .u-appt2 [data-drop] { display: none; }\n  .u-ag .u-appt2 .u-ag-marks > :not(:first-child) { display: none; }'));
  assert.ok(css.includes('.u-ag .u-appt2[data-marked] [data-drop-sm] { display: none; }'), 'a marked one-liner gives its range away before the name');
});

test('notices stay small: «!» review amber, «$» pending charge neutral, «⊘» no-show red', () => {
  assert.ok(css.includes('.u-ag .u-ag-mk { display: inline-flex; flex: none; align-items: center; justify-content: center; height: 15px;'));
  assert.ok(css.includes('.u-ag .u-ag-mk[data-kind="rev"] { background: var(--warn-soft); color: var(--warn); }'));
  assert.ok(css.includes('.u-ag .u-ag-noshow { color: var(--danger); }'));
  assert.ok(r('web/components/scheduling/agenda/AgendaChrome.tsx').includes('no_show: "⊘"'), '«!» stays the review mark');
  assert.ok(view.includes('const rev = review && !cancelled;') && view.includes('const pay = appt.payment_state === "pending" && !cancelled;'));
});

test('week keeps its board and the same look; the preview spells out the notices', () => {
  assert.ok(view.includes('aria-label="Semana por profesional"') && view.includes('const shown = chips.slice(0, 6);'));
  assert.ok(css.includes('.u-ag .u-appt2[data-marked] [data-glyph]:not(.u-ag-noshow) { display: none; }'));
  const pv = r('web/components/scheduling/agenda/AppointmentPreview.tsx');
  assert.ok(pv.includes('! Requiere revisión') && pv.includes('{reviewReasons.join(" · ")}') && pv.includes('$ Cobro pendiente'));
  assert.ok(view.includes('!e.currentTarget.matches(":focus-visible")') && view.includes('if (e.pointerType !== "mouse" || selectedId || modal) return;'), 'keyboard focus shows it; touch opens the detail');
});

test('phone list: the same card (no bar), the dot, the range, the glyph at the top right', () => {
  const m = r('web/components/scheduling/mobile/MobileAgenda.tsx');
  // The desktop's service colours on the phone agenda (dot + completed pastel), scoped to it.
  assert.ok(m.includes('data-m-agenda=""') && css.includes('[data-m-agenda] { --m-svc-cut: #2f5fd0; --m-svc-grooming: #b4561f; --m-svc-color: #8a3db0; --m-svc-feature: #18785d; --m-svc-mix: 16%; }'));
  assert.ok(css.includes('.u-ag {') && css.includes('--appt-cut-rule: #2f5fd0;') && css.includes('--appt-grooming-rule: #b4561f;'), 'the same values as the desktop families');
  assert.ok(!m.includes('w-1 flex-none'), 'no side bar');
  assert.ok(m.includes('<span aria-hidden className="size-[7px] flex-none rounded-[2px] bg-[var(--m-dot)]" />'));
  assert.ok(m.includes('{fmt(a.start_at, tz)}–{end}'));
  assert.ok(m.includes('a.status === "no_show" ? "text-m-dn" : "text-m-tx3"'));
});

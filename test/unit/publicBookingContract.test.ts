import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * SOURCE CONTRACT for the public booking surface (no DB, no browser). The behaviour is
 * proven by test/integration/publicBookingRoutes.test.ts; this guards what a source read
 * can: Spanish-only copy, the mobile/in-app-browser rules, the separation from the
 * internal staff actions, the settings link, the headers and the middleware entry.
 */

const root = (rel: string): string => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');
const BOOKING_DIR = 'web/components/booking';
const bookingFiles = readdirSync(fileURLToPath(new URL(`../../${BOOKING_DIR}`, import.meta.url))).filter((f) => f.endsWith('.tsx'));
const bookingSrc = bookingFiles.map((f) => root(`${BOOKING_DIR}/${f}`)).join('\n');
const page = root('web/app/book/[siteSlug]/page.tsx');
const notFound = root('web/app/book/[siteSlug]/not-found.tsx');
/** Visible JSX text + string literals, comments stripped. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

test('the flow has exactly three steps with the specified names and final CTA', () => {
  const flow = root(`${BOOKING_DIR}/BookingFlow.tsx`);
  for (const label of ['Servicio y profesional', 'Fecha y hora', 'Tus datos']) assert.ok(flow.includes(`label: "${label}"`), label);
  assert.equal((flow.match(/\{ value: \d as const, label:/g) ?? []).length, 3);
  assert.ok(flow.includes('Confirmar cita'));
  assert.ok(root(`${BOOKING_DIR}/BookingConfirmation.tsx`).includes('Tu cita está confirmada'));
  assert.ok(root(`${BOOKING_DIR}/BookingConfirmation.tsx`).includes('Reservar otra cita'));
  assert.ok(root(`${BOOKING_DIR}/BookingConfirmation.tsx`).includes('Añadir a mi calendario'));
  // Nothing promises a message the platform does not send.
  assert.ok(!/Te enviamos la confirmación por WhatsApp/.test(code(bookingSrc)), 'no fake WhatsApp promise');
  assert.ok(root(`${BOOKING_DIR}/StaffChooser.tsx`).includes('Cualquier profesional'));
  assert.ok(flow.includes('Primer profesional disponible'));
  const cal = root(`${BOOKING_DIR}/MonthCalendar.tsx`);
  for (const s of ['Hay cupos', 'Sin cupos', 'Cerrado', 'Mes anterior', 'Mes siguiente']) assert.ok(cal.includes(s), s);
});

test('every visible string of the public flow is Spanish — the old English copy is gone', () => {
  const all = code(bookingSrc + page + notFound);
  // What a visitor can read: JSX text nodes and double-quoted string literals.
  const visible = [
    ...[...all.matchAll(/>([^<>{}]*[A-Za-zÁÉÍÓÚáéíóúñ][^<>{}]*)</g)].map((m) => m[1]),
    ...[...all.matchAll(/"([^"\n]*)"/g)].map((m) => m[1]),
  ].join('\n');
  for (const english of [
    'Booking',
    'Choose a',
    'Pick a',
    'Loading',
    'Any barber',
    'Barber',
    'Your details',
    'Full name',
    'optional)',
    'Confirm booking',
    'Reference',
    'Location',
    'Times shown in',
    'No available',
    'Could not',
    'Please',
    'is unavailable',
  ]) {
    assert.ok(!new RegExp(`(^|[\\s(])${english.replace(/[()]/g, '\\$&')}`, 'm').test(visible), `no English UI string: ${english}`);
  }
  assert.ok(page.includes('lang="es"') && notFound.includes('lang="es"'), 'the content is marked as Spanish for assistive tech');
});

test('in-app browser rules: no popups/new tabs in the flow, real autocomplete + keyboards, zoom never blocked', () => {
  const flow = root(`${BOOKING_DIR}/BookingFlow.tsx`);
  assert.ok(!/window\.open\(/.test(bookingSrc), 'no window.open');
  assert.ok(!/target="_blank"/.test(bookingSrc), 'no new tabs during the flow');
  assert.ok(flow.includes('autoComplete="name"') && flow.includes('autoComplete="tel-national"') && flow.includes('autoComplete="email"'));
  assert.ok(flow.includes('autoComplete="tel-country-code"'), 'the dialling code is its own field');
  assert.ok(flow.includes('inputMode="tel"') && flow.includes('type="tel"'), 'numeric phone keyboard');
  assert.ok(flow.includes('inputMode="email"'));
  assert.ok(!/maximum-scale|maximumScale|userScalable|user-scalable/.test(code(page)), 'zoom is never blocked');
  assert.ok(/const INPUT =[\s\S]*?text-base/.test(flow), 'inputs are 16px (no iOS focus zoom)');
  assert.ok(!/document\.cookie|localStorage|sessionStorage/.test(code(bookingSrc)), 'the flow needs no cookies / storage (the optional theme choice is next-themes)');
  assert.ok(!/onMouseEnter|onMouseOver|:hover-only/.test(bookingSrc), 'no hover-only affordance');
});

test('responsive contract: 44px+ touch targets, sticky phone footer, centred container, no gradients/glass', () => {
  const flow = root(`${BOOKING_DIR}/BookingFlow.tsx`);
  assert.ok(/h-\[48px\]/.test(flow) && /h-\[44px\]/.test(bookingSrc), 'controls are real px heights');
  assert.ok(!/ h-(7|8|9|10|11)\b/.test(bookingSrc), 'no rem-scaled control heights (this app scales the rem ramp)');
  assert.ok(flow.includes('sticky bottom-0'), 'the primary action stays under the thumb');
  assert.ok(flow.includes('md:h-[600px] md:overflow-y-auto'), 'from md up the card keeps one height; the step scrolls inside it');
  assert.ok(flow.includes('footLine1') && flow.includes('footLine2'), 'the footer states the running choice in two lines');
  assert.ok(flow.includes('<BookingSummary rows={summaryRows} />'), 'the full "Revisa tu reserva" record sits beside the form in step 3');
  assert.ok(!/disabled=\{!canContinue\}/.test(flow), 'Continuar is never a dead button — pressed early it explains (hint)');
  assert.ok(flow.includes('max-sm:-mx-[var(--content-pad)]'), 'on the phone the card runs edge to edge');
  assert.ok(page.includes('mx-auto') && page.includes('max-w-[1080px]'), 'centred on desktop');
  assert.ok(!/gradient|backdrop-blur|backdrop-filter/.test(bookingSrc + page), 'no gradients, no glassmorphism');
  assert.ok(flow.includes('bg-ink') && flow.includes('text-ink-fg'), 'black primary button');
});

test('the public flow never touches staff actions, contact search or walk-in', () => {
  const surfaces = bookingSrc + page + root('web/app/api/booking/[slug]/route.ts');
  for (const forbidden of ['createManualAppointmentAction', 'searchSchedulingContactsAction', 'schedulingActions', 'walkIn', 'walk_in', 'AgendaView', 'requireFullAccess']) {
    assert.ok(!code(surfaces).includes(forbidden), `public booking must not use ${forbidden}`);
  }
  const post = root('web/app/api/booking/[slug]/route.ts');
  assert.ok(post.includes('origin: "public"') && post.includes('createdByType: "public"') && post.includes('channel: "public"'));
  assert.ok(post.includes('.strict()'), 'unknown body keys are rejected');
  assert.ok(post.includes('maxActiveFuturePerPhone: policy.maxActivePerPhone'), 'the per-phone cap is enforced in the engine');
});

test('logs in the public routes never carry the phone, email, name or Turnstile token', () => {
  for (const rel of ['route.ts', 'services/route.ts', 'staff/route.ts', 'availability/route.ts']) {
    const src = root(`web/app/api/booking/[slug]/${rel}`);
    for (const call of src.match(/logger\.\w+\(\{[^}]*\}/g) ?? []) {
      const keys = [...call.matchAll(/(\w+):/g)].map((m) => m[1]);
      for (const k of keys) {
        assert.ok(['site', 'scope', 'reason', 'error', 'reference', 'deduped'].includes(k), `${rel}: log key ${k} is not an allowed diagnostic`);
      }
    }
  }
});

test('Configuración de agenda shows the booking link of each site, built from the current origin', () => {
  const panel = root('web/components/scheduling/AdminPanel.tsx');
  assert.ok(panel.includes('<BookingLinkCard'), 'rendered in the site detail');
  const card = root('web/components/scheduling/BookingLinkCard.tsx');
  for (const s of ['Enlace de reservas', 'Copiar enlace', 'Abrir página', 'Disponible', 'Sede inactiva', 'Agenda desactivada', 'Ruta:']) {
    assert.ok(card.includes(s), s);
  }
  assert.ok(card.includes('window.location.origin'), 'the URL uses the current origin');
  assert.ok(!/localhost|railway\.app|up\.railway/.test(code(card)), 'no hard-coded host');
  assert.ok(root('web/app/clients/[clientId]/scheduling/admin/page.tsx').includes('isSchedulingBookable(tenantId, client.id)'), 'status from real data');
});

test('headers: /book gets nosniff + Referrer-Policy + Permissions-Policy; no global CSP was improvised', () => {
  const cfg = root('web/next.config.ts');
  assert.ok(cfg.includes('source: "/book/:path*"') && cfg.includes('source: "/api/booking/:path*"'));
  for (const h of ['X-Content-Type-Options', 'Referrer-Policy', 'Permissions-Policy']) assert.ok(cfg.includes(h), h);
  assert.ok(!/Content-Security-Policy/.test(code(cfg)), 'no CSP');
});

test('the public pages are reachable without a session and render without the app chrome', () => {
  const mw = root('web/middleware.ts');
  assert.ok(mw.includes('"/book",') && mw.includes('"/api/booking",'), 'middleware lets cookieless visitors in');
  assert.ok(root('web/components/AppHeader.tsx').includes('isChromelessPath(pathname)'), 'no header on /book…');
  assert.ok(root('web/lib/shellChrome.ts').includes('"/book"'), '…because /book is in the one chromeless list');
  assert.ok(root('web/components/AppSidebarServer.tsx').includes('isChromelessPath(pathname)'), 'no sidebar on /book');
  assert.ok(page.includes('index: false'), 'robots decided: noindex');
  assert.ok(page.includes('Reserva en ${site.name}'), 'title');
  assert.ok(page.includes('openGraph'), 'basic Open Graph');
});

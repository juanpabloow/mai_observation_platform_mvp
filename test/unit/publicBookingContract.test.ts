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

test('the v3 flow has exactly four steps with the specified titles, labels and final CTA', () => {
  const flow = root(`${BOOKING_DIR}/BookingFlow.tsx`);
  const logic = root('web/lib/publicBookingFlow.ts');
  for (const t of ['Elige tu experiencia', 'Elige a tu artista', 'Elige fecha y hora', 'Tus datos']) assert.ok(logic.includes(`"${t}"`), t);
  for (const l of ['Experiencia', 'Artista', 'Fecha y hora', 'Datos']) assert.ok(logic.includes(`"${l}"`), l);
  assert.ok(flow.includes('([1, 2, 3, 4] as const)'), 'four progress steps');
  assert.ok(flow.includes('Paso {step} de 4'));
  assert.ok(flow.includes('"Confirmar cita"'));
  const done = root(`${BOOKING_DIR}/BookingDone.tsx`);
  for (const s of ['Tu cita está reservada', 'Añadir a mi calendario']) assert.ok(done.includes(s), s);
  assert.ok(flow.includes('Hacer otra reserva'));
  // Nothing promises a message the platform does not send.
  assert.ok(!/Te enviamos la confirmación por WhatsApp/.test(code(bookingSrc)), 'no fake WhatsApp promise');
  const artist = root(`${BOOKING_DIR}/ArtistStep.tsx`);
  for (const s of ['Sin preferencia', 'Ver perfil', '<ChooseLabel selected={sel} />', 'Elegido', '<>Elegir</>', 'aria-label={sel ? `${a.name}, elegido` : `Elegir a ${a.name}`}']) assert.ok(artist.includes(s), s);
  const cal = root(`${BOOKING_DIR}/DateTimeStep.tsx`);
  for (const s of ['Hay cupos', 'Sin cupos o cerrado', 'Mes anterior', 'Mes siguiente', '"LU", "MA", "MI", "JU", "VI", "SÁ", "DO"']) assert.ok(cal.includes(s), s);
  // Services: pressing the card opens the full detail; "+" / "Añadir" choose.
  const svc = root(`${BOOKING_DIR}/ServiceStep.tsx`);
  assert.ok(svc.includes('onOpenDetail(s.id, e.currentTarget)') && svc.includes('"Añadir"'), 'the card opens the detail on services');
});

test('"Sin preferencia" sends NO staff_id (the engine assigns); the profile never selects', () => {
  const flow = root(`${BOOKING_DIR}/BookingFlow.tsx`);
  assert.ok(flow.includes('...(staffParam ? { staff_id: staffParam } : {})'), 'staff_id only for a chosen artist');
  assert.ok(flow.includes('const staffParam = sel.artist && sel.artist !== "any" ? sel.artist : "";'));
  const profile = root(`${BOOKING_DIR}/ArtistProfile.tsx`);
  assert.ok(profile.includes('showModal()') && profile.includes('onCancel'), 'a modal dialog that Escape closes');
  assert.ok(profile.includes('trigger.current = returnFocusTo') && profile.includes('t?.focus()'), 'focus returns to the trigger');
  assert.ok(/onClick=\{onClose\}/.test(profile) && profile.includes('onChoose(artist.id)'), 'closing and choosing are separate actions');
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
  const form = root(`${BOOKING_DIR}/DetailsStep.tsx`);
  assert.ok(form.includes('autoComplete="name"') && form.includes('autoComplete="tel-national"') && form.includes('autoComplete="email"'));
  assert.ok(form.includes('autoComplete="tel-country-code"'), 'the dialling code is its own field');
  assert.ok(form.includes('inputMode="tel"') && form.includes('type="tel"'), 'numeric phone keyboard');
  assert.ok(form.includes('inputMode="email"'));
  assert.ok(!/maximum-scale|maximumScale|userScalable|user-scalable/.test(code(page)), 'zoom is never blocked');
  void flow;
  const details = root(`${BOOKING_DIR}/DetailsStep.tsx`);
  assert.ok(/const INPUT =[\s\S]*?text-\[16px\]/.test(details), 'inputs are 16px (no iOS focus zoom)');
  assert.ok(!/document\.cookie|localStorage|sessionStorage/.test(code(bookingSrc)), 'the flow needs no cookies / storage');
  assert.ok(!/onMouseEnter|onMouseOver|:hover-only/.test(bookingSrc), 'no hover-only affordance');
});

test('responsive contract: 44px+ targets, sticky bar with safe area + keyboard, 1120px desktop, v3 palette', () => {
  const flow = root(`${BOOKING_DIR}/BookingFlow.tsx`);
  const ui = root(`${BOOKING_DIR}/ui.tsx`);
  assert.ok(/size-11/.test(bookingSrc) && /min-h-\[44px\]|min-h-11/.test(bookingSrc), 'controls are 44px');
  assert.ok(!/ h-(7|8|9|10)\b/.test(bookingSrc), 'no rem-scaled small control heights (this app scales the rem ramp)');
  assert.ok(flow.includes('className="sticky z-10') && flow.includes('[bottom:calc(-1*var(--content-pad))]') && flow.includes('env(safe-area-inset-bottom)'), 'the bar stays under the thumb, flush and above the safe area');
  assert.ok(flow.includes('window.visualViewport') && flow.includes('translateY(-${kbInset}px)'), 'the bar rides above the on-screen keyboard');
  assert.ok(page.includes('interactiveWidget: "resizes-content"'), 'Android resizes the layout above the keyboard');
  assert.ok(flow.includes('lg:max-w-[1120px]') && flow.includes('w-[340px]'), 'desktop: 1120px container + 340px selection panel');
  assert.ok(!/disabled=\{!canContinue\}/.test(flow) && flow.includes('aria-disabled'), 'Continuar stays focusable and explains (hint) instead of going dead');
  assert.ok(!/gradient|backdrop-blur|backdrop-filter/.test(bookingSrc + page), 'no gradients, no glassmorphism');
  assert.ok(ui.includes('"bg-pb-ink text-white"'), 'near-black primary action');
  // v3 palette: white ground, neutral greys, no cream/sand/brown surfaces.
  const css = root('web/app/globals.css');
  const block = css.slice(css.indexOf('Public booking v3'), css.indexOf('SCHEDULING design system'));
  assert.ok(block.includes('--color-pb-ink: #111316') && block.includes('background: #f4f5f7'), 'neutral light-grey ground, white cards');
  for (const beige of ['#f5efe6', '#efe7da', '#e9dfcf', '#f4ede3', '#d6c3a5']) assert.ok(!block.toLowerCase().includes(beige), `no v2 beige ${beige}`);
  assert.ok(root('web/app/book/[siteSlug]/layout.tsx').includes('Newsreader('), 'Newsreader titles (page and not-found)');
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

test('Página de reservas shows the booking link of each site, built from the current origin', () => {
  const panel = root('web/components/scheduling/AdminPanel.tsx');
  assert.ok(panel.includes('<BookingLinkCard'), 'rendered in the site detail');
  const card = root('web/components/scheduling/BookingLinkCard.tsx');
  for (const s of ['Enlace de reservas', 'Copiar enlace', 'Abrir página', 'Disponible', 'Sede inactiva', 'Agenda desactivada', 'Ruta:']) {
    assert.ok(card.includes(s), s);
  }
  assert.ok(card.includes('window.location.origin'), 'the URL uses the current origin');
  assert.ok(!/localhost|railway\.app|up\.railway/.test(code(card)), 'no hard-coded host');
  assert.ok(root('web/lib/schedulingSettingsData.ts').includes('isSchedulingBookable(tenantId, client.id)'), 'status from real data');
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

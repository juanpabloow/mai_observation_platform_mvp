import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { reviewLinkSecret, reviewPath, signReviewToken, verifyReviewToken } from '../../web/lib/reviewLink.js';
import {
  authorDisplay,
  checkReviewComment,
  ratingText,
  relativeWhen,
  reviewCommentMessage,
  reviewCountText,
  reviewLinkState,
} from '../../web/lib/publicReviews.js';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

const SECRET = 'test-secret-0123456789abcdef';
const ID = '3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b';

// ── Signed review links ─────────────────────────────────────────────────────────

test('a signed token round-trips to its review id and is stable', () => {
  const t = signReviewToken(ID, SECRET);
  assert.match(t, /^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{32}$/);
  assert.equal(verifyReviewToken(t, SECRET), ID);
  assert.equal(signReviewToken(ID, SECRET), t, 'the same appointment always gets the same link');
  assert.equal(signReviewToken(ID.toUpperCase(), SECRET), t, 'case does not change the link');
  assert.equal(reviewPath(t), `/resena/${t}`);
});

test('a forged, edited or foreign-secret token is refused', () => {
  const t = signReviewToken(ID, SECRET);
  const [idPart, sig] = t.split('.');
  assert.equal(verifyReviewToken(t, 'another-secret-0123456789'), null, 'other secret');
  const flipped = sig[0] === 'A' ? `B${sig.slice(1)}` : `A${sig.slice(1)}`;
  assert.equal(verifyReviewToken(`${idPart}.${flipped}`, SECRET), null, 'edited signature');
  const other = signReviewToken('11111111-2222-4333-8444-555555555555', SECRET).split('.')[0];
  assert.equal(verifyReviewToken(`${other}.${sig}`, SECRET), null, 'signature of another review');
  for (const junk of ['', 'abc', `${t}x`, `${idPart}`, `${idPart}.`, 'a'.repeat(200), `${idPart}.${sig}.x`]) {
    assert.equal(verifyReviewToken(junk, SECRET), null, `junk ${JSON.stringify(junk.slice(0, 20))}`);
  }
  assert.throws(() => signReviewToken('not-a-uuid', SECRET));
});

test('the link secret falls back like the public booking hasher and fails closed', () => {
  assert.equal(reviewLinkSecret({ REVIEW_LINK_SECRET: 'r'.repeat(16), BETTER_AUTH_SECRET: 'b'.repeat(32) }), 'r'.repeat(16));
  assert.equal(reviewLinkSecret({ PUBLIC_BOOKING_HASH_SECRET: 'p'.repeat(20) }), 'p'.repeat(20));
  assert.equal(reviewLinkSecret({ REVIEW_LINK_SECRET: 'short', BETTER_AUTH_SECRET: 'b'.repeat(32) }), 'b'.repeat(32));
  assert.equal(reviewLinkSecret({}), null);
  assert.equal(reviewLinkSecret({ BETTER_AUTH_SECRET: '   ' }), null);
});

// ── Pure helpers ────────────────────────────────────────────────────────────────

test('author is first name + initial — never a phone, an e-mail or a full surname', () => {
  assert.equal(authorDisplay('Andrés Gómez Ruiz'), 'Andrés G.');
  assert.equal(authorDisplay('  andrés   gómez '), 'Andrés G.');
  assert.equal(authorDisplay('ÁLVARO'), 'Álvaro');
  assert.equal(authorDisplay('+57 300 123 4567'), 'Cliente');
  assert.equal(authorDisplay('ana@correo.com'), 'Ana C.', 'the @ and dots are dropped, never shown');
  assert.equal(authorDisplay(null), 'Cliente');
  assert.equal(authorDisplay(''), 'Cliente');
  assert.ok(authorDisplay('x'.repeat(80) + ' y').length <= 40, 'fits the column CHECK');
});

test('comments follow the public-text rules (no links, e-mails or phones)', () => {
  assert.deepEqual(checkReviewComment('  Muy buen corte.  '), { ok: true, value: 'Muy buen corte.' });
  assert.deepEqual(checkReviewComment('   '), { ok: true, value: null });
  assert.deepEqual(checkReviewComment(null), { ok: true, value: null });
  for (const bad of ['Escríbeme al 300 123 4567', 'mira www.otro.com', 'yo@correo.com']) {
    const r = checkReviewComment(bad);
    assert.equal(r.ok, false, bad);
    assert.match(reviewCommentMessage(r) ?? '', /^Comentario: no incluyas enlaces/);
  }
  const long = checkReviewComment('a'.repeat(601));
  assert.equal(long.ok, false);
  assert.equal(reviewCommentMessage(long), 'Comentario: máximo 600 caracteres.');
  assert.equal(reviewCommentMessage({ ok: true, value: null }), null);
});

test('link state: answered beats expired; expiry and a reverted appointment close it', () => {
  const now = new Date('2026-10-13T12:00:00Z');
  const base = { status: 'requested', expires_at: '2026-10-20T00:00:00Z', appointment_status: 'completed' };
  assert.equal(reviewLinkState(base, now), 'open');
  assert.equal(reviewLinkState({ ...base, expires_at: '2026-10-13T12:00:00Z' }, now), 'expired');
  assert.equal(reviewLinkState({ ...base, appointment_status: 'cancelled' }, now), 'expired');
  for (const status of ['pending', 'approved', 'hidden']) {
    assert.equal(reviewLinkState({ ...base, status, expires_at: '2020-01-01T00:00:00Z' }, now), 'answered');
  }
});

test('rating copy is Spanish', () => {
  assert.equal(ratingText(4.75), '4,8');
  assert.equal(ratingText(5), '5,0');
  assert.equal(reviewCountText(1), '1 reseña');
  assert.equal(reviewCountText(12), '12 reseñas');
  const now = new Date('2026-10-13T12:00:00Z');
  assert.equal(relativeWhen('2026-10-13T08:00:00Z', now), 'hoy');
  assert.equal(relativeWhen('2026-10-12T08:00:00Z', now), 'ayer');
  assert.equal(relativeWhen('2026-10-01T08:00:00Z', now), 'hace 1 semana');
  assert.equal(relativeWhen('2026-07-01T08:00:00Z', now), 'hace 3 meses');
});

// ── Wiring of the public surface ────────────────────────────────────────────────

test('the review page and its API are public and chromeless', () => {
  const mw = read('web/middleware.ts');
  assert.ok(mw.includes('"/resena",') && mw.includes('"/api/resena",'), 'cookieless visitors reach them');
  assert.ok(read('web/lib/shellChrome.ts').includes('"/resena"'), 'no app chrome around the page');
});

test('the submit API checks token → gate → state BEFORE reading the body, and submits atomically', () => {
  const src = read('web/app/api/resena/[token]/route.ts');
  const order = ['checkRateLimit(', 'reviewLinkSecret()', 'verifyReviewToken(', 'getReviewForLink(', 'reviewLinkState(', 'req.json()', 'checkReviewComment(', 'submitReview('];
  let last = -1;
  for (const tok of order) {
    const i = src.indexOf(tok);
    assert.ok(i > last, `${tok} must come after the previous step`);
    last = i;
  }
  assert.ok(src.includes('.strict()'), 'unknown body keys are rejected');
  assert.ok(src.includes('publish_consent: z.literal(true)'), 'consent is mandatory');
  assert.ok(src.includes('authorDisplay(review.contact_name)'), 'the author is derived, never typed');
  assert.ok(!/logger\.\w+\([^)]*(comment:|contact_name|token|author)/.test(src), 'logs carry no comment, name or token (only whether there was one)');
});

test('the public page resolves through the same token + gate', () => {
  const src = read('web/app/resena/[token]/page.tsx');
  assert.ok(src.includes('verifyReviewToken(token, secret)'));
  assert.ok(src.includes('getReviewForLink(id)'));
  assert.ok(src.includes('readPublicBookingPolicy().disabled'), 'the kill switch closes reviews too');
  assert.ok(src.includes('robots: { index: false, follow: false }'));
});

test('the booking page only ever shows APPROVED reviews', () => {
  const repo = read('src/db/repositories/scheduling/reviews.ts');
  for (const fn of ['publicStaffRatings', 'publicServiceRatings', 'publicStaffReviews']) {
    const body = repo.slice(repo.indexOf(`export async function ${fn}`));
    const sql = body.slice(0, body.indexOf('`,'));
    assert.ok(sql.includes("status = 'approved'"), `${fn} filters approved`);
  }
});

test('moderation is owner/agency only and scoped to the client', () => {
  const action = read('web/lib/reviewModerationActions.ts');
  assert.ok(action.includes('canManageClient(res.context.scope, clientId)'));
  assert.ok(action.includes('moderateReview(res.context.scope.tenantId, res.context.client.id'));
  const page = read('web/app/clients/[clientId]/scheduling/reviews/page.tsx');
  assert.ok(page.includes('if (!canManageClient(scope, clientId)) notFound();'));
  const nav = read('web/components/AppSidebar.tsx');
  const i = nav.indexOf('key: "scheduling-reviews"');
  assert.ok(i > nav.indexOf('if (canManageThisClient && clientId !== defaultClientId) {'), 'the nav entry sits behind the manage gate');
});

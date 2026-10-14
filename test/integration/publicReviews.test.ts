import { randomUUID } from 'node:crypto';
import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { query, withTransaction } from '../../src/db/client.js';
import { insertAppointment } from '../../src/db/repositories/scheduling/appointments.js';
import {
  ensureReviewRequest,
  listReviewsForModeration,
  moderateReview,
  publicServiceRatings,
  publicStaffRatings,
  publicStaffReviews,
} from '../../src/db/repositories/scheduling/reviews.js';
import { setClientModuleEnabled } from '../../src/db/repositories/clientModules.js';
import { reviewPath, signReviewToken } from '../../web/lib/reviewLink.js';
import { cleanupTenant, closeDb, seedContact, seedScenario, type Scenario } from './fixtures.js';

/**
 * REVIEWS (migration 1801) end to end through PostgreSQL and the real public handler:
 * a link exists only for a COMPLETED appointment of the client, the customer answers
 * ONCE, nothing is public until the business approves it, and every read stays inside
 * its tenant / client / site.
 */

const SECRET = 'integration-review-secret-0123456789';
let prevSecret: string | undefined;
before(() => {
  prevSecret = process.env.REVIEW_LINK_SECRET;
  process.env.REVIEW_LINK_SECRET = SECRET;
});

const tenants: string[] = [];
after(async () => {
  if (prevSecret === undefined) delete process.env.REVIEW_LINK_SECRET;
  else process.env.REVIEW_LINK_SECRET = prevSecret;
  for (const t of tenants) await cleanupTenant(t);
  await closeDb();
});

type Handler = (req: Request, ctx: { params: Promise<{ token: string }> }) => Promise<Response>;
const submitRoute = async (): Promise<Handler> => (await import('../../web/app/api/resena/[token]/route.js')).POST;
type SlugHandler = (req: Request, ctx: { params: Promise<{ slug: string }> }) => Promise<Response>;
const staffRoute = async (): Promise<SlugHandler> => (await import('../../web/app/api/booking/[slug]/staff/route.js')).GET;

const ip = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.9`;

async function post(token: string, body: unknown): Promise<Response> {
  return (await submitRoute())(
    new Request(`http://localhost/api/resena/${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip() },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ token }) },
  );
}

async function scenario(): Promise<Scenario> {
  const s = await seedScenario({ enableScheduling: true });
  tenants.push(s.tenantId);
  return s;
}

let hour = 8;
async function appointment(s: Scenario, opts: { status?: string; contactName?: string; clientId?: string; siteId?: string; staffId?: string } = {}) {
  const contactId = await seedContact(s.tenantId, opts.clientId ?? s.clientId, { name: opts.contactName ?? 'Andrés Gómez Ruiz' });
  const start = new Date(Date.UTC(2026, 8, 1, hour++, 0));
  const end = new Date(start.getTime() + 60 * 60_000);
  const a = await withTransaction((client) =>
    insertAppointment(client, {
      tenantId: s.tenantId, clientId: opts.clientId ?? s.clientId, siteId: opts.siteId ?? s.siteId, contactId, sourceConversationId: null,
      staffId: opts.staffId ?? s.staffA, serviceId: s.serviceHaircut, startAt: start, serviceEndAt: end,
      blockedFrom: start, blockedUntil: end, serviceNameSnapshot: 'Corte clásico', durationMinSnapshot: 60,
      priceSnapshot: null, bufferBeforeMinSnapshot: 0, bufferAfterMinSnapshot: 0,
      origin: 'internal', createdByType: 'agent', createdByUserId: null, idempotencyKey: null,
    }),
  );
  if ((opts.status ?? 'completed') !== 'scheduled') {
    await query(`UPDATE appointments SET status = $2 WHERE id = $1`, [a.id, opts.status ?? 'completed']);
  }
  return a.id;
}

test('a link exists only for a COMPLETED appointment of THIS client, and is reused', async () => {
  const s = await scenario();
  const done = await appointment(s);
  const live = await appointment(s, { status: 'scheduled' });

  assert.equal(await ensureReviewRequest(s.tenantId, s.clientId, live), null, 'not completed → no link');
  assert.equal(await ensureReviewRequest(s.tenantId, s.otherClientId, done), null, 'another client of the tenant → no link');
  assert.equal(await ensureReviewRequest(randomUUID(), s.clientId, done), null, 'another tenant → no link');

  const first = await ensureReviewRequest(s.tenantId, s.clientId, done);
  assert.ok(first);
  assert.equal(first.status, 'requested');
  const again = await ensureReviewRequest(s.tenantId, s.clientId, done);
  assert.equal(again?.id, first.id, 'same request, same link');
  const n = await query<{ n: number }>(`SELECT count(*)::int AS n FROM appointment_reviews WHERE appointment_id = $1`, [done]);
  assert.equal(n.rows[0].n, 1);
});

test('the customer answers ONCE; the author is first name + initial; nothing is public yet', async () => {
  const s = await scenario();
  const appt = await appointment(s);
  const req = await ensureReviewRequest(s.tenantId, s.clientId, appt);
  assert.ok(req);
  const token = signReviewToken(req.id, SECRET);

  const bad = await post(token, { rating: 5, publish_consent: false });
  assert.equal(bad.status, 422, 'consent is mandatory');
  const extra = await post(token, { rating: 5, publish_consent: true, author_display: 'Otro nombre' });
  assert.equal(extra.status, 422, 'the author can not be typed');
  const phone = await post(token, { rating: 5, comment: 'Llámame al 300 123 4567', publish_consent: true });
  assert.equal(phone.status, 422, 'no phone in a public comment');

  const [a, b] = await Promise.all([
    post(token, { rating: 5, comment: 'Excelente corte, muy puntual.', publish_consent: true }),
    post(token, { rating: 1, comment: 'Segundo envío', publish_consent: true }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [201, 409], 'a double submit stores exactly one review');

  const row = await query<{ status: string; author_display: string; rating: number; comment: string }>(
    `SELECT status, author_display, rating, comment FROM appointment_reviews WHERE id = $1`,
    [req.id],
  );
  assert.equal(row.rows[0].status, 'pending');
  assert.equal(row.rows[0].author_display, 'Andrés G.');
  assert.equal((await post(token, { rating: 3, publish_consent: true })).status, 409, 'a replayed link changes nothing');

  assert.equal((await publicStaffRatings(s.tenantId, s.siteId)).size, 0, 'pending is not public');
  assert.equal((await publicStaffReviews(s.tenantId, s.siteId, [s.staffA])).length, 0);
});

test('forged, foreign and expired links are refused', async () => {
  const s = await scenario();
  const appt = await appointment(s);
  const req = await ensureReviewRequest(s.tenantId, s.clientId, appt);
  assert.ok(req);

  assert.equal((await post(signReviewToken(req.id, 'not-the-server-secret-000'), { rating: 5, publish_consent: true })).status, 404);
  assert.equal((await post(signReviewToken(randomUUID(), SECRET), { rating: 5, publish_consent: true })).status, 404, 'unknown review');
  assert.equal((await post('garbage', { rating: 5, publish_consent: true })).status, 404);

  await query(`UPDATE appointment_reviews SET expires_at = now() - interval '1 minute' WHERE id = $1`, [req.id]);
  const expired = await post(signReviewToken(req.id, SECRET), { rating: 5, publish_consent: true });
  assert.equal(expired.status, 410);
  const renewed = await ensureReviewRequest(s.tenantId, s.clientId, appt);
  assert.ok(renewed && renewed.expires_at.getTime() > Date.now(), 'asking again renews an unanswered link');
  assert.equal(renewed.id, req.id, '…with the SAME link');

  // The module is switched off → the link reads as unknown (same public gate as booking).
  await setClientModuleEnabled({ tenantId: s.tenantId, clientId: s.clientId, moduleKey: 'scheduling', enabled: false });
  assert.equal((await post(signReviewToken(req.id, SECRET), { rating: 5, publish_consent: true })).status, 404);
});

test('moderation is client-scoped; only APPROVED reviews reach the booking page', async () => {
  const s = await scenario();
  const a1 = await appointment(s, { contactName: 'Lucía Pérez' });
  const a2 = await appointment(s, { contactName: 'Mateo' });
  const tokens: string[] = [];
  for (const [appt, rating] of [[a1, 5], [a2, 3]] as const) {
    const r = await ensureReviewRequest(s.tenantId, s.clientId, appt);
    assert.ok(r);
    tokens.push(r.id);
    assert.equal((await post(signReviewToken(r.id, SECRET), { rating, comment: rating === 5 ? 'Muy bien' : null, publish_consent: true })).status, 201);
  }
  const queue = await listReviewsForModeration(s.tenantId, s.clientId, 'pending');
  assert.equal(queue.length, 2);
  assert.equal((await listReviewsForModeration(s.tenantId, s.otherClientId)).length, 0, 'another client sees nothing');

  assert.equal(await moderateReview(s.tenantId, s.otherClientId, tokens[0], 'approved', null), false, 'another client can not approve it');
  assert.equal(await moderateReview(s.tenantId, s.clientId, tokens[0], 'approved', 'user-1'), true);
  assert.equal(await moderateReview(s.tenantId, s.clientId, tokens[1], 'hidden', 'user-1'), true);

  const ratings = await publicStaffRatings(s.tenantId, s.siteId);
  assert.deepEqual(ratings.get(s.staffA), { average: 5, count: 1 }, 'the hidden 3★ does not count');
  assert.deepEqual((await publicServiceRatings(s.tenantId, s.siteId)).get(s.serviceHaircut), { average: 5, count: 1 });
  const shown = await publicStaffReviews(s.tenantId, s.siteId, [s.staffA]);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].author_display, 'Lucía P.');

  // Through the real public endpoint: the approved review and nothing private.
  const res = await (await staffRoute())(
    new Request(`http://localhost/api/booking/${s.siteSlug}/staff?service_id=${s.serviceHaircut}`, { headers: { 'x-forwarded-for': ip() } }),
    { params: Promise.resolve({ slug: s.siteSlug }) },
  );
  assert.equal(res.status, 200);
  const raw = await res.text();
  const body = JSON.parse(raw) as { staff: Array<{ id: string; rating: unknown; reviews: Array<Record<string, unknown>> }> };
  const ana = body.staff.find((x) => x.id === s.staffA);
  assert.ok(ana);
  assert.deepEqual(ana.rating, { average: 5, count: 1 });
  assert.equal(ana.reviews.length, 1);
  assert.deepEqual(Object.keys(ana.reviews[0]).sort(), ['author', 'comment', 'rating', 'service', 'submitted_at']);
  for (const leak of ['Mateo', 'Pérez', tokens[0], tokens[1], s.clientId, s.tenantId]) {
    assert.ok(!raw.includes(leak), `the public payload never carries ${leak}`);
  }

  // A hidden review can be published later, and an approved one hidden again.
  assert.equal(await moderateReview(s.tenantId, s.clientId, tokens[0], 'hidden', 'user-1'), true);
  assert.equal((await publicStaffRatings(s.tenantId, s.siteId)).size, 0);
});

test('reviewPath is the public /resena route', () => {
  assert.equal(reviewPath('x'), '/resena/x');
});

import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, mock, test } from 'node:test';
import { query, withTransaction } from '../../src/db/client.js';
import { insertAppointment } from '../../src/db/repositories/scheduling/appointments.js';
import {
  ensureReviewRequest,
  listReviewsForModeration,
  moderateReview,
  publicServiceRatings,
  publicSiteRating,
  publicSiteReviews,
  publicStaffRatings,
  submitReview,
} from '../../src/db/repositories/scheduling/reviews.js';
import { importExternalReviewBatch, listExternalReviewsForClient } from '../../src/db/repositories/scheduling/externalReviews.js';
import { cleanupTenant, closeDb, seedContact, seedMember, seedScenario, type Scenario } from './fixtures.js';

/**
 * IMPORTED (FRESHA) REVIEWS — migration 1807, through the REAL server actions, the real
 * repository, PostgreSQL and the real public handlers. The only stubs are the session
 * read and Next's request boundaries (same pattern as timeOffPermissions.test.ts).
 *
 *  - Only a PLATFORM administrator (PLATFORM_ADMIN_USER_IDS) imports, reviews provenance,
 *    publishes, redacts and resolves. Tenant owner/admin, the business's owner, a setter,
 *    a member of another tenant and an anonymous caller are refused on EVERY action.
 *  - Imported reviews enter pending, are never public before a provenance review, and
 *    the DB itself refuses to publish one without it.
 *  - The business sees them read-only and can only ASK for a review or a withdrawal.
 *  - Unattributed reviews count for the business only — never an artist or a service.
 *  - Public payloads never carry evidence, provenance notes or the original text.
 */

let CURRENT: { id: string } | null = null;
mock.module('../../web/lib/session.ts', {
  namedExports: { getServerSession: async () => (CURRENT ? { user: { id: CURRENT.id, email: `${CURRENT.id.slice(0, 8)}@test.local` }, session: {} } : null) },
});
const reqFromWeb = createRequire(pathToFileURL(resolvePath(process.cwd(), 'web/lib/access.ts')));
const urlOf = (spec: string) => pathToFileURL(reqFromWeb.resolve(spec)).href;
mock.module(urlOf('next/navigation'), {
  namedExports: {
    redirect: () => { throw new Error('refused: redirect()'); },
    notFound: () => { throw new Error('refused: notFound()'); },
  },
});
mock.module(urlOf('next/headers'), {
  namedExports: { headers: async () => new Headers(), cookies: async () => ({ get: () => undefined, getAll: () => [] }) },
});
mock.module(urlOf('next/cache'), { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } });

const platform = await import('../../web/lib/platformReviewActions.js');
const business = await import('../../web/lib/reviewModerationActions.js');
const { isPlatformAdminId } = await import('../../web/lib/platformAdmin.js');

const prevAdmins = process.env.PLATFORM_ADMIN_USER_IDS;
const tenants: string[] = [];
const users: string[] = [];
after(async () => {
  if (prevAdmins === undefined) delete process.env.PLATFORM_ADMIN_USER_IDS;
  else process.env.PLATFORM_ADMIN_USER_IDS = prevAdmins;
  for (const t of tenants) await cleanupTenant(t);
  if (users.length) await query(`DELETE FROM "user" WHERE id = ANY($1::text[])`, [users]);
  await closeDb();
});

const as = (userId: string | null) => {
  CURRENT = userId ? { id: userId } : null;
};

/** A platform operator: a user that belongs to NO tenant. */
async function seedPlatformUser(): Promise<string> {
  const id = randomUUID();
  await query(`INSERT INTO "user" (id, name, email, "emailVerified") VALUES ($1, 'M_AI ops', $2, true)`, [id, `ops-${id.slice(0, 8)}@test.local`]);
  users.push(id);
  return id;
}

async function scenario(): Promise<Scenario> {
  const s = await seedScenario({ enableScheduling: true });
  tenants.push(s.tenantId);
  return s;
}

const CSV = [
  'Fecha,Cliente,Estrellas,Comentario,Artista,Servicio,Enlace',
  '2026-03-14,Andrés Gómez Ruiz,5,"Excelente, escríbeme a andres@correo.com o al 300 123 4567",Artista Uno,Corte,https://www.fresha.com/es/a/test/reviews/1',
  '2026-02-10,Lucía Pérez,4,Muy bien,Artista Uno,,captura-privada-0210.png',
  '2026-01-05,Mateo Ríos,3,Bien en general,,,',
].join('\n');

const sha = async (text: string) => {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
};

async function form(s: Scenario, opts: { mapping?: boolean; sha?: string | null; csv?: string } = {}): Promise<FormData> {
  const csv = opts.csv ?? CSV;
  const fd = new FormData();
  fd.set('file', new File([csv], 'fresha.csv', { type: 'text/csv' }));
  if (opts.mapping !== false) {
    fd.set('mapping', JSON.stringify({ site: s.siteSlug, staff: { 'Artista Uno': s.staffA }, services: { Corte: s.serviceHaircut } }));
  }
  if (opts.sha !== null) fd.set('expectSha256', opts.sha ?? (await sha(csv)));
  return fd;
}

/** A refusal is `{ ok: false }` or a thrown gate (notFound/redirect) — never a success. */
async function refused(fn: () => Promise<{ ok: boolean }>): Promise<boolean> {
  try {
    return (await fn()).ok === false;
  } catch {
    return true;
  }
}

const externalRows = (tenantId: string) =>
  query<{ id: string; status: string; provenance_status: string; staff_id: string | null; service_id: string | null; comment: string | null; original_comment: string | null; redactions: unknown[]; publish_consent: boolean; appointment_id: string | null; author_display: string }>(
    `SELECT id, status, provenance_status, staff_id, service_id, comment, original_comment, redactions, publish_consent, appointment_id, author_display
       FROM appointment_reviews WHERE tenant_id = $1 AND source = 'fresha' ORDER BY original_reviewed_at DESC`,
    [tenantId],
  ).then((r) => r.rows);

const ip = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.7`;
type SlugHandler = (req: Request, ctx: { params: Promise<{ slug: string }> }) => Promise<Response>;
async function publicGet(path: 'staff' | 'services', s: Scenario): Promise<string> {
  const mod = (path === 'staff'
    ? await import('../../web/app/api/booking/[slug]/staff/route.js')
    : await import('../../web/app/api/booking/[slug]/services/route.js')) as { GET: SlugHandler };
  const qs = path === 'staff' ? `?service_id=${s.serviceHaircut}` : '';
  const res = await mod.GET(new Request(`http://localhost/api/booking/${s.siteSlug}/${path}${qs}`, { headers: { 'x-forwarded-for': ip() } }), {
    params: Promise.resolve({ slug: s.siteSlug }),
  });
  assert.equal(res.status, 200);
  return res.text();
}

/** A review COLLECTED HERE (completed appointment → submitted → approved by the business). */
async function nativeApproved(s: Scenario, rating: number): Promise<string> {
  const contactId = await seedContact(s.tenantId, s.clientId, { name: 'Sara Nativa' });
  const start = new Date(Date.UTC(2026, 8, 2, 9, 0));
  const end = new Date(start.getTime() + 60 * 60_000);
  const a = await withTransaction((c) =>
    insertAppointment(c, {
      tenantId: s.tenantId, clientId: s.clientId, siteId: s.siteId, contactId, sourceConversationId: null,
      staffId: s.staffA, serviceId: s.serviceHaircut, startAt: start, serviceEndAt: end, blockedFrom: start, blockedUntil: end,
      serviceNameSnapshot: 'Corte clásico', durationMinSnapshot: 60, priceSnapshot: null, bufferBeforeMinSnapshot: 0, bufferAfterMinSnapshot: 0,
      origin: 'internal', createdByType: 'agent', createdByUserId: null, idempotencyKey: null,
    }),
  );
  await query(`UPDATE appointments SET status = 'completed' WHERE id = $1`, [a.id]);
  const req = await ensureReviewRequest(s.tenantId, s.clientId, a.id);
  assert.ok(req);
  assert.ok(await submitReview({ reviewId: req.id, rating, comment: 'Muy buen servicio', authorDisplay: 'Sara N.' }));
  assert.equal(await moderateReview(s.tenantId, s.clientId, req.id, 'approved', null), true);
  return req.id;
}

// ─────────────────────────────────────────────────────────────────────────────────────

test('platform admin is deny-by-default: unset, empty or malformed allow-list → nobody', () => {
  const id = randomUUID();
  delete process.env.PLATFORM_ADMIN_USER_IDS;
  assert.equal(isPlatformAdminId(id), false);
  process.env.PLATFORM_ADMIN_USER_IDS = ' , ,short,*';
  assert.equal(isPlatformAdminId('short'), false, 'too short to be an id');
  assert.equal(isPlatformAdminId('*'), false, 'no wildcard');
  assert.equal(isPlatformAdminId(''), false);
  assert.equal(isPlatformAdminId(null), false);
  process.env.PLATFORM_ADMIN_USER_IDS = ` x , ${id} `;
  assert.equal(isPlatformAdminId(id), true);
  assert.equal(isPlatformAdminId(id.toUpperCase()), false, 'exact id only');
});

test('EVERY platform action refuses tenant owner/admin, business roles, other tenants and anonymous', async () => {
  const s = await scenario();
  const other = await scenario();
  const admin = await seedPlatformUser();
  process.env.PLATFORM_ADMIN_USER_IDS = admin;

  const tenantOwner = await seedMember(s.tenantId, { role: 'owner' });
  const tenantAdmin = await seedMember(s.tenantId, { role: 'admin' });
  const clientOwner = await seedMember(s.tenantId, { role: 'member', clientId: s.clientId, clientRole: 'owner' });
  const setter = await seedMember(s.tenantId, { role: 'member', clientId: s.clientId, clientRole: 'setter' });
  const foreignOwner = await seedMember(other.tenantId, { role: 'owner' });
  users.push(tenantOwner, tenantAdmin, clientOwner, setter, foreignOwner);

  // A real imported review exists, so the refusals are not just "not found".
  as(admin);
  assert.equal((await platform.applyImportAction(s.siteId, await form(s))).ok, true);
  const [target] = await externalRows(s.tenantId);
  const before = JSON.stringify(await externalRows(s.tenantId));

  const actions: Array<[string, () => Promise<{ ok: boolean }>]> = [
    ['searchSites', () => platform.searchSitesAction('Test')],
    ['plan', async () => platform.planImportAction(s.siteId, await form(s))],
    ['apply', async () => platform.applyImportAction(s.siteId, await form(s, { csv: CSV.replace('Mateo Ríos', 'Otra Persona') }))],
    ['list', () => platform.listPlatformReviewsAction(s.siteId)],
    ['provenance', () => platform.reviewProvenanceAction(s.siteId, target.id, 'reviewed', 'ok')],
    ['publish', () => platform.setPublicationAction(s.siteId, target.id, 'approved')],
    ['redact', () => platform.redactCommentAction(s.siteId, target.id, 'texto', 'privacidad')],
    ['resolve', () => platform.resolveRequestAction(s.siteId, randomUUID(), 'withdrawn')],
  ];
  for (const [who, uid] of [
    ['tenant owner', tenantOwner],
    ['tenant admin', tenantAdmin],
    ['client owner', clientOwner],
    ['setter', setter],
    ['owner of another tenant', foreignOwner],
    ['anonymous', null],
  ] as const) {
    as(uid);
    for (const [name, fn] of actions) assert.ok(await refused(fn), `${who} → ${name} must be refused`);
  }
  // With the allow-list emptied, not even the operator gets in.
  process.env.PLATFORM_ADMIN_USER_IDS = '';
  as(admin);
  for (const [name, fn] of actions) assert.ok(await refused(fn), `empty allow-list → ${name} refused`);
  process.env.PLATFORM_ADMIN_USER_IDS = admin;

  // Positive control: the same calls work for the operator (so the refusals above are the gate).
  as(admin);
  const found = await platform.searchSitesAction('Test Barbershop');
  assert.ok(found.ok && found.sites.some((x) => x.id === s.siteId));
  const listed = await platform.listPlatformReviewsAction(s.siteId);
  assert.ok(listed.ok && listed.reviews.length === 3);
  const planned = await platform.planImportAction(s.siteId, await form(s));
  assert.ok(planned.ok && planned.plan.duplicates.length === 3);

  assert.equal(JSON.stringify(await externalRows(s.tenantId)), before, 'nothing changed');
  const batches = await query<{ n: number }>(`SELECT count(*)::int AS n FROM review_import_batches WHERE tenant_id = $1`, [s.tenantId]);
  assert.equal(batches.rows[0].n, 1, 'no refused import wrote a batch');
});

test('import → pending and invisible; no publication without provenance (action AND database)', async () => {
  const s = await scenario();
  const admin = await seedPlatformUser();
  process.env.PLATFORM_ADMIN_USER_IDS = admin;
  as(admin);

  // The dry-run writes nothing.
  const dry = await platform.planImportAction(s.siteId, await form(s));
  assert.ok(dry.ok);
  assert.equal(dry.plan.canApply, true);
  assert.equal(dry.plan.ready.length, 3);
  assert.equal((await externalRows(s.tenantId)).length, 0, 'dry-run wrote no review');

  // Apply requires the SAME file that was reviewed and the confirmed mapping.
  assert.equal((await platform.applyImportAction(s.siteId, await form(s, { sha: null }))).ok, false);
  assert.equal((await platform.applyImportAction(s.siteId, await form(s, { sha: 'a'.repeat(64) }))).ok, false);
  assert.equal((await platform.applyImportAction(s.siteId, await form(s, { mapping: false }))).ok, false);
  const applied = await platform.applyImportAction(s.siteId, await form(s));
  assert.deepEqual(applied, { ok: true, inserted: 3, skipped: 0 });

  const rows = await externalRows(s.tenantId);
  for (const r of rows) {
    assert.equal(r.status, 'pending');
    assert.equal(r.provenance_status, 'pending');
    assert.equal(r.publish_consent, false, 'no consent was given in M_AI');
    assert.equal(r.appointment_id, null, 'never presented as an M_AI appointment');
  }
  const [andres, lucia, mateo] = rows;
  assert.equal(andres.author_display, 'Andrés G.');
  assert.doesNotMatch(andres.comment!, /andres@|300 123/, 'public text redacted');
  assert.match(andres.original_comment!, /andres@correo\.com/, 'original kept for audit');
  assert.equal((andres.redactions as unknown[]).length, 1, 'the redaction is recorded');
  assert.equal(mateo.staff_id, null, 'unattributed');
  assert.equal(lucia.service_id, null);

  const batch = await query<{ imported_by: string; imported: number; file_sha256: string }>(`SELECT imported_by, imported, file_sha256 FROM review_import_batches WHERE tenant_id = $1`, [s.tenantId]);
  assert.equal(batch.rows[0].imported_by, admin);
  assert.equal(batch.rows[0].file_sha256, await sha(CSV), 'only the hash of the file is kept');
  const ev = await query<{ event_type: string; detail: Record<string, unknown> }>(`SELECT event_type, detail FROM review_events WHERE tenant_id = $1`, [s.tenantId]);
  assert.deepEqual(ev.rows.map((e) => e.event_type), ['imported']);
  assert.doesNotMatch(JSON.stringify(ev.rows), /andres@|300 123|Gómez/, 'no personal data in the audit log');

  // Nothing public yet.
  assert.equal(await publicSiteRating(s.tenantId, s.siteId), null);
  assert.equal((await publicSiteReviews(s.tenantId, s.siteId)).length, 0);
  assert.doesNotMatch(await publicGet('staff', s), /Andrés|Lucía|Mateo/);

  // Publishing before the provenance review: refused by the action…
  const early = await platform.setPublicationAction(s.siteId, andres.id, 'approved');
  assert.equal(early.ok, false);
  assert.match(early.ok ? '' : early.error, /procedencia/);
  // …and by the database, even for a direct UPDATE.
  await assert.rejects(query(`UPDATE appointment_reviews SET status = 'approved' WHERE id = $1`, [andres.id]), (e: { code?: string }) => e.code === '23514');
  // A rejected provenance can not be published either (and hides the review).
  assert.equal((await platform.reviewProvenanceAction(s.siteId, mateo.id, 'rejected', 'No hay forma de comprobarla')).ok, true);
  assert.equal((await platform.setPublicationAction(s.siteId, mateo.id, 'approved')).ok, false);
  await assert.rejects(query(`UPDATE appointment_reviews SET status = 'approved' WHERE id = $1`, [mateo.id]), (e: { code?: string }) => e.code === '23514');

  // Re-import of the same file: nothing new, no duplicate, no empty batch.
  assert.deepEqual(await platform.applyImportAction(s.siteId, await form(s)), { ok: true, inserted: 0, skipped: 3 });
  assert.equal((await externalRows(s.tenantId)).length, 3);
  const nb = await query<{ n: number }>(`SELECT count(*)::int AS n FROM review_import_batches WHERE tenant_id = $1`, [s.tenantId]);
  assert.equal(nb.rows[0].n, 1);
});

test('published: labelled as Fresha, mixed averages, unattributed out of artist/service, nothing private', async () => {
  const s = await scenario();
  const admin = await seedPlatformUser();
  process.env.PLATFORM_ADMIN_USER_IDS = admin;
  as(admin);
  await nativeApproved(s, 3);
  assert.equal((await platform.applyImportAction(s.siteId, await form(s))).ok, true);
  for (const r of await externalRows(s.tenantId)) {
    assert.equal((await platform.reviewProvenanceAction(s.siteId, r.id, 'reviewed', 'nota-interna-xyz: captura revisada')).ok, true);
    assert.equal((await platform.setPublicationAction(s.siteId, r.id, 'approved')).ok, true);
  }

  // Artist: 3★ native + 5★ + 4★ imported (Mateo's 3★ is unattributed → not here).
  assert.deepEqual((await publicStaffRatings(s.tenantId, s.siteId)).get(s.staffA), { average: 4, count: 3, imported: 2 });
  assert.equal((await publicStaffRatings(s.tenantId, s.siteId)).get(s.staffB), undefined, 'no other artist gets anything');
  // Service: native 3★ + Andrés 5★ (the only one with a confirmed service).
  assert.deepEqual((await publicServiceRatings(s.tenantId, s.siteId)).get(s.serviceHaircut), { average: 4, count: 2, imported: 1 });
  // The business: everything approved, including the unattributed one.
  assert.deepEqual(await publicSiteRating(s.tenantId, s.siteId), { average: 3.8, count: 4, imported: 3 });

  const raw = await publicGet('staff', s);
  const body = JSON.parse(raw) as { staff: Array<{ id: string; reviews: Array<Record<string, unknown>> }> };
  const reviews = body.staff.find((x) => x.id === s.staffA)!.reviews;
  const fresha = reviews.filter((r) => r.source === 'fresha');
  assert.equal(fresha.length, 2);
  assert.ok(reviews.some((r) => r.source === 'mai'), 'mixed list, each one labelled');
  assert.equal(fresha.find((r) => r.author === 'Andrés G.')!.source_url, 'https://www.fresha.com/es/a/test/reviews/1');
  assert.equal(fresha.find((r) => r.author === 'Lucía P.')!.source_url, null, 'a file name is never a public link');
  assert.equal(fresha.find((r) => r.author === 'Andrés G.')!.submitted_at, '2026-03-14T17:00:00.000Z', 'the ORIGINAL date');
  for (const r of reviews) assert.deepEqual(Object.keys(r).sort(), ['author', 'comment', 'rating', 'service', 'source', 'source_url', 'submitted_at']);

  const services = await publicGet('services', s);
  for (const leak of ['andres@correo.com', '300 123 4567', 'captura-privada', 'nota-interna-xyz', 'Gómez', 'Pérez', 'Ríos', 'evidence', 'original_comment', 'provenance', s.tenantId, s.clientId]) {
    assert.ok(!raw.includes(leak), `staff payload never carries ${leak}`);
    assert.ok(!services.includes(leak), `services payload never carries ${leak}`);
  }

  // A native review is untouched by all this.
  const native = reviews.find((r) => r.source === 'mai')!;
  assert.equal(native.author, 'Sara N.');
  assert.equal(native.source_url, null);
});

test('the business: read-only, can only ASK; cannot moderate, edit or approve an imported review', async () => {
  const s = await scenario();
  const other = await scenario();
  const admin = await seedPlatformUser();
  process.env.PLATFORM_ADMIN_USER_IDS = admin;
  const owner = await seedMember(s.tenantId, { role: 'member', clientId: s.clientId, clientRole: 'owner' });
  const tenantOwner = await seedMember(s.tenantId, { role: 'owner' });
  const otherClientOwner = await seedMember(s.tenantId, { role: 'member', clientId: s.otherClientId, clientRole: 'owner' });
  const foreignOwner = await seedMember(other.tenantId, { role: 'owner' });
  users.push(owner, tenantOwner, otherClientOwner, foreignOwner);

  as(admin);
  assert.equal((await platform.applyImportAction(s.siteId, await form(s))).ok, true);
  const [andres, lucia] = await externalRows(s.tenantId);
  await platform.reviewProvenanceAction(s.siteId, andres.id, 'reviewed', 'ok');
  await platform.setPublicationAction(s.siteId, andres.id, 'approved');

  // The business's moderation never reaches an imported review — not to hide, not to approve.
  for (const uid of [owner, tenantOwner]) {
    as(uid);
    assert.ok(await refused(() => business.moderateReviewAction(s.clientId, andres.id, 'hidden')));
    assert.ok(await refused(() => business.moderateReviewAction(s.clientId, lucia.id, 'approved')));
  }
  assert.equal(await moderateReview(s.tenantId, s.clientId, lucia.id, 'approved', owner), false, 'repository refuses too');
  assert.equal((await listReviewsForModeration(s.tenantId, s.clientId)).length, 0, 'imported reviews are not in the business queue');
  const st = await externalRows(s.tenantId);
  assert.equal(st[0].status, 'approved');
  assert.equal(st[1].status, 'pending');

  // What the business sees: no evidence, no notes, no original text.
  const seen = await listExternalReviewsForClient(s.tenantId, s.clientId);
  assert.equal(seen.length, 3);
  for (const r of seen) for (const k of ['evidence_ref', 'original_comment', 'provenance_notes', 'public_source_url', 'redactions']) assert.ok(!(k in r), k);
  assert.doesNotMatch(JSON.stringify(seen), /andres@|300 123|captura-privada/);

  // It may ASK — once per kind — for its own reviews only.
  as(owner);
  assert.equal((await business.requestExternalReviewAction(s.clientId, andres.id, 'withdraw', 'No reconocemos este cliente')).ok, true);
  const dup = await business.requestExternalReviewAction(s.clientId, andres.id, 'withdraw', 'otra vez');
  assert.equal(dup.ok, false);
  as(otherClientOwner);
  assert.ok(await refused(() => business.requestExternalReviewAction(s.otherClientId, andres.id, 'review', 'x')), 'another client of the tenant');
  assert.ok(await refused(() => business.requestExternalReviewAction(s.clientId, andres.id, 'review', 'x')), 'not their client');
  as(foreignOwner);
  assert.ok(await refused(() => business.requestExternalReviewAction(s.clientId, andres.id, 'review', 'x')), 'another tenant');
  as(owner);
  assert.ok(await refused(() => platform.resolveRequestAction(s.siteId, randomUUID(), 'withdrawn')), 'the business can not resolve');

  // Only the platform administrator resolves: a withdrawal hides it from the page.
  const q = await query<{ id: string }>(`SELECT id FROM external_review_requests WHERE review_id = $1`, [andres.id]);
  as(admin);
  assert.equal((await platform.resolveRequestAction(s.siteId, q.rows[0].id, 'withdrawn')).ok, true);
  assert.equal((await externalRows(s.tenantId))[0].status, 'hidden');
  assert.equal(await publicSiteRating(s.tenantId, s.siteId), null);
});

test('tenant / client / site isolation for the platform administrator too', async () => {
  const a = await scenario();
  const b = await scenario();
  const admin = await seedPlatformUser();
  process.env.PLATFORM_ADMIN_USER_IDS = admin;
  as(admin);
  assert.equal((await platform.applyImportAction(a.siteId, await form(a))).ok, true);
  const [ra] = await externalRows(a.tenantId);

  // Acting "on site B" with a review of site A: not found, nothing changes.
  assert.equal((await platform.reviewProvenanceAction(b.siteId, ra.id, 'reviewed', 'x')).ok, false);
  assert.equal((await platform.setPublicationAction(b.siteId, ra.id, 'hidden')).ok, false);
  assert.equal((await platform.redactCommentAction(b.siteId, ra.id, 'x', 'y')).ok, false);
  const listB = await platform.listPlatformReviewsAction(b.siteId);
  assert.ok(listB.ok);
  assert.equal(listB.reviews.length, 0);
  assert.equal((await externalRows(a.tenantId))[0].provenance_status, 'pending');

  // A mapping that points at ANOTHER tenant's artist / service is refused by the plan…
  const fd = await form(a);
  fd.set('mapping', JSON.stringify({ site: a.siteSlug, staff: { 'Artista Uno': b.staffA }, services: { Corte: b.serviceHaircut } }));
  const csv2 = CSV.replace('Mateo Ríos', 'Persona Nueva');
  fd.set('file', new File([csv2], 'x.csv'));
  fd.set('expectSha256', await sha(csv2));
  assert.equal((await platform.applyImportAction(a.siteId, fd)).ok, false);
  // …and by the repository, as defence in depth.
  await assert.rejects(
    importExternalReviewBatch({
      tenantId: a.tenantId, clientId: a.clientId, siteId: a.siteId, fileName: null, fileSha256: 'b'.repeat(64),
      totals: { rows: 1, duplicates: 0, rejected: 0 }, mapping: {}, actor: admin,
      rows: [{
        externalKey: 'h:x', staffId: b.staffA, serviceId: null, serviceName: null, rating: 5, comment: 'x', originalComment: 'x', redacted: false,
        authorDisplay: 'X.', originalReviewedAt: new Date('2026-01-01T12:00:00Z'), evidenceRef: null, publicSourceUrl: null,
      }],
    }),
    /does not belong/,
  );
  assert.equal((await externalRows(a.tenantId)).length, 3);
  assert.equal((await externalRows(b.tenantId)).length, 0);
});

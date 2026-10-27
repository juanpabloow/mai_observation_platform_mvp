import { strict as assert } from 'node:assert';
import { createHmac, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, mock, test } from 'node:test';
import { query } from '../../src/db/client.js';
import { cleanupTenant, closeDb, seedMember, seedScenario } from './fixtures.js';
import {
  createOrReplacePendingInvitation,
  generateInviteToken,
  hashInviteToken,
} from '../../src/db/repositories/invitations.js';
import { canViewUserAvatar } from '../../src/db/repositories/userProfiles.js';

/**
 * ACCESO-1 — sessions, re-authentication, the activity endpoint, invitations and the personal
 * profile, END TO END on the server: the REAL Better Auth instance of web/lib/auth.ts (session
 * policy hooks, disabled paths) against the local test database, real session cookies, and the
 * real server actions / route handlers. Only Next's request boundary (headers/cookies) is
 * replaced by a per-test "browser" — the cookie jar the test controls.
 */
let JAR = new Headers();
const reqFromWeb = createRequire(pathToFileURL(resolvePath(process.cwd(), 'web/lib/access.ts')));
const urlOf = (spec: string) => pathToFileURL(reqFromWeb.resolve(spec)).href;
mock.module(urlOf('next/navigation'), {
  namedExports: { redirect: (to: string) => { throw new Error(`redirect:${to}`); }, notFound: () => { throw new Error('notFound'); } },
});
mock.module(urlOf('next/headers'), {
  namedExports: {
    headers: async () => JAR,
    cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => {} }),
  },
});
mock.module(urlOf('next/cache'), { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } });

const { auth } = await import('../../web/lib/auth.js');
const sessions = await import('../../web/lib/sessionActions.js');
const account = await import('../../web/lib/accountActions.js');
const invites = await import('../../web/lib/inviteActions.js');
const route = await import('../../web/app/api/account/session/route.js');
after(closeDb);

const ctx = await auth.$context;
const BASE = ctx.baseURL.replace(/\/api\/auth$/, '');
const COOKIE = ctx.authCookies.sessionToken.name;
const PASSWORD = 'synthetic-pass-2026';

async function newUser(email: string, opts: { password?: boolean } = {}): Promise<string> {
  if (opts.password === false) {
    const id = randomUUID();
    await query(`INSERT INTO "user" (id, name, email, "emailVerified") VALUES ($1, 'Solo Google', $2, true)`, [id, email]);
    await query(`INSERT INTO account (id, "accountId", "providerId", "userId", "createdAt", "updatedAt") VALUES ($1, $2, 'google', $3, now(), now())`, [randomUUID(), `g-${id}`, id]);
    return id;
  }
  await auth.api.signUpEmail({ body: { email, password: PASSWORD, name: 'Persona Sintética' } });
  const r = await query<{ id: string }>(`UPDATE "user" SET "emailVerified" = true WHERE email = $1 RETURNING id`, [email]);
  return r.rows[0]!.id;
}

/** Sign in like the browser does (real endpoint), returning the cookie + the session id. */
async function signIn(email: string, rememberMe = false): Promise<{ cookie: string; id: string }> {
  const res = await auth.handler(
    new Request(`${BASE}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE, 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/130.0 Safari/537.36' },
      body: JSON.stringify({ email, password: PASSWORD, rememberMe }),
    }),
  );
  assert.equal(res.status, 200, await res.clone().text());
  const set = res.headers.getSetCookie().find((c) => c.split('=')[0] === COOKIE)!;
  const cookie = set.split(';')[0]!;
  const s = await auth.api.getSession({ headers: new Headers({ cookie }) });
  return { cookie, id: s!.session.id };
}

/** A session minted WITHOUT a browser (for a Google-only account), with a correctly signed cookie. */
async function mintSession(userId: string): Promise<{ cookie: string; id: string }> {
  const s = await ctx.internalAdapter.createSession(userId);
  const sig = createHmac('sha256', ctx.secret).update(s.token).digest('base64');
  return { cookie: `${COOKIE}=${encodeURIComponent(`${s.token}.${sig}`)}`, id: s.id };
}

const as = (cookie: string) => {
  JAR = new Headers({ cookie, origin: BASE });
};
const alive = async (cookie: string) => Boolean(await auth.api.getSession({ headers: new Headers({ cookie }) }));
const setReauth = (id: string, at: Date | null) => query(`UPDATE session SET "reauthenticatedAt" = $2 WHERE id = $1`, [id, at]);
const email = (p: string) => `${p}-${randomUUID().slice(0, 8)}@example.test`;

test('closing ANOTHER session needs a recent authentication checked on the server; the revoked browser is out on its next request', async () => {
  const s = await seedScenario();
  try {
    const mail = email('reauth');
    const userId = await newUser(mail);
    await query(`INSERT INTO tenant_members (tenant_id, user_id, role, member_client_id, client_role) VALUES ($1, $2, 'member', $3, 'setter')`, [s.tenantId, userId, s.clientId]);
    const here = await signIn(mail);
    const there = await signIn(mail, true);
    as(here.cookie);

    // Signing in IS a fresh authentication.
    const list = await sessions.listMySessionsAction();
    assert.ok(list.ok && list.data.recentAuth && list.data.others.some((o) => o.id === there.id));

    // 11 minutes later it no longer counts.
    await setReauth(here.id, new Date(Date.now() - 11 * 60_000));
    const refused = await sessions.revokeSessionAction(there.id);
    assert.deepEqual(refused, { ok: false, needsReauth: true });
    assert.ok(await alive(there.cookie), 'nothing closed without re-authentication');

    const wrong = await sessions.reauthWithPasswordAction('not-the-password');
    assert.equal(wrong.ok, false);
    const right = await sessions.reauthWithPasswordAction(PASSWORD);
    assert.equal(right.ok, true);

    const closed = await sessions.revokeSessionAction(there.id);
    assert.deepEqual(closed, { ok: true, closed: 1 });
    assert.equal(await alive(there.cookie), false, 'the revoked cookie no longer authenticates anything');
    assert.ok(await alive(here.cookie), 'the current session stays');

    // The current session can never be "revoked" through this path (that is sign-out).
    const self = await sessions.revokeSessionAction(here.id);
    assert.equal(self.ok, false);
  } finally {
    await cleanupTenant(s.tenantId);
  }
});

test('«Cerrar las demás» keeps only this session', async () => {
  const mail = email('others');
  await newUser(mail);
  const a = await signIn(mail);
  const b = await signIn(mail);
  const c = await signIn(mail, true);
  as(a.cookie);
  const r = await sessions.revokeOtherSessionsAction();
  assert.deepEqual(r, { ok: true, closed: 2 });
  assert.ok(await alive(a.cookie));
  assert.equal(await alive(b.cookie), false);
  assert.equal(await alive(c.cookie), false);
});

test('a person can only see and close THEIR sessions — never another user, same tenant or not', async () => {
  const s = await seedScenario();
  const s2 = await seedScenario();
  try {
    const mine = email('mine');
    const colleague = email('colleague');
    const stranger = email('stranger');
    const me = await newUser(mine);
    const col = await newUser(colleague);
    const str = await newUser(stranger);
    await query(`INSERT INTO tenant_members (tenant_id, user_id, role, member_client_id, client_role) VALUES ($1, $2, 'member', $3, 'setter'), ($1, $4, 'member', $3, 'owner')`, [s.tenantId, me, s.clientId, col]);
    await query(`INSERT INTO tenant_members (tenant_id, user_id, role) VALUES ($1, $2, 'owner')`, [s2.tenantId, str]);
    const mySession = await signIn(mine);
    const colSession = await signIn(colleague);
    const strSession = await signIn(stranger);
    as(mySession.cookie);

    const list = await sessions.listMySessionsAction();
    assert.ok(list.ok);
    const ids = [list.data.current.id, ...list.data.others.map((o) => o.id)];
    assert.ok(!ids.includes(colSession.id) && !ids.includes(strSession.id), 'other users never listed');

    for (const foreign of [colSession.id, strSession.id]) {
      const r = await sessions.revokeSessionAction(foreign);
      assert.deepEqual(r, { ok: true, closed: 0 }, 'a foreign id closes nothing and reveals nothing');
    }
    assert.ok(await alive(colSession.cookie));
    assert.ok(await alive(strSession.cookie));
    await sessions.revokeOtherSessionsAction();
    assert.ok(await alive(colSession.cookie), '«las demás» means MY other sessions only');
    assert.ok(await alive(strSession.cookie));

    // The private photo follows the same boundary: team yes, other tenant no.
    assert.equal(await canViewUserAvatar(col, me), true);
    assert.equal(await canViewUserAvatar(str, me), false);
  } finally {
    await cleanupTenant(s.tenantId);
    await cleanupTenant(s2.tenantId);
  }
});

test('a Google-only account is never asked for a password; its confirmation is a server-issued, session-bound challenge', async () => {
  const mail = email('gonly');
  const userId = await newUser(mail, { password: false });
  const here = await mintSession(userId);
  as(here.cookie);
  const list = await sessions.listMySessionsAction();
  assert.ok(list.ok);
  assert.equal(list.data.methods.password, false);
  const pw = await sessions.reauthWithPasswordAction('anything');
  assert.equal(pw.ok, false, 'no password path for a Google-only account');

  const start = await sessions.startGoogleReauthAction();
  const { isGoogleReauthAvailable } = await import('../../web/lib/auth.js');
  if (!isGoogleReauthAvailable) {
    assert.equal(start.ok, false, 'without Google "Session age claims" there is no Google confirmation');
    return;
  }
  assert.ok(start.ok);
  const row = await query<{ value: string; expiresAt: Date }>(`SELECT value, "expiresAt" FROM verification WHERE identifier = $1`, [`mai-reauth:${start.nonce}`]);
  const challenge = JSON.parse(row.rows[0]!.value) as { email: string };
  assert.equal(challenge.email, mail, 'bound to THIS account');
  assert.ok(row.rows[0]!.expiresAt.getTime() - Date.now() <= 10 * 60_000 + 1000, 'valid ≤ 10 minutes');
});

test('the activity endpoint: real interaction restarts 2 h (never past 12 h); reads and polling never extend; cross-site POST refused; expired = 401', async () => {
  const mail = email('activity');
  await newUser(mail);
  const shared = await signIn(mail, false);
  const keep = await signIn(mail, true);
  const call = (cookie: string, method: 'GET' | 'POST', origin = BASE) =>
    (method === 'GET' ? route.GET : route.POST)(
      new Request(`${BASE}/api/account/session`, { method, headers: { cookie, origin, 'sec-fetch-site': origin === BASE ? 'same-origin' : 'cross-site' } }),
    );
  const deadline = async (id: string) => (await query<{ e: Date; a: Date }>(`SELECT "expiresAt" e, "absoluteExpiresAt" a FROM session WHERE id = $1`, [id])).rows[0];

  // Simulate 90 minutes of inactivity, then polling.
  await query(`UPDATE session SET "lastActivityAt" = now() - interval '90 minutes', "expiresAt" = now() + interval '30 minutes' WHERE id = $1`, [shared.id]);
  const before = await deadline(shared.id);
  for (let i = 0; i < 5; i++) assert.equal((await call(shared.cookie, 'GET')).status, 200);
  assert.equal((await deadline(shared.id))!.e.getTime(), before!.e.getTime(), 'GET (polling) never moves the deadline');

  assert.equal((await call(shared.cookie, 'POST', 'https://evil.example')).status, 403, 'cross-site activity refused');
  const r = await call(shared.cookie, 'POST');
  assert.equal(r.status, 200);
  const after2h = await deadline(shared.id);
  assert.ok(Math.abs(after2h!.e.getTime() - (Date.now() + 2 * 3600_000)) < 60_000, 'restarted to now + 2 h');

  // Near the 12-hour end the restart is clamped to it.
  await query(`UPDATE session SET "absoluteExpiresAt" = now() + interval '20 minutes', "expiresAt" = now() + interval '10 minutes' WHERE id = $1`, [shared.id]);
  await call(shared.cookie, 'POST');
  const clamped = await deadline(shared.id);
  assert.equal(clamped!.e.getTime(), clamped!.a.getTime(), 'never past the absolute end');

  // Persistent: activity changes nothing (30 days fixed).
  const k0 = await deadline(keep.id);
  await call(keep.cookie, 'POST');
  assert.equal((await deadline(keep.id))!.e.getTime(), k0!.e.getTime());

  // Expired on the server → every surface refuses it.
  await query(`UPDATE session SET "expiresAt" = now() - interval '1 second' WHERE id = $1`, [shared.id]);
  assert.equal((await call(shared.cookie, 'GET')).status, 401);
  assert.equal(await alive(shared.cookie), false);
  as(shared.cookie);
  const l = await sessions.listMySessionsAction();
  assert.equal(l.ok, false, 'server actions refuse an expired session too');
});

async function inviteFor(s: Awaited<ReturnType<typeof seedScenario>>, to: string, expiresInMs = 7 * 86_400_000): Promise<string> {
  const inviter = await seedMember(s.tenantId, { role: 'owner' });
  const raw = generateInviteToken();
  await createOrReplacePendingInvitation({
    tenantId: s.tenantId,
    email: to,
    role: 'member',
    memberClientId: s.clientId,
    clientRole: 'setter',
    tokenHash: hashInviteToken(raw),
    invitedBy: inviter,
    expiresAt: new Date(Date.now() + expiresInMs),
  });
  return raw;
}

test('invitation, NEW person: one profile, email verified, membership with the SERVER role, no personal workspace; single use', async () => {
  const s = await seedScenario();
  try {
    const to = email('nueva');
    const token = await inviteFor(s, to);
    JAR = new Headers();
    const r = await invites.createProfileFromInvitationAction({ token, name: "  Valentína  O'Ríos ", password: PASSWORD });
    assert.equal(r.ok, true, r.ok ? '' : r.error);
    const u = await query<{ id: string; name: string; v: boolean }>(`SELECT id, name, "emailVerified" v FROM "user" WHERE email = $1`, [to]);
    assert.equal(u.rows[0]!.name, "Valentína O'Ríos", 'one free field, normalized, accents kept');
    assert.equal(u.rows[0]!.v, true);
    const m = await query<{ tenant_id: string; client_role: string; member_client_id: string }>(`SELECT tenant_id, client_role, member_client_id FROM tenant_members WHERE user_id = $1`, [u.rows[0]!.id]);
    assert.equal(m.rowCount, 1, 'exactly one membership — no personal tenant was provisioned');
    assert.equal(m.rows[0]!.tenant_id, s.tenantId);
    assert.equal(m.rows[0]!.client_role, 'setter', 'role from the invitation row');
    assert.equal(m.rows[0]!.member_client_id, s.clientId);
    // The browser then signs in with the normal endpoint.
    const signed = await signIn(to);
    assert.ok(signed.cookie);

    const again = await invites.createProfileFromInvitationAction({ token, name: 'Otra', password: PASSWORD });
    assert.equal(again.ok, false, 'single use');
  } finally {
    await cleanupTenant(s.tenantId);
  }
});

test('invitation, EXISTING account: never a second account or password; expired and wrong-account links refused', async () => {
  const s = await seedScenario();
  try {
    const to = email('existe');
    const userId = await newUser(to);
    const token = await inviteFor(s, to);
    JAR = new Headers();
    const r = await invites.createProfileFromInvitationAction({ token, name: 'Intruso', password: 'otra-clave-123' });
    assert.ok(!r.ok && r.code === 'exists');
    const accounts = await query(`SELECT 1 FROM account WHERE "userId" = $1`, [userId]);
    assert.equal(accounts.rowCount, 1, 'no second credential');

    // Signed in as SOMEONE ELSE → refused.
    const other = email('otra');
    await newUser(other);
    as((await signIn(other)).cookie);
    const wrong = await invites.acceptInvitationAction(token);
    assert.equal(wrong.ok, false);

    // Signed in as the invited person. A business sign-up gave this account its OWN workspace;
    // V1 keeps one workspace per account, so that is refused with an explicit message…
    as((await signIn(to)).cookie);
    const busy = await invites.acceptInvitationAction(token);
    assert.ok(!busy.ok && /otro espacio de trabajo/.test(busy.error ?? ''));
    // …and an account with no workspace (e.g. removed from its previous team) joins with the
    // account it already has.
    await query(`DELETE FROM tenant_members WHERE user_id = $1`, [userId]);
    const ok = await invites.acceptInvitationAction(token);
    assert.equal(ok.ok, true, ok.error);
    const m = await query(`SELECT 1 FROM tenant_members WHERE tenant_id = $1 AND user_id = $2`, [s.tenantId, userId]);
    assert.equal(m.rowCount, 1);

    const expiredToken = await inviteFor(s, email('vencida'), -60_000);
    JAR = new Headers();
    const expired = await invites.createProfileFromInvitationAction({ token: expiredToken, name: 'Tarde', password: PASSWORD });
    assert.ok(!expired.ok && expired.code === 'invalid');
  } finally {
    await cleanupTenant(s.tenantId);
  }
});

test('personal profile: phone validated + normalized on the server; photo validated by bytes; nothing for a signed-out caller', async () => {
  const mail = email('perfil');
  const userId = await newUser(mail);
  as((await signIn(mail)).cookie);
  const bad = await account.saveMyPhoneAction({ country: 'CO', national: '123 45' });
  assert.ok(!bad.ok && bad.field === 'phone');
  const ok = await account.saveMyPhoneAction({ country: 'MX', national: '55 1234 5678' });
  assert.ok(ok.ok && ok.e164 === '+525512345678');
  const row = await query<{ phone_e164: string; phone_country: string }>(`SELECT phone_e164, phone_country FROM user_profiles WHERE user_id = $1`, [userId]);
  assert.deepEqual(row.rows[0], { phone_e164: '+525512345678', phone_country: 'MX' });

  const svg = new File([new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')], 'x.png', { type: 'image/png' });
  const fd = new FormData();
  fd.set('photo', svg);
  const rejected = await account.uploadMyAvatarAction(fd);
  assert.ok(!rejected.ok && rejected.field === 'photo', 'an SVG renamed .png is refused');

  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const fd2 = new FormData();
  fd2.set('photo', new File([png], 'a.png', { type: 'image/png' }));
  assert.ok((await account.uploadMyAvatarAction(fd2)).ok);

  JAR = new Headers();
  assert.equal((await account.saveMyPhoneAction({ country: 'CO', national: '300 123 4567' })).ok, false, 'signed-out caller');
});

test('Better Auth HTTP list/revoke endpoints are disabled in the real instance', async () => {
  const mail = email('paths');
  await newUser(mail);
  const a = await signIn(mail);
  for (const p of ['/list-sessions', '/revoke-other-sessions', '/revoke-sessions']) {
    const res = await auth.handler(new Request(`${BASE}/api/auth${p}`, { method: p === '/list-sessions' ? 'GET' : 'POST', headers: { cookie: a.cookie, origin: BASE, 'content-type': 'application/json' }, body: p === '/list-sessions' ? undefined : '{}' }));
    assert.equal(res.status, 404, p);
  }
});

test('sessions written by the PREVIOUS code are clamped on read — never extended, gone if already past', async () => {
  const mail = email('legacy');
  await newUser(mail);
  const a = await signIn(mail);
  const b = await signIn(mail);
  // a: what the old code creates during the deploy window (no policy columns set), 7 days.
  await query(`UPDATE session SET "absoluteExpiresAt" = NULL, persistent = false, "authMethod" = NULL, "expiresAt" = now() + interval '7 days' WHERE id = $1`, [a.id]);
  as(a.cookie);
  const s = await (await import('../../web/lib/session.js')).getSessionFromHeaders(new Headers({ cookie: a.cookie }));
  assert.ok(s, 'still signed in');
  assert.equal(s!.session.persistent, true);
  assert.equal(s!.session.authMethod, 'legacy');
  const row = (await query<{ e: Date; a: Date }>(`SELECT "expiresAt" e, "absoluteExpiresAt" a FROM session WHERE id = $1`, [a.id])).rows[0]!;
  assert.ok(row.e.getTime() <= row.a.getTime() && row.e.getTime() <= Date.now() + 7 * 86_400_000, 'adopted with its own deadline, not more');

  // b: a non-persistent session the old code slid past its 12-hour end (code rollback), and
  // whose end is already behind us → the new code treats it as gone.
  await query(`UPDATE session SET "absoluteExpiresAt" = now() - interval '1 minute', "expiresAt" = now() + interval '7 days' WHERE id = $1`, [b.id]);
  const gone = await (await import('../../web/lib/session.js')).getSessionFromHeaders(new Headers({ cookie: b.cookie }));
  assert.equal(gone, null, 'past its absolute end once clamped');
});

test('a Google sign-in without a recent auth_time cannot close other sessions; the Google confirmation is not offered unless Google can prove freshness', async () => {
  const mail = email('gnorecent');
  const userId = await newUser(mail);
  await query(`INSERT INTO account (id, "accountId", "providerId", "userId", "createdAt", "updatedAt") VALUES ($1, $2, 'google', $3, now(), now())`, [randomUUID(), `g-${userId}`, userId]);
  const here = await mintSession(userId);
  const other = await signIn(mail);
  await query(`UPDATE session SET "authMethod" = 'google', "reauthenticatedAt" = NULL WHERE id = $1`, [here.id]);
  as(here.cookie);
  assert.deepEqual(await sessions.revokeSessionAction(other.id), { ok: false, needsReauth: true });
  assert.deepEqual(await sessions.revokeOtherSessionsAction(), { ok: false, needsReauth: true });
  assert.ok(await alive(other.cookie));
  const { isGoogleReauthAvailable } = await import('../../web/lib/auth.js');
  const start = await sessions.startGoogleReauthAction();
  assert.equal(start.ok, isGoogleReauthAvailable, 'offered only when "Session age claims" is declared enabled');
  // Closing THIS session stays available (plain sign-out), and the password path still works.
  assert.equal((await sessions.reauthWithPasswordAction(PASSWORD)).ok, true);
  assert.deepEqual(await sessions.revokeSessionAction(other.id), { ok: true, closed: 1 });
});

// ---------------------------------------------------------------------------------------
// Reconciliation respects RECORDED activity, and concurrent validation never accepts a
// session that is expired or revoked when it is judged (real database, real Better Auth).

const { reconcileLegacySessions, getSessionPolicyRow } = await import('../../src/db/repositories/authSessions.js');
const { validateUnderPolicy } = await import('../../web/lib/sessionValidation.js');
const { getSessionFromHeaders } = await import('../../web/lib/session.js');
const realDeps = {
  now: () => new Date(),
  reconcile: (id: string) => reconcileLegacySessions({ idleMs: 2 * 3600_000, sessionId: id }),
  read: getSessionPolicyRow,
};

/** "10:00 / 12:00 / 13:00" relative to now: last activity 3 h ago, idle end 1 h ago,
 *  12-hour end still 8 h ahead, and the previous code slid expiresAt 7 days. */
async function slidByOldCode(sessionId: string) {
  await query(
    `UPDATE session SET persistent = false, "createdAt" = now() - interval '4 hours',
            "absoluteExpiresAt" = now() + interval '8 hours', "lastActivityAt" = now() - interval '3 hours',
            "expiresAt" = now() + interval '7 days' WHERE id = $1`,
    [sessionId],
  );
}

test('last activity 10:00, idle end 12:00, old code slides, new code reconciles at 13:00 → expired, NOT valid until 15:00', async () => {
  const mail = email('idle');
  await newUser(mail);
  const s = await signIn(mail);
  await slidByOldCode(s.id);
  const before = (await query<{ l: Date }>(`SELECT "lastActivityAt" l FROM session WHERE id = $1`, [s.id])).rows[0]!.l;

  await reconcileLegacySessions({ idleMs: 2 * 3600_000 }); // what the server start-up does
  const row = (await query<{ e: Date; l: Date }>(`SELECT "expiresAt" e, "lastActivityAt" l FROM session WHERE id = $1`, [s.id])).rows[0]!;
  assert.equal(row.e.getTime(), before.getTime() + 2 * 3600_000, 'expiresAt = last RECORDED activity + 2 h (in the past)');
  assert.equal(row.l.getTime(), before.getTime(), 'reconciling is not activity');
  assert.ok(row.e.getTime() < Date.now(), 'already over');

  assert.equal(await getSessionFromHeaders(new Headers({ cookie: s.cookie })), null, 'our validation refuses it');
  assert.equal(await alive(s.cookie), false, 'Better Auth itself refuses it');
  const post = await route.POST(new Request(`${BASE}/api/account/session`, { method: 'POST', headers: { cookie: s.cookie, origin: BASE, 'sec-fetch-site': 'same-origin' } }));
  assert.equal(post.status, 401, 'an activity report cannot revive it');
});

test('the same slid session judged per request (no start-up pass) is refused too — and polling first changes nothing', async () => {
  const mail = email('idle2');
  await newUser(mail);
  const s = await signIn(mail);
  await slidByOldCode(s.id);
  for (let i = 0; i < 3; i++) {
    const r = await route.GET(new Request(`${BASE}/api/account/session`, { headers: { cookie: s.cookie } }));
    assert.equal(r.status, 401, `poll ${i}: refused`);
  }
  assert.equal(await getSessionFromHeaders(new Headers({ cookie: s.cookie })), null);
});

test('20 concurrent requests on a slid-but-still-valid session: all get the same real limit; none extends it', async () => {
  const mail = email('conc');
  await newUser(mail);
  const s = await signIn(mail);
  await query(
    `UPDATE session SET persistent = false, "createdAt" = now() - interval '1 hour', "absoluteExpiresAt" = now() + interval '11 hours',
            "lastActivityAt" = now() - interval '30 minutes', "expiresAt" = now() + interval '7 days' WHERE id = $1`,
    [s.id],
  );
  const lastAct = (await query<{ l: Date }>(`SELECT "lastActivityAt" l FROM session WHERE id = $1`, [s.id])).rows[0]!.l;
  const results = await Promise.all(Array.from({ length: 20 }, () => getSessionFromHeaders(new Headers({ cookie: s.cookie }))));
  for (const r of results) {
    assert.ok(r, 'valid: 30 min since the last activity');
    assert.equal(new Date(r!.session.expiresAt).getTime(), lastAct.getTime() + 2 * 3600_000);
  }
  const stored = (await query<{ e: Date }>(`SELECT "expiresAt" e FROM session WHERE id = $1`, [s.id])).rows[0]!.e;
  assert.equal(stored.getTime(), lastAct.getTime() + 2 * 3600_000, 'stored once, at the real limit');
});

test('revoked or expired AFTER Better Auth read it but BEFORE our validation → refused', async () => {
  const mail = email('race');
  await newUser(mail);
  const a = await signIn(mail);
  const b = await signIn(mail);
  for (const x of [a, b]) {
    await query(`UPDATE session SET "absoluteExpiresAt" = NULL, "authMethod" = NULL, "expiresAt" = now() + interval '6 days' WHERE id = $1`, [x.id]);
  }
  const readA = await auth.api.getSession({ headers: new Headers({ cookie: a.cookie }) });
  const readB = await auth.api.getSession({ headers: new Headers({ cookie: b.cookie }) });
  assert.ok(readA && readB, 'Better Auth accepted both (its own expiresAt is fine)');
  await query(`DELETE FROM session WHERE id = $1`, [a.id]); // revoked from another tab
  await query(`UPDATE session SET "expiresAt" = now() - interval '1 second' WHERE id = $1`, [b.id]); // ran out
  assert.equal(await validateUnderPolicy(readA, realDeps), null, 'revoked → refused');
  assert.equal(await validateUnderPolicy(readB, realDeps), null, 'expired → refused');
});

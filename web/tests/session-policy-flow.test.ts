/**
 * ACCESO-1 — session policy against a REAL Better Auth 1.6.19 instance (official in-memory
 * adapter, no Postgres, synthetic users). The instance carries the SAME session options,
 * hooks and disabled paths production uses (web/lib/auth-session-policy.ts); Google is the
 * real provider with only the token endpoint answered locally (no network, no real account).
 *
 * The clock is controlled with node:test's mock timers (Date only), so "2 hours idle",
 * "12 hours" and "30 days" are asserted exactly — and asserted where it matters: Better
 * Auth's own getSession, i.e. what every API and page uses.
 *
 * Run from the repo root:  npm run test:auth
 */
import { afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { createAuthMiddleware } from "better-auth/api";

import { ACCOUNT_LINKING_POLICY, buildEmailVerification, buildPasswordReset } from "../lib/auth-verification";
import {
  DISABLED_SESSION_PATHS,
  KEEP_SESSION_STATE_KEY,
  REAUTH_STATE_KEY,
  buildSessionPolicy,
  reauthIdentifier,
} from "../lib/auth-session-policy";
import { DAY_MS, HOUR_MS, MINUTE_MS, onActivity } from "../lib/sessionPolicy";

const T0 = Date.parse("2026-10-26T14:00:00.000Z");
const BASE = "https://app.test";

beforeEach(() => mock.timers.enable({ apis: ["Date"], now: T0 }));
afterEach(() => mock.timers.reset());

type Row = Record<string, unknown>;

function makeAuth({ allowPersistent = true }: { allowPersistent?: boolean } = {}) {
  const db: Record<string, Row[]> = { user: [], session: [], account: [], verification: [] };
  const send = async () => ({ ok: true as const, id: "t" });
  const policy = buildSessionPolicy({ allowPersistent: async () => allowPersistent });
  const auth = betterAuth({
    database: memoryAdapter(db),
    baseURL: BASE,
    secret: "test-secret-test-secret-test-secret",
    session: policy.session,
    disabledPaths: DISABLED_SESSION_PATHS,
    emailAndPassword: { enabled: true, requireEmailVerification: true, ...buildPasswordReset(send) },
    emailVerification: buildEmailVerification(send),
    account: { accountLinking: { ...ACCOUNT_LINKING_POLICY } },
    socialProviders: {
      google: {
        clientId: "test-client",
        clientSecret: "test-secret",
        mapProfileToUser: async (profile: { email?: string; auth_time?: unknown }) => {
          await policy.checkGoogleProfile((await auth.$context).internalAdapter as never, profile);
          return {};
        },
      },
    },
    databaseHooks: { session: { create: { before: (s, ctx) => policy.sessionCreateBefore(s, ctx as never) } } },
    hooks: { before: policy.beforeHook, after: createAuthMiddleware(async (ctx) => policy.afterHandler(ctx)) },
  });
  return { auth, db };
}

async function verifiedUser(auth: ReturnType<typeof makeAuth>["auth"], db: Record<string, Row[]>, email = "laura@example.test") {
  await auth.api.signUpEmail({ body: { email, password: "password-123", name: "Laura Gómez" } });
  const u = db.user.find((x) => x.email === email)!;
  u.emailVerified = true;
  return u;
}

// https base URL → Better Auth uses the __Secure- prefix.
const cookieOf = (res: Response, name = "better-auth.session_token") =>
  res.headers.getSetCookie().filter((c) => c.startsWith(`${name}=`) || c.startsWith(`__Secure-${name}=`)).pop() ?? null;
const cookiePair = (setCookie: string) => setCookie.split(";")[0];

async function signIn(auth: ReturnType<typeof makeAuth>["auth"], email: string, rememberMe?: boolean) {
  const res = await auth.handler(
    new Request(`${BASE}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({ email, password: "password-123", ...(rememberMe === undefined ? {} : { rememberMe }) }),
    }),
  );
  assert.equal(res.status, 200, await res.clone().text());
  const set = cookieOf(res)!;
  return { res, set, cookie: cookiePair(set) };
}

async function sessionFor(auth: ReturnType<typeof makeAuth>["auth"], cookie: string) {
  return auth.api.getSession({ headers: new Headers({ cookie }) });
}

test("password sign-in WITHOUT «Mantener sesión»: 12 h cap, 2 h idle, browser-session cookie", async () => {
  const { auth, db } = makeAuth();
  await verifiedUser(auth, db);
  const { set, cookie } = await signIn(auth, "laura@example.test", false);
  assert.ok(!/Max-Age/i.test(set), "no Max-Age: the cookie ends with the browser");
  const s = db.session[0]!;
  assert.equal(s.persistent, false);
  assert.equal((s.absoluteExpiresAt as Date).getTime(), T0 + 12 * HOUR_MS);
  assert.equal((s.expiresAt as Date).getTime(), T0 + 2 * HOUR_MS);
  assert.equal(s.authMethod, "password");

  mock.timers.setTime(T0 + 2 * HOUR_MS - MINUTE_MS);
  assert.ok(await sessionFor(auth, cookie), "still valid 1 minute before the idle deadline");
  mock.timers.setTime(T0 + 2 * HOUR_MS + 1);
  assert.equal(await sessionFor(auth, cookie), null, "Better Auth itself refuses it after 2 h idle");
  assert.equal(db.session.length, 0, "and deletes the row");
});

test("password sign-in WITH «Mantener sesión»: 30 days, fixed, cookie Max-Age 30 days", async () => {
  const { auth, db } = makeAuth();
  await verifiedUser(auth, db);
  const { set, cookie } = await signIn(auth, "laura@example.test", true);
  assert.match(set, new RegExp(`Max-Age=${30 * 24 * 3600}`));
  const s = db.session[0]!;
  assert.equal(s.persistent, true);
  assert.equal((s.expiresAt as Date).getTime(), T0 + 30 * DAY_MS);
  // Using it for 29 days does not move the end.
  for (let d = 1; d < 30; d++) {
    mock.timers.setTime(T0 + d * DAY_MS);
    assert.ok(await sessionFor(auth, cookie));
  }
  assert.equal((db.session[0]!.expiresAt as Date).getTime(), T0 + 30 * DAY_MS, "reads never extend it");
  mock.timers.setTime(T0 + 30 * DAY_MS + 1);
  assert.equal(await sessionFor(auth, cookie), null);
});

test("a business policy that forbids persistence wins over the checkbox (server-side)", async () => {
  const { auth, db } = makeAuth({ allowPersistent: false });
  await verifiedUser(auth, db);
  await signIn(auth, "laura@example.test", true);
  assert.equal(db.session[0]!.persistent, false);
  assert.equal((db.session[0]!.absoluteExpiresAt as Date).getTime(), T0 + 12 * HOUR_MS);
});

test("polling / page reads never count as activity: 2 h of reads still ends the session", async () => {
  const { auth, db } = makeAuth();
  await verifiedUser(auth, db);
  const { cookie } = await signIn(auth, "laura@example.test", false);
  for (let m = 1; m < 120; m += 5) {
    mock.timers.setTime(T0 + m * MINUTE_MS);
    assert.ok(await sessionFor(auth, cookie), `poll at minute ${m}`);
  }
  assert.equal((db.session[0]!.expiresAt as Date).getTime(), T0 + 2 * HOUR_MS, "deadline untouched by reads");
  mock.timers.setTime(T0 + 2 * HOUR_MS + 1);
  assert.equal(await sessionFor(auth, cookie), null);
});

test("real activity restarts the 2 h but never passes the 12 h absolute end", async () => {
  const { auth, db } = makeAuth();
  await verifiedUser(auth, db);
  const { cookie } = await signIn(auth, "laura@example.test", false);
  const ctx = await auth.$context;
  // «Seguir trabajando» / a click every 100 minutes for 13 hours.
  for (let m = 100; m <= 13 * 60; m += 100) {
    mock.timers.setTime(T0 + m * MINUTE_MS);
    const row = db.session[0];
    if (!row) break;
    const next = onActivity(
      { persistent: false, absoluteExpiresAt: row.absoluteExpiresAt as Date, expiresAt: row.expiresAt as Date },
      new Date(),
    );
    if (next) await ctx.internalAdapter.updateSession(row.token as string, next);
    if (Date.now() < T0 + 12 * HOUR_MS) assert.ok(await sessionFor(auth, cookie), `alive at minute ${m}`);
  }
  mock.timers.setTime(T0 + 12 * HOUR_MS - 1);
  assert.ok(await sessionFor(auth, cookie), "alive right before 12 h");
  mock.timers.setTime(T0 + 12 * HOUR_MS + 1);
  assert.equal(await sessionFor(auth, cookie), null, "ends at 12 h no matter the activity");
});

test("Better Auth's list/revoke endpoints are closed over HTTP (they skip re-authentication)", async () => {
  const { auth, db } = makeAuth();
  await verifiedUser(auth, db);
  const { cookie } = await signIn(auth, "laura@example.test", true);
  await signIn(auth, "laura@example.test", true);
  for (const path of DISABLED_SESSION_PATHS) {
    const res = await auth.handler(
      new Request(`${BASE}/api/auth${path}`, {
        method: path === "/list-sessions" ? "GET" : "POST",
        headers: { cookie, origin: BASE, "content-type": "application/json" },
        body: path === "/list-sessions" ? undefined : JSON.stringify({ token: db.session[1]!.token }),
      }),
    );
    assert.equal(res.status, 404, path);
  }
  assert.equal(db.session.length, 2, "nothing was revoked");
});

test("the policy columns cannot be written by a client (input:false) and the photo cannot be set via /update-user", async () => {
  const { auth, db } = makeAuth();
  await verifiedUser(auth, db);
  const { cookie } = await signIn(auth, "laura@example.test", false);
  const res = await auth.handler(
    new Request(`${BASE}/api/auth/update-user`, {
      method: "POST",
      headers: { cookie, origin: BASE, "content-type": "application/json" },
      body: JSON.stringify({ image: "https://tracker.example/pixel.png" }),
    }),
  );
  assert.equal(res.status, 400);
  assert.equal(db.user[0]!.image ?? null, null);
  // Policy fields smuggled into the sign-in body are ignored (input:false + the hook).
  await auth.api.signInEmail({
    body: { email: "laura@example.test", password: "password-123", persistent: true, absoluteExpiresAt: new Date(T0 + 1e12) } as never,
  });
  const last = db.session[db.session.length - 1]!;
  assert.equal(last.persistent, false, "persistent cannot be set from the body");
  assert.equal((last.absoluteExpiresAt as Date).getTime(), T0 + 12 * HOUR_MS, "the body cannot move the end");
});

test("rememberMe over HTTP: ONLY an explicit boolean true gives 30 days — missing, false, \"true\", 1 all mean false", async () => {
  const { auth, db } = makeAuth();
  await verifiedUser(auth, db);
  const cases: { label: string; body: Record<string, unknown>; persistent: boolean }[] = [
    { label: "true", body: { rememberMe: true }, persistent: true },
    { label: "false", body: { rememberMe: false }, persistent: false },
    { label: "missing", body: {}, persistent: false },
    { label: "string true", body: { rememberMe: "true" }, persistent: false },
    { label: "number 1", body: { rememberMe: 1 }, persistent: false },
    { label: "null", body: { rememberMe: null }, persistent: false },
  ];
  for (const c of cases) {
    const before = db.session.length;
    const res = await auth.handler(
      new Request(`${BASE}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE },
        body: JSON.stringify({ email: "laura@example.test", password: "password-123", ...c.body }),
      }),
    );
    if (!c.persistent && res.status !== 200) {
      // A non-boolean may also simply be refused by validation — never a 30-day session.
      assert.equal(db.session.length, before, `${c.label}: refused, no session`);
      continue;
    }
    assert.equal(res.status, 200, `${c.label}: ${await res.clone().text()}`);
    const row = db.session[db.session.length - 1]!;
    const cookie = cookieOf(res)!;
    assert.equal(row.persistent, c.persistent, `${c.label}: persistent`);
    if (c.persistent) {
      assert.equal((row.expiresAt as Date).getTime(), T0 + 30 * DAY_MS, `${c.label}: 30 days`);
      assert.match(cookie, /Max-Age=2592000/, `${c.label}: 30-day cookie`);
    } else {
      assert.equal((row.absoluteExpiresAt as Date).getTime(), T0 + 12 * HOUR_MS, `${c.label}: 12 h`);
      assert.ok(!/Max-Age=[1-9]/.test(cookie), `${c.label}: browser-session cookie, got ${cookie}`);
    }
  }
});

test("server-side auth.api.signInEmail without rememberMe is not persistent either", async () => {
  const { auth, db } = makeAuth();
  await verifiedUser(auth, db);
  await auth.api.signInEmail({ body: { email: "laura@example.test", password: "password-123" } });
  assert.equal(db.session[db.session.length - 1]!.persistent, false);
});

// ---------------------------------------------------------------------------------------
// Google, end to end through Better Auth's real OAuth handlers. Only Google's TOKEN endpoint
// is answered locally (an unsigned id_token, which Better Auth decodes for the profile).

function idToken(claims: Record<string, unknown>) {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256", kid: "test" })}.${b64({ iss: "https://accounts.google.com", aud: "test-client", ...claims })}.sig`;
}

function stubGoogle(claims: () => Record<string, unknown>) {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      return new Response(
        JSON.stringify({ access_token: "at", token_type: "Bearer", expires_in: 3600, id_token: idToken(claims()) }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return real(input, init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

async function googleFlow(
  auth: ReturnType<typeof makeAuth>["auth"],
  opts: { additionalData?: Record<string, unknown>; cookie?: string; callbackURL?: string } = {},
) {
  const start = await auth.handler(
    new Request(`${BASE}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE, ...(opts.cookie ? { cookie: opts.cookie } : {}) },
      body: JSON.stringify({
        provider: "google",
        callbackURL: opts.callbackURL ?? "/negocios",
        errorCallbackURL: "/login",
        additionalData: opts.additionalData,
      }),
    }),
  );
  assert.equal(start.status, 200, await start.clone().text());
  const { url } = (await start.json()) as { url: string };
  const authorize = new URL(url);
  const state = authorize.searchParams.get("state")!;
  const stateCookies = start.headers.getSetCookie().map(cookiePair);
  const cb = await auth.handler(
    new Request(`${BASE}/api/auth/callback/google?code=test-code&state=${encodeURIComponent(state)}`, {
      method: "GET",
      headers: { cookie: [...stateCookies, ...(opts.cookie ? [opts.cookie] : [])].join("; ") },
    }),
  );
  return { authorize, cb, location: cb.headers.get("location") ?? "", session: cookieOf(cb) };
}

test("Google WITH «Mantener sesión»: the choice survives the round-trip (30 days)", async () => {
  const { auth, db } = makeAuth();
  const restore = stubGoogle(() => ({ sub: "g-1", email: "valentina@example.test", email_verified: true, name: "Valentina Ríos" }));
  try {
    const { cb, session, location } = await googleFlow(auth, { additionalData: { [KEEP_SESSION_STATE_KEY]: true } });
    assert.equal(cb.status, 302, location);
    assert.ok(session);
    const s = db.session[0]!;
    assert.equal(s.persistent, true);
    assert.equal(s.authMethod, "google");
    assert.equal((s.expiresAt as Date).getTime(), T0 + 30 * DAY_MS);
    assert.match(session!, /Max-Age=2592000/);
  } finally {
    restore();
  }
});

test("Google WITHOUT «Mantener sesión»: 12 h / 2 h and a browser-session cookie, same as password", async () => {
  const { auth, db } = makeAuth();
  const restore = stubGoogle(() => ({ sub: "g-1", email: "valentina@example.test", email_verified: true, name: "Valentina Ríos" }));
  try {
    const { session } = await googleFlow(auth);
    const s = db.session[0]!;
    assert.equal(s.persistent, false);
    assert.equal((s.expiresAt as Date).getTime(), T0 + 2 * HOUR_MS);
    assert.equal((s.absoluteExpiresAt as Date).getTime(), T0 + 12 * HOUR_MS);
    const last = session!;
    assert.ok(!/Max-Age=[1-9]/.test(last), `browser-session cookie, got ${last}`);
  } finally {
    restore();
  }
});

async function googleUserWithSession(auth: ReturnType<typeof makeAuth>["auth"], db: Record<string, Row[]>, keep = false) {
  const { session } = await googleFlow(auth, keep ? { additionalData: { [KEEP_SESSION_STATE_KEY]: true } } : {});
  const cookie = cookiePair(session!);
  return { cookie, row: db.session[0]! };
}

async function issueChallenge(auth: ReturnType<typeof makeAuth>["auth"], token: string, email: string, ttl = 10 * MINUTE_MS) {
  const nonce = `n-${Math.random().toString(36).slice(2)}`;
  await (await auth.$context).internalAdapter.createVerificationValue({
    identifier: reauthIdentifier(nonce),
    value: JSON.stringify({ token, email }),
    expiresAt: new Date(Date.now() + ttl),
  });
  return nonce;
}

test("Google re-authentication: replaces the session, keeps its absolute end, sets reauthenticatedAt; URL forces the account chooser", async () => {
  const { auth, db } = makeAuth();
  let claims: Record<string, unknown> = { sub: "g-1", email: "valentina@example.test", email_verified: true, name: "V" };
  const restore = stubGoogle(() => claims);
  try {
    const { cookie, row } = await googleUserWithSession(auth, db, true);
    const oldToken = row.token as string;
    mock.timers.setTime(T0 + 3 * DAY_MS);
    const nonce = await issueChallenge(auth, oldToken, "valentina@example.test");
    claims = { ...claims, auth_time: Math.floor(Date.now() / 1000) };
    const { authorize, session } = await googleFlow(auth, { cookie, additionalData: { [REAUTH_STATE_KEY]: nonce } });
    assert.equal(authorize.searchParams.get("prompt"), "select_account");
    assert.deepEqual(JSON.parse(authorize.searchParams.get("claims") ?? "{}"), { id_token: { auth_time: { essential: true } } }, "asks Google for auth_time");
    assert.equal(authorize.searchParams.get("max_age"), null, "Google does not support max_age; not sent");
    assert.ok(session, "a new session cookie");
    assert.equal(db.session.length, 1, "the old session was replaced, not duplicated");
    const s = db.session[0]!;
    assert.notEqual(s.token, oldToken);
    assert.equal(s.persistent, true);
    assert.equal((s.absoluteExpiresAt as Date).getTime(), T0 + 30 * DAY_MS, "the 30 days still count from the ORIGINAL sign-in");
    assert.equal((s.reauthenticatedAt as Date).getTime(), T0 + 3 * DAY_MS, "the real Google auth moment (auth_time)");
    // The nonce is single-use.
    const again = await googleFlow(auth, { cookie: cookiePair(session!), additionalData: { [REAUTH_STATE_KEY]: nonce } });
    assert.match(again.location, /error=/, "a replayed nonce is refused");
  } finally {
    restore();
  }
});

test("Google re-authentication WITHOUT proof is refused: auth_time missing, malformed, stale or future (old session untouched)", async () => {
  const { auth, db } = makeAuth();
  let claims: Record<string, unknown> = { sub: "g-1", email: "valentina@example.test", email_verified: true, name: "V" };
  const restore = stubGoogle(() => claims);
  try {
    const { cookie, row } = await googleUserWithSession(auth, db);
    const nowSec = () => Math.floor(Date.now() / 1000);
    const variants: [string, unknown][] = [
      ["missing", undefined],
      ["string", String(nowSec())],
      ["null", null],
      ["stale (11 min)", nowSec() - 11 * 60],
      ["future (+5 min)", nowSec() + 5 * 60],
      ["zero", 0],
    ];
    for (const [label, authTime] of variants) {
      const nonce = await issueChallenge(auth, row.token as string, "valentina@example.test");
      claims = { sub: "g-1", email: "valentina@example.test", email_verified: true, name: "V", ...(authTime === undefined ? {} : { auth_time: authTime }) };
      const r = await googleFlow(auth, { cookie, additionalData: { [REAUTH_STATE_KEY]: nonce } });
      assert.match(r.location, /error=reauth_not_recent/, label);
      assert.equal(db.session.length, 1, `${label}: no new session`);
      assert.equal(db.session[0]!.token, row.token, `${label}: old session intact`);
      assert.equal(db.session[0]!.reauthenticatedAt ?? null, null, `${label}: still not recently authenticated`);
    }
  } finally {
    restore();
  }
});

test("a NORMAL Google sign-in never counts as recent authentication (even with a fresh auth_time) — a password sign-in does", async () => {
  const { auth, db } = makeAuth();
  const restore = stubGoogle(() => ({ sub: "g-1", email: "valentina@example.test", email_verified: true, name: "V", auth_time: Math.floor(Date.now() / 1000) }));
  try {
    await googleFlow(auth);
    assert.equal(db.session[0]!.reauthenticatedAt ?? null, null, "Google login: closing other sessions still needs a re-authentication");
    await verifiedUser(auth, db, "pass@example.test");
    await signIn(auth, "pass@example.test", false);
    const pw = db.session[db.session.length - 1]!;
    assert.equal((pw.reauthenticatedAt as Date).getTime(), T0, "password login: the password was just proven");
  } finally {
    restore();
  }
});

test("Google re-authentication with another Google account, or an expired challenge, is refused", async () => {
  const { auth, db } = makeAuth();
  let claims: Record<string, unknown> = { sub: "g-1", email: "valentina@example.test", email_verified: true, name: "V" };
  const restore = stubGoogle(() => claims);
  try {
    const { cookie, row } = await googleUserWithSession(auth, db);
    // a different Google account (with a fresh auth_time) → aborted BEFORE any user is created
    let nonce = await issueChallenge(auth, row.token as string, "valentina@example.test");
    claims = { sub: "g-2", email: "otra@example.test", email_verified: true, name: "Otra", auth_time: Math.floor(Date.now() / 1000) };
    const usersBefore = db.user.length;
    let r = await googleFlow(auth, { cookie, additionalData: { [REAUTH_STATE_KEY]: nonce } });
    assert.match(r.location, /error=/);
    assert.equal(db.user.length, usersBefore, "no stray user");

    // expired challenge (Google's proof itself is fresh)
    nonce = await issueChallenge(auth, row.token as string, "valentina@example.test", MINUTE_MS);
    mock.timers.setTime(Date.now() + 2 * MINUTE_MS);
    claims = { sub: "g-1", email: "valentina@example.test", email_verified: true, name: "V", auth_time: Math.floor(Date.now() / 1000) };
    r = await googleFlow(auth, { cookie, additionalData: { [REAUTH_STATE_KEY]: nonce } });
    assert.match(r.location, /error=reauth_failed/);
    assert.equal(db.session[0]!.token, row.token, "old session intact");
    assert.equal(db.session[0]!.reauthenticatedAt ?? null, null);
  } finally {
    restore();
  }
});

test("a challenge issued for ANOTHER user's session cannot re-authenticate this one", async () => {
  const { auth, db } = makeAuth();
  let claims: Record<string, unknown> = { sub: "g-1", email: "valentina@example.test", email_verified: true, name: "V" };
  const restore = stubGoogle(() => claims);
  try {
    const victim = await googleUserWithSession(auth, db);
    claims = { sub: "g-9", email: "mallory@example.test", email_verified: true, name: "M", auth_time: Math.floor(Date.now() / 1000) };
    const attacker = await googleFlow(auth);
    const attackerCookie = cookiePair(attacker.session!);
    // The attacker somehow learns a nonce bound to the victim's session + email.
    const nonce = await issueChallenge(auth, victim.row.token as string, "valentina@example.test");
    const r = await googleFlow(auth, { cookie: attackerCookie, additionalData: { [REAUTH_STATE_KEY]: nonce } });
    assert.match(r.location, /error=/, "mallory's Google account ≠ the challenge's email");
    assert.ok(db.session.some((s) => s.token === victim.row.token), "victim session untouched");
  } finally {
    restore();
  }
});

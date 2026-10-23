/**
 * FIX-2/FIX-3 regression tests, against a REAL Better Auth 1.6.19 instance on the official
 * in-memory adapter — no Postgres, no real users. The instance uses the SAME policy + options
 * production uses (requireEmailVerification on, the account-linking policy, the verification/reset
 * builders); only the transport (captured) and the database differ.
 *
 * Covered: an unverified email/password sign-in is refused with a STABLE code (not a generic
 * failure); the Google TAKEOVER of an UNVERIFIED local account (verified + credential/sessions
 * killed + Google linked); a VERIFIED local account is left UNTOUCHED (still refuses); an
 * attacker's unverified squat is reclaimed by the Google-verified owner; and the client error map.
 *
 * Run from the repo root:  npm run test:auth
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";

import {
  ACCOUNT_LINKING_POLICY,
  applyGoogleAccountTakeover,
  buildEmailVerification,
  buildPasswordReset,
  type TakeoverContext,
} from "../lib/auth-verification";
import { EMAIL_NOT_VERIFIED_NOTICE, mapClientAuthError } from "../lib/auth-errors";

type Acct = { id: string; providerId: string; accountId: string; userId: string };
type Usr = { id: string; email: string; emailVerified: boolean };

function makeTestAuth() {
  const db: Record<string, unknown[]> = { user: [], session: [], account: [], verification: [] };
  const sent: { to: string; subject: string; html: string }[] = [];
  const send = async (msg: { to: string; subject: string; html: string }) => {
    sent.push(msg);
    return { ok: true as const, id: "test" };
  };
  const auth = betterAuth({
    database: memoryAdapter(db),
    baseURL: "https://app.test",
    secret: "test-secret-test-secret-test-secret",
    // Match production: an unverified password account cannot sign in.
    emailAndPassword: { enabled: true, requireEmailVerification: true, ...buildPasswordReset(send) },
    emailVerification: buildEmailVerification(send),
    account: { accountLinking: { ...ACCOUNT_LINKING_POLICY } },
  });
  return { auth, db, sent };
}

const ctxOf = async (auth: ReturnType<typeof makeTestAuth>["auth"]) =>
  (await auth.$context) as unknown as TakeoverContext;
const accounts = (db: Record<string, unknown[]>) => db.account as Acct[];

test("unverified email/password sign-in is refused with EMAIL_NOT_VERIFIED (a stable code), not a generic error", async () => {
  const { auth } = makeTestAuth();
  await auth.api.signUpEmail({ body: { email: "unv@example.com", password: "password-123", name: "U" } });
  await assert.rejects(
    auth.api.signInEmail({ body: { email: "unv@example.com", password: "password-123" } }),
    (err: { body?: { code?: string }; status?: number }) => err.body?.code === "EMAIL_NOT_VERIFIED",
    "the client receives the EMAIL_NOT_VERIFIED code the login form special-cases",
  );
});

test("Google takeover: an UNVERIFIED local account → verified, credential + sessions killed, Google linked", async () => {
  const { auth, db } = makeTestAuth();
  const EMAIL = "invited@example.com";
  await auth.api.signUpEmail({ body: { email: EMAIL, password: "password-123", name: "Invited" } });
  const user = db.user[0] as Usr;
  assert.equal(user.emailVerified, false);
  assert.ok(accounts(db).some((a) => a.providerId === "credential"), "password credential exists");
  // Seed a live session so the revoke is observable deterministically.
  db.session.push({ id: "s1", userId: user.id, token: "t1", expiresAt: new Date(Date.now() + 1e9), createdAt: new Date(), updatedAt: new Date() });

  const out = await applyGoogleAccountTakeover(await ctxOf(auth), { email: EMAIL, email_verified: true, sub: "google-sub-1" });
  assert.deepEqual(out, {}, "mapProfileToUser returns no overrides");

  assert.equal((db.user[0] as Usr).emailVerified, true, "email marked verified");
  assert.ok(!accounts(db).some((a) => a.providerId === "credential"), "unverified password credential invalidated");
  const google = accounts(db).find((a) => a.providerId === "google");
  assert.ok(google, "Google account linked");
  assert.equal(google!.accountId, "google-sub-1", "linked with the Google sub as accountId");
  assert.equal(google!.userId, user.id, "linked to the SAME user row");
  assert.equal(db.session.length, 0, "pre-existing sessions revoked");
});

test("Google does NOT take over a VERIFIED local account (today's rule stands: refuse → connect from settings)", async () => {
  const { auth, db, sent } = makeTestAuth();
  const EMAIL = "verified@example.com";
  await auth.api.signUpEmail({ body: { email: EMAIL, password: "password-123", name: "V" } });
  const href = /href="([^"]+)"/.exec(sent.at(-1)!.html)![1]!.replace(/&amp;/g, "&");
  await auth.api.verifyEmail({ query: { token: new URL(href).searchParams.get("token")! } });
  assert.equal((db.user[0] as Usr).emailVerified, true);
  const credsBefore = accounts(db).filter((a) => a.providerId === "credential").length;

  const out = await applyGoogleAccountTakeover(await ctxOf(auth), { email: EMAIL, email_verified: true, sub: "google-sub-2" });
  assert.deepEqual(out, {});
  assert.ok(!accounts(db).some((a) => a.providerId === "google"), "no implicit Google link for a verified account");
  assert.equal(accounts(db).filter((a) => a.providerId === "credential").length, credsBefore, "credential untouched");
});

test("takeover is inert without a Google-verified email (ownership unproven)", async () => {
  const { auth, db } = makeTestAuth();
  const EMAIL = "unverified2@example.com";
  await auth.api.signUpEmail({ body: { email: EMAIL, password: "password-123", name: "U2" } });
  const out = await applyGoogleAccountTakeover(await ctxOf(auth), { email: EMAIL, email_verified: false, sub: "google-sub-x" });
  assert.deepEqual(out, {});
  assert.equal((db.user[0] as Usr).emailVerified, false, "no takeover when Google didn't verify the email");
  assert.ok(!accounts(db).some((a) => a.providerId === "google"));
  assert.ok(accounts(db).some((a) => a.providerId === "credential"), "credential preserved");
});

test("pre-hijack via Google: the Google-verified owner reclaims an attacker's UNVERIFIED squat", async () => {
  const { auth, db } = makeTestAuth();
  const EMAIL = "victim@example.com";
  await auth.api.signUpEmail({ body: { email: EMAIL, password: "attacker-pass-1", name: "impostor" } });
  const user = db.user[0] as Usr;
  // The attacker somehow holds a live session (e.g. a legacy one) — the takeover must kill it.
  db.session.push({ id: "atk", userId: user.id, token: "atk-tok", expiresAt: new Date(Date.now() + 1e9), createdAt: new Date(), updatedAt: new Date() });

  await applyGoogleAccountTakeover(await ctxOf(auth), { email: EMAIL, email_verified: true, sub: "google-sub-3" });

  assert.equal(db.session.length, 0, "attacker session revoked");
  await assert.rejects(
    auth.api.signInEmail({ body: { email: EMAIL, password: "attacker-pass-1" } }),
    (err: { body?: { code?: string } }) => err.body?.code === "INVALID_EMAIL_OR_PASSWORD",
    "attacker password no longer works (credential invalidated)",
  );
  assert.ok(accounts(db).some((a) => a.providerId === "google"), "Google (the real owner) is now linked");
});

test("client error map: EMAIL_NOT_VERIFIED is specific (not the generic fallback); invalid-credentials steers Google-only users", () => {
  assert.equal(mapClientAuthError("EMAIL_NOT_VERIFIED", "Log in failed. Please try again."), EMAIL_NOT_VERIFIED_NOTICE);
  assert.notEqual(mapClientAuthError("EMAIL_NOT_VERIFIED", "Log in failed. Please try again."), "Log in failed. Please try again.");
  assert.match(mapClientAuthError("INVALID_EMAIL_OR_PASSWORD"), /Google/, "hints at Continue with Google for a Google-only account");
});

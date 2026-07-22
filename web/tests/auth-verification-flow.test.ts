/**
 * Integration tests for the email-verification plumbing (verification gates
 * IMPLICIT Google linking and is offered to fresh signups — it is NOT the
 * account-recovery mechanism; see auth-recovery-flow.test.ts for that).
 * Runs against a REAL Better Auth 1.6.19 instance on the official in-memory
 * adapter — no Postgres, no real users touched. The instance uses the same
 * emailVerification options and account-linking policy as production (built
 * by the same functions web/lib/auth.ts uses); only the transport (captured
 * in-memory instead of Resend) and the database differ.
 *
 * Run from the repo root:  npm run test:auth
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";

import { ACCOUNT_LINKING_POLICY, buildEmailVerification } from "../lib/auth-verification";

type SentEmail = { to: string; subject: string; html: string };

function makeTestAuth() {
  const db: Record<string, unknown[]> = { user: [], session: [], account: [], verification: [] };
  const sent: SentEmail[] = [];
  // Stand-in for the production tenant-provisioning hook: counts how many
  // times Better Auth reports a NEW user row. Verification must never bump it.
  const tenantProvisions = { count: 0 };

  const auth = betterAuth({
    database: memoryAdapter(db),
    baseURL: "https://app.test",
    secret: "test-secret-test-secret-test-secret",
    emailAndPassword: { enabled: true },
    emailVerification: buildEmailVerification(async (msg) => {
      sent.push(msg);
      return { ok: true, id: "test" };
    }),
    account: { accountLinking: { ...ACCOUNT_LINKING_POLICY } },
    databaseHooks: {
      user: {
        create: {
          after: async () => {
            tenantProvisions.count += 1;
          },
        },
      },
    },
  });

  return { auth, db, sent, tenantProvisions };
}

function tokenFromUrl(url: string): string {
  const token = new URL(url).searchParams.get("token");
  assert.ok(token, "verification URL must carry a token");
  return token;
}

test("verification flow: request link → verify → emailVerified, same user, no new tenant", async () => {
  const { auth, db, sent, tenantProvisions } = makeTestAuth();

  // Email/password signup (sendOnSignUp also fires here — an OFFER of
  // verification, not a guarantee: nothing blocks an unverified sign-in).
  await auth.api.signUpEmail({
    body: { email: "legacy@example.com", password: "password-123", name: "Legacy" },
  });
  assert.equal(db.user.length, 1);
  const created = db.user[0] as { id: string; emailVerified: boolean };
  assert.equal(created.emailVerified, false);
  assert.equal(tenantProvisions.count, 1, "tenant provisioning fires once at signup");
  assert.equal(sent.length, 1, "sendOnSignUp delivers the first verification email");

  // A verification email can also be requested unauthenticated (the endpoint
  // stays generic either way).
  const res = await auth.api.sendVerificationEmail({
    body: { email: "legacy@example.com", callbackURL: "/login?verified=1" },
  });
  assert.deepEqual(res, { status: true }, "response carries nothing but a generic status");
  assert.equal(sent.length, 2);
  const mail = sent[1]!;
  assert.equal(mail.to, "legacy@example.com");
  assert.ok(
    mail.html.includes("https://app.test/api/auth/verify-email?token="),
    "link targets Better Auth's own verify endpoint under BETTER_AUTH_URL",
  );

  // Clicking the link (Better Auth validates its own token).
  const linkUrl = /href="([^"]+)"/.exec(mail.html)?.[1]?.replace(/&amp;/g, "&");
  assert.ok(linkUrl);
  const verifyRes = await auth.api.verifyEmail({ query: { token: tokenFromUrl(linkUrl) } });
  assert.equal(verifyRes?.status, true);

  // Same row flipped — no new user, no second provisioning, no auto session.
  assert.equal(db.user.length, 1);
  const after = db.user[0] as { id: string; emailVerified: boolean };
  assert.equal(after.id, created.id, "userId is preserved");
  assert.equal(after.emailVerified, true);
  assert.equal(tenantProvisions.count, 1, "verification must NOT provision another tenant");
});

test("anti-enumeration: unknown email gets the identical generic response and no email", async () => {
  const { auth, sent } = makeTestAuth();
  const res = await auth.api.sendVerificationEmail({
    body: { email: "nobody@example.com", callbackURL: "/login?verified=1" },
  });
  assert.deepEqual(res, { status: true });
  assert.equal(sent.length, 0, "no email is sent for a nonexistent account");
});

test("already-verified email also gets the generic response with no email", async () => {
  const { auth, sent } = makeTestAuth();
  await auth.api.signUpEmail({
    body: { email: "done@example.com", password: "password-123", name: "Done" },
  });
  const mail = sent.at(-1)!;
  const linkUrl = /href="([^"]+)"/.exec(mail.html)![1]!.replace(/&amp;/g, "&");
  await auth.api.verifyEmail({ query: { token: tokenFromUrl(linkUrl) } });

  const before = sent.length;
  const res = await auth.api.sendVerificationEmail({
    body: { email: "done@example.com" },
  });
  assert.deepEqual(res, { status: true });
  assert.equal(sent.length, before, "no email for an already-verified account");
});

test("a garbage token is rejected by Better Auth's own validation", async () => {
  const { auth } = makeTestAuth();
  await assert.rejects(
    auth.api.verifyEmail({ query: { token: "not-a-real-token" } }),
    (err: { body?: { code?: string } }) => err.body?.code === "INVALID_TOKEN",
  );
});

test("verifying does not mint a session (user returns to /login and signs in)", async () => {
  const { auth, db, sent } = makeTestAuth();
  await auth.api.signUpEmail({
    body: { email: "nosession@example.com", password: "password-123", name: "N" },
  });
  const sessionsAfterSignup = db.session.length;
  const mail = sent.at(-1)!;
  const linkUrl = /href="([^"]+)"/.exec(mail.html)![1]!.replace(/&amp;/g, "&");
  await auth.api.verifyEmail({ query: { token: tokenFromUrl(linkUrl) } });
  assert.equal(db.session.length, sessionsAfterSignup, "no session created by the link");
});

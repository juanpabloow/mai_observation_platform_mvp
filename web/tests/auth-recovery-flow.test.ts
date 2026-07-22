/**
 * Regression tests for the account pre-hijacking scenario, against a REAL
 * Better Auth 1.6.19 instance on the official in-memory adapter — no
 * Postgres, no real users touched.
 *
 * Scenario under test: an ATTACKER pre-registers victim@example.com with an
 * attacker-known password and keeps a live session. The VICTIM recovers via
 * the official password-reset flow. After the reset: the attacker's password
 * and session must be dead, the user row (id → tenant/memberships) must be
 * unchanged, and Google linking must only be possible from an authenticated
 * session.
 *
 * Run from the repo root:  npm run test:auth
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";

import {
  ACCOUNT_LINKING_POLICY,
  buildEmailVerification,
  buildPasswordReset,
} from "../lib/auth-verification";

type SentEmail = { to: string; subject: string; html: string };
type GoogleUser = { id: string; name: string; email: string; emailVerified: boolean };

function makeTestAuth(opts: { googleUser?: GoogleUser } = {}) {
  const db: Record<string, unknown[]> = { user: [], session: [], account: [], verification: [] };
  const sent: SentEmail[] = [];
  // Stand-in for the production tenant-provisioning hook: counts how many
  // times Better Auth reports a NEW user row. Recovery must never bump it.
  const tenantProvisions = { count: 0 };
  const send = async (msg: SentEmail) => {
    sent.push(msg);
    return { ok: true as const, id: "test" };
  };

  const auth = betterAuth({
    database: memoryAdapter(db),
    baseURL: "https://app.test",
    secret: "test-secret-test-secret-test-secret",
    emailAndPassword: { enabled: true, ...buildPasswordReset(send) },
    emailVerification: buildEmailVerification(send),
    account: { accountLinking: { ...ACCOUNT_LINKING_POLICY } },
    // Dummy creds: enough to register the provider and build authorization
    // URLs. The optional getUserInfo override (an official provider option)
    // lets the implicit-linking regression run the real OAuth callback
    // without contacting Google.
    socialProviders: {
      google: {
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
        ...(opts.googleUser
          ? { getUserInfo: async () => ({ user: opts.googleUser!, data: {} }) }
          : {}),
      },
    },
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

function cookieFrom(headers: Headers): Headers {
  const setCookie = headers.get("set-cookie");
  assert.ok(setCookie, "expected a session cookie");
  return new Headers({ cookie: setCookie.split(";")[0]! });
}

function resetTokenFrom(mail: SentEmail): string {
  const href = /href="([^"]+)"/.exec(mail.html)?.[1]?.replace(/&amp;/g, "&");
  assert.ok(href, "reset email must contain a link");
  const url = new URL(href);
  // Link shape: <baseURL>/api/auth/reset-password/<token>?callbackURL=…
  const token = url.pathname.split("/").at(-1);
  assert.ok(token && token !== "reset-password", "reset link must carry the token in its path");
  return token;
}

test("pre-hijack regression: password reset kills the attacker's password and sessions, preserves the user", async () => {
  const { auth, db, sent, tenantProvisions } = makeTestAuth();
  const EMAIL = "victim@example.com";
  const ATTACKER_PASSWORD = "attacker-pass-1";
  const VICTIM_PASSWORD = "victim-new-pass-1";

  // 1. Attacker pre-registers the victim's email and holds a live session.
  const attackerSignup = await auth.api.signUpEmail({
    body: { email: EMAIL, password: ATTACKER_PASSWORD, name: "impostor" },
    returnHeaders: true,
  });
  const attackerHeaders = cookieFrom(attackerSignup.headers);
  const originalUser = db.user[0] as { id: string };
  assert.equal(db.user.length, 1);
  assert.equal(tenantProvisions.count, 1);
  const attackerSession = await auth.api.getSession({ headers: attackerHeaders });
  assert.ok(attackerSession, "attacker session starts out alive");

  // 2. Victim requests a password reset (public, unauthenticated).
  const mailsBefore = sent.length;
  const reqRes = await auth.api.requestPasswordReset({
    body: { email: EMAIL, redirectTo: "/reset-password" },
  });
  assert.equal(reqRes.status, true);
  assert.equal(sent.length, mailsBefore + 1);
  const token = resetTokenFrom(sent.at(-1)!);

  // 3. Victim sets a new password with Better Auth's single-use token.
  const resetRes = await auth.api.resetPassword({
    body: { newPassword: VICTIM_PASSWORD, token },
  });
  assert.equal(resetRes.status, true);

  // 4. The attacker's password is dead.
  await assert.rejects(
    auth.api.signInEmail({ body: { email: EMAIL, password: ATTACKER_PASSWORD } }),
    (err: { body?: { code?: string } }) => err.body?.code === "INVALID_EMAIL_OR_PASSWORD",
  );

  // 5. Every pre-reset session is revoked (revokeSessionsOnPasswordReset).
  assert.equal(db.session.length, 0, "no sessions survive the reset");
  const attackerSessionAfter = await auth.api.getSession({ headers: attackerHeaders });
  assert.equal(attackerSessionAfter, null, "attacker session is invalid after the reset");

  // 6. The token is single-use.
  await assert.rejects(
    auth.api.resetPassword({ body: { newPassword: "another-pass-1", token } }),
    (err: { body?: { code?: string } }) => err.body?.code === "INVALID_TOKEN",
  );

  // 7. The victim signs in with the new password — same user row, no second
  //    user, no second tenant provisioning.
  const victimSignin = await auth.api.signInEmail({
    body: { email: EMAIL, password: VICTIM_PASSWORD },
    returnHeaders: true,
  });
  const victimHeaders = cookieFrom(victimSignin.headers);
  assert.equal(db.user.length, 1, "no second user was created");
  assert.equal((db.user[0] as { id: string }).id, originalUser.id, "userId is preserved");
  assert.equal(tenantProvisions.count, 1, "memberships/tenant provisioning untouched");

  // 8. Google can NOT be linked without a session…
  await assert.rejects(
    auth.api.linkSocialAccount({
      body: { provider: "google" },
      headers: new Headers(),
    }),
    "linkSocial must require an authenticated session",
  );

  // …and CAN be initiated from the victim's authenticated session (the
  // OAuth state carries this session's userId; the callback enforces
  // same-email linking server-side).
  const linkRes = await auth.api.linkSocialAccount({
    body: { provider: "google", callbackURL: "/settings/security?linked=1" },
    headers: victimHeaders,
  });
  assert.ok(linkRes.url.startsWith("https://accounts.google.com/"), "authorization URL issued");
});

test("regression: signup → verify email → Google sign-in does NOT link implicitly", async () => {
  const EMAIL = "verified-victim@example.com";
  const googleUser: GoogleUser = {
    id: "google-sub-1",
    name: "Verified Victim",
    email: EMAIL,
    emailVerified: true,
  };
  const { auth, db, sent } = makeTestAuth({ googleUser });

  // 1. Email/password signup, then verify the email via Better Auth's link —
  //    the strongest case for the old implicit-link path: local user
  //    VERIFIED, Google email identical and verified.
  await auth.api.signUpEmail({ body: { email: EMAIL, password: "password-123", name: "V" } });
  const verifyHref = /href="([^"]+)"/.exec(sent.at(-1)!.html)![1]!.replace(/&amp;/g, "&");
  const verifyToken = new URL(verifyHref).searchParams.get("token")!;
  await auth.api.verifyEmail({ query: { token: verifyToken } });
  assert.equal((db.user[0] as { emailVerified: boolean }).emailVerified, true);
  const sessionsBefore = db.session.length;

  // 2. Unauthenticated "Continue with Google" for that same email. The
  //    response sets a state cookie the browser would carry into the
  //    callback — forward it, like a real browser.
  const start = await auth.api.signInSocial({
    body: { provider: "google", callbackURL: "/" },
    returnHeaders: true,
  });
  assert.ok(start.response.url, "sign-in must issue an authorization URL");
  const state = new URL(start.response.url!).searchParams.get("state")!;
  const browserCookies = start.headers
    .getSetCookie()
    .map((c) => c.split(";")[0]!)
    .join("; ");

  // 3. Complete the REAL OAuth callback: only the code-for-token exchange is
  //    stubbed (getUserInfo is overridden above), everything else — state
  //    validation, linking policy, error redirect — is Better Auth's own code.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    Response.json({
      access_token: "test-access-token",
      token_type: "bearer",
      expires_in: 3600,
      scope: "openid email profile",
    })) as typeof fetch;
  let redirect: string | null = null;
  try {
    await auth.api.callbackOAuth({
      params: { id: "google" },
      query: { code: "test-code", state },
      headers: new Headers({ cookie: browserCookies }),
    });
    assert.fail("the callback must end in a redirect");
  } catch (err) {
    redirect = (err as { headers?: Headers }).headers?.get("location") ?? null;
  } finally {
    globalThis.fetch = realFetch;
  }

  // 4. The sign-in was refused with account_not_linked: no google account row
  //    was attached, no session minted, no second user created.
  assert.ok(
    redirect?.includes("error=account_not_linked"),
    `expected an account_not_linked redirect, got: ${redirect}`,
  );
  const googleAccounts = (db.account as { providerId: string }[]).filter(
    (account) => account.providerId === "google",
  );
  assert.equal(googleAccounts.length, 0, "implicit linking must not attach Google");
  assert.equal(db.session.length, sessionsBefore, "no session is created by the refused sign-in");
  assert.equal(db.user.length, 1, "no second user is created");
});

test("anti-enumeration: unknown email gets the same public response and no email", async () => {
  const { auth, sent } = makeTestAuth();
  await auth.api.signUpEmail({
    body: { email: "exists@example.com", password: "password-123", name: "E" },
  });
  const mailsBefore = sent.length;

  const unknown = await auth.api.requestPasswordReset({
    body: { email: "ghost@example.com", redirectTo: "/reset-password" },
  });
  const known = await auth.api.requestPasswordReset({
    body: { email: "exists@example.com", redirectTo: "/reset-password" },
  });
  // Identical response bodies for both branches.
  assert.deepEqual(unknown, known);
  assert.equal(sent.length, mailsBefore + 1, "an email goes out only for the real account");
  // The public response never carries the token.
  assert.ok(!JSON.stringify(unknown).includes("token"));
});

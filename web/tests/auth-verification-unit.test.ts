/**
 * Unit tests for the pure auth hotfix helpers. No DB, no network.
 * Run from the repo root:  npm run test:auth
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ACCOUNT_LINKING_POLICY,
  buildEmailVerification,
  buildPasswordReset,
  resetPasswordEmailHtml,
  sanitizeSendError,
  validateBetterAuthUrl,
  verificationEmailHtml,
  RESET_PASSWORD_PATH,
  VERIFIED_LOGIN_CALLBACK,
} from "../lib/auth-verification";
import { mapAuthErrorParam, mapClientAuthError, GENERIC_RESET_NOTICE } from "../lib/auth-errors";

test("account-linking policy pins the production-safe values", () => {
  assert.equal(ACCOUNT_LINKING_POLICY.enabled, true);
  assert.equal(ACCOUNT_LINKING_POLICY.requireLocalEmailVerified, true);
  assert.equal(ACCOUNT_LINKING_POLICY.allowDifferentEmails, false);
  // Implicit linking is OFF: Google can only be connected via linkSocial
  // from an authenticated session (see the regression in
  // auth-recovery-flow.test.ts).
  assert.equal(ACCOUNT_LINKING_POLICY.disableImplicitLinking, true);
});

test("password-reset options pin the recovery-safe values (1.6.19 option names)", () => {
  const options = buildPasswordReset(async () => ({ ok: true, id: "x" }));
  assert.equal(options.revokeSessionsOnPasswordReset, true);
  assert.equal(options.resetPasswordTokenExpiresIn, 60 * 60);
  assert.equal(typeof options.sendResetPassword, "function");
});

test("emailVerification options: sendOnSignUp on, no auto session from the link", () => {
  const options = buildEmailVerification(async () => ({ ok: true, id: "x" }));
  assert.equal(options.sendOnSignUp, true);
  assert.equal(options.autoSignInAfterVerification, false);
  assert.equal(options.expiresIn, 60 * 60);
});

test("sends are awaited; a failed send never rejects (keeps generic endpoint responses)", async () => {
  // The sender resolves on a later tick — awaiting the helper must observe it
  // (i.e. the send is NOT fire-and-forget).
  let settled = false;
  const failing = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    settled = true;
    return { ok: false as const, error: "boom" };
  };
  await assert.doesNotReject(
    buildEmailVerification(failing).sendVerificationEmail({
      user: { email: "a@b.co" },
      url: "https://x/verify",
    }),
  );
  assert.equal(settled, true, "sendVerificationEmail must await the send");
  settled = false;
  await assert.doesNotReject(
    buildPasswordReset(failing).sendResetPassword({
      user: { email: "a@b.co" },
      url: "https://x/reset",
    }),
  );
  assert.equal(settled, true, "sendResetPassword must await the send");
});

test("sanitizeSendError drops Resend response bodies, keeps the category", () => {
  assert.equal(
    sanitizeSendError('Email send failed (HTTP 422): {"message":"detail from resend"}'),
    "Email send failed (HTTP 422)",
  );
  assert.equal(sanitizeSendError("Email sending is not configured."), "Email sending is not configured.");
});

test("emails embed the Better Auth URL, HTML-escaped", () => {
  const url = 'https://app.example/api/auth/verify-email?token=abc&callbackURL=%2Flogin"';
  const html = verificationEmailHtml(url);
  assert.ok(html.includes("token=abc&amp;callbackURL"));
  assert.ok(!html.includes('%2Flogin"'), "double quote must be escaped");
  assert.ok(resetPasswordEmailHtml("https://x/api/auth/reset-password/tkn").includes("reset-password/tkn"));
  assert.ok(resetPasswordEmailHtml("https://x/r").includes("signs out every existing session"));
});

test("validateBetterAuthUrl accepts a clean https URL and strips trailing slash", () => {
  assert.equal(
    validateBetterAuthUrl("https://app.up.railway.app/", { enforceProduction: true }),
    "https://app.up.railway.app",
  );
});

test("validateBetterAuthUrl rejects markdown paste everywhere", () => {
  assert.throws(() =>
    validateBetterAuthUrl("[https://app.example](https://app.example)", {
      enforceProduction: false,
    }),
  );
  assert.throws(() => validateBetterAuthUrl("`https://app.example`", { enforceProduction: false }));
  assert.throws(() => validateBetterAuthUrl("https://app example.com", { enforceProduction: false }));
  assert.throws(() => validateBetterAuthUrl("not a url", { enforceProduction: false }));
});

test("validateBetterAuthUrl enforces https + non-localhost only in deployed production", () => {
  assert.throws(() => validateBetterAuthUrl("http://app.example", { enforceProduction: true }));
  assert.throws(() => validateBetterAuthUrl("https://localhost:3000", { enforceProduction: true }));
  assert.throws(() => validateBetterAuthUrl("http://127.0.0.1:3000", { enforceProduction: true }));
  assert.throws(() => validateBetterAuthUrl(undefined, { enforceProduction: true }));
  // Local dev / local production build keep working:
  assert.equal(
    validateBetterAuthUrl("http://localhost:3000", { enforceProduction: false }),
    "http://localhost:3000",
  );
  assert.equal(
    validateBetterAuthUrl(undefined, { enforceProduction: false }),
    "http://localhost:3000",
  );
});

test("account_not_linked points to password recovery, not public verification", () => {
  const msg = mapAuthErrorParam("account_not_linked");
  assert.ok(msg && msg.includes("Forgot password"));
  assert.ok(msg.includes("Connect Google") || msg.includes("connect Google"));
});

test("redirect error codes map through the allowlist with a generic fallback", () => {
  assert.ok(mapAuthErrorParam("TOKEN_EXPIRED")?.includes("expired"));
  assert.ok(mapAuthErrorParam("INVALID_TOKEN"));
  assert.ok(mapAuthErrorParam("email_doesn't_match")?.includes("same email"));
  assert.equal(mapAuthErrorParam("SOME_NEW_CODE"), "Sign-in failed. Please try again.");
  assert.equal(mapAuthErrorParam(null), null);
});

test("client error codes map through the allowlist; raw messages are never used", () => {
  assert.equal(mapClientAuthError("PASSWORD_TOO_SHORT"), "Password must be at least 8 characters.");
  assert.ok(mapClientAuthError("LINKING_DIFFERENT_EMAILS_NOT_ALLOWED").includes("same email"));
  assert.equal(mapClientAuthError("UNMAPPED_CODE", "fallback text"), "fallback text");
  assert.equal(mapClientAuthError(undefined, "fallback text"), "fallback text");
});

test("public notices and callback targets don't leak anything", () => {
  assert.ok(GENERIC_RESET_NOTICE.startsWith("If an account exists"));
  assert.equal(VERIFIED_LOGIN_CALLBACK, "/login?verified=1");
  assert.equal(RESET_PASSWORD_PATH, "/reset-password");
});

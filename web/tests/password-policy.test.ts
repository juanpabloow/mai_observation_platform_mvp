/**
 * Tests for the new-password rule (lib/passwordPolicy.ts + its Better Auth hook), on an
 * in-memory Better Auth instance. No DB, no network.
 * Run from the repo root:  npm run test:auth
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { createAuthMiddleware } from "better-auth/api";

import { buildPasswordReset } from "../lib/auth-verification";
import { enforcePasswordPolicy } from "../lib/auth-password-policy";
import { PASSWORD_MAX, PASSWORD_MIN, checkNewPassword, passwordProblem } from "../lib/passwordPolicy";
import { mapClientAuthError } from "../lib/auth-errors";
import { PASSWORD_POLICY_CODES } from "../lib/auth-password-policy";

const LAURA = { email: "laura.gomez@barberialaura.com", name: "Laura Gómez" };

test("length: 12 to 128 characters", () => {
  assert.equal(PASSWORD_MIN, 12);
  assert.equal(passwordProblem("caballo-ve1")?.id, "length");
  assert.equal(passwordProblem("caballo verde"), null);
  assert.equal(passwordProblem("x".repeat(PASSWORD_MAX + 1))?.id, "too-long");
});

test("common and guessable passwords are refused", () => {
  for (const p of [
    "password1234",
    "Contraseña2026!",
    "Montserrat2026#",
    "123456789012",
    "abcdefghijklm",
    "qwertyuiopasd",
    "aaaaaaaaaaaa",
    "abcabcabcabc",
    "202620262026",
    "1q2w3e4r5t6y",
    "Barberia2026!",
  ]) {
    assert.equal(passwordProblem(p)?.id, "common", p);
  }
});

test("passphrases and long random strings pass, with no composition rules", () => {
  for (const p of ["caballo bateria grapa", "mi perro come mango", "tL9#qz!vR2mw", "lunes de corte y barba"]) {
    assert.equal(passwordProblem(p, LAURA), null, p);
  }
});

test("the person's email and name are refused, accents and case ignored", () => {
  assert.equal(passwordProblem("laura.gomez-2026", LAURA)?.id, "personal");
  assert.equal(passwordProblem("GOMEZ caballo verde", LAURA)?.id, "personal");
  assert.equal(passwordProblem("BarberiaLaura!!77", LAURA)?.id, "personal");
  // A free-mail domain is not personal.
  assert.equal(passwordProblem("gmail caballo verde", { email: "pepe@gmail.com" }), null);
});

test("strength: weak until every rule passes, strong when long or varied", () => {
  assert.equal(checkNewPassword("").strength, "empty");
  assert.equal(checkNewPassword("password1234").strength, "weak");
  assert.equal(checkNewPassword("caballo verde").strength, "good");
  assert.equal(checkNewPassword("caballo verde mango").strength, "strong");
});

test("every server code has Spanish copy, and the hook guards the endpoints that set a password", () => {
  for (const code of Object.values(PASSWORD_POLICY_CODES)) {
    assert.notEqual(mapClientAuthError(code, "FALLBACK"), "FALLBACK", code);
  }
  const src = readFileSync(fileURLToPath(new URL("../lib/auth-password-policy.ts", import.meta.url)), "utf8");
  for (const path of ["/sign-up/email", "/reset-password", "/change-password"]) assert.ok(src.includes(`"${path}"`), path);
  const authSrc = readFileSync(fileURLToPath(new URL("../lib/auth.ts", import.meta.url)), "utf8");
  assert.match(authSrc, /await enforcePasswordPolicy\(ctx\)/);
  assert.match(authSrc, /minPasswordLength: PASSWORD_MIN/);
});

// ---- Flow: the real hook on a real (in-memory) Better Auth instance -------------------------

function makeAuth() {
  const sent: { html: string }[] = [];
  const auth = betterAuth({
    database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
    baseURL: "https://app.test",
    secret: "test-secret-test-secret-test-secret",
    emailAndPassword: {
      enabled: true,
      minPasswordLength: PASSWORD_MIN,
      maxPasswordLength: PASSWORD_MAX,
      ...buildPasswordReset(async (msg) => {
        sent.push(msg);
        return { ok: true as const, id: "test" };
      }),
    },
    hooks: { before: createAuthMiddleware(enforcePasswordPolicy) },
  });
  return { auth, sent };
}

const codeOf = (err: unknown) => (err as { body?: { code?: string } }).body?.code;

test("flow: sign-up refuses a weak password before creating anything", async () => {
  const { auth } = makeAuth();
  await assert.rejects(
    auth.api.signUpEmail({ body: { email: "laura@barberialaura.com", name: "Laura", password: "Barberia2026!" } }),
    (e) => codeOf(e) === "PASSWORD_TOO_COMMON",
  );
  await assert.rejects(
    auth.api.signUpEmail({ body: { email: "laura@barberialaura.com", name: "Laura", password: "laura caballo verde" } }),
    (e) => codeOf(e) === "PASSWORD_HAS_PERSONAL_INFO",
  );
  assert.equal(await (await auth.$context).internalAdapter.findUserByEmail("laura@barberialaura.com"), null);
  const ok = await auth.api.signUpEmail({ body: { email: "laura@barberialaura.com", name: "Laura", password: "mi perro come mango" } });
  assert.ok(ok.user.id);
});

test("flow: a reset checks the token's owner, and only a good password consumes the token", async () => {
  const { auth, sent } = makeAuth();
  await auth.api.signUpEmail({ body: { email: "andres.rojas@example.com", name: "Andrés Rojas", password: "mi perro come mango" } });
  await auth.api.requestPasswordReset({ body: { email: "andres.rojas@example.com", redirectTo: "/reset-password" } });
  const href = /href="([^"]+)"/.exec(sent.at(-1)!.html)![1]!.replace(/&amp;/g, "&");
  const token = new URL(href).pathname.split("/").at(-1)!;

  await assert.rejects(auth.api.resetPassword({ body: { token, newPassword: "corta" } }), (e) => codeOf(e) === "PASSWORD_TOO_SHORT");
  await assert.rejects(
    auth.api.resetPassword({ body: { token, newPassword: "Rojas lunes de corte" } }),
    (e) => codeOf(e) === "PASSWORD_HAS_PERSONAL_INFO",
  );
  // The refusals did not burn the single-use token.
  assert.equal((await auth.api.resetPassword({ body: { token, newPassword: "lunes de corte y barba" } })).status, true);
  const signin = await auth.api.signInEmail({ body: { email: "andres.rojas@example.com", password: "lunes de corte y barba" } });
  assert.ok(signin.user);
  // An unknown token with a strong password is still Better Auth's INVALID_TOKEN.
  await assert.rejects(auth.api.resetPassword({ body: { token: "nope", newPassword: "lunes de corte y barba" } }), (e) => codeOf(e) === "INVALID_TOKEN");
});

test("flow: an existing short password keeps signing in (the rule applies on the next change)", async () => {
  const { auth } = makeAuth();
  const ctx = await auth.$context;
  const user = await ctx.internalAdapter.createUser({ email: "vieja@example.com", name: "Vieja", emailVerified: true });
  await ctx.internalAdapter.linkAccount({ userId: user.id, providerId: "credential", accountId: user.id, password: await ctx.password.hash("clave123") });
  const signin = await auth.api.signInEmail({ body: { email: "vieja@example.com", password: "clave123" } });
  assert.ok(signin.user);
});

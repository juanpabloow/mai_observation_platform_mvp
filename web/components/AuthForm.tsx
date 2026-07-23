"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { authClient } from "@/lib/auth-client";
import {
  EMAIL_VERIFIED_NOTICE,
  PASSWORD_RESET_DONE_NOTICE,
  mapAuthErrorParam,
  mapClientAuthError,
} from "@/lib/auth-errors";
import { VERIFIED_LOGIN_CALLBACK } from "@/lib/auth-verification";

/** Only allow internal redirect targets (block open-redirects / protocol-relative). */
function safeRedirect(value: string | null): string {
  if (value && value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\")) {
    return value;
  }
  return "/";
}

/**
 * Email/password auth form shared by /login and /signup, plus a "Continue with
 * Google" button. Google is only functional when configured server-side
 * (googleEnabled) — otherwise the button renders disabled, so the page works
 * without Google creds. Uses the Better Auth client SDK (route handler sets the
 * session cookie); on success redirects home.
 *
 * Account recovery lives at /forgot-password (linked below the form) — the
 * password-reset flow is the ONLY public recovery path; see web/lib/auth.ts
 * for the pre-hijacking rationale.
 */
export function AuthForm({
  mode,
  googleEnabled,
}: {
  mode: "login" | "signup";
  googleEnabled: boolean;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const destination = safeRedirect(searchParams.get("redirect"));
  const isSignup = mode === "signup";
  // The invite accept page links here with ?email to prefill the invited address
  // (UX only — the accept action re-checks the signed-in email against the invite).
  const [email, setEmail] = useState(searchParams.get("email") ?? "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Banner derived from redirects back to /login: OAuth callback errors
  // (?error=account_not_linked via errorCallbackURL, allowlist-mapped), the
  // email-verification link outcome (?verified=1 / ?error=TOKEN_EXPIRED), and
  // the password-reset outcome (?reset=1).
  const urlErrorMessage = mapAuthErrorParam(searchParams.get("error"));
  const successBanner = urlErrorMessage
    ? null
    : searchParams.get("reset") === "1"
      ? PASSWORD_RESET_DONE_NOTICE
      : searchParams.get("verified") === "1"
        ? EMAIL_VERIFIED_NOTICE
        : null;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const result = isSignup
        ? await authClient.signUp.email({
            email,
            password,
            // The user table requires a name; derive a sensible default from the
            // email local-part (no separate field needed for this step).
            name: email.split("@")[0] || email,
            // Where the sendOnSignUp verification link drops the user.
            callbackURL: VERIFIED_LOGIN_CALLBACK,
          })
        : await authClient.signIn.email({ email, password });

      if (result.error) {
        // Allowlist-mapped — raw server messages are never rendered.
        setError(
          mapClientAuthError(
            result.error.code,
            isSignup ? "Could not create the account. Please try again." : "Log in failed. Please try again.",
          ),
        );
        return;
      }
      router.push(destination);
      router.refresh();
    } catch {
      setError("Unexpected error. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function onGoogle() {
    if (!googleEnabled || busy) return;
    setError(null);
    setBusy(true);
    try {
      const result = await authClient.signIn.social({
        provider: "google",
        callbackURL: destination,
        // OAuth-callback failures (e.g. account_not_linked) land back on
        // /login?error=<code>, rendered by mapAuthErrorParam above — instead
        // of Better Auth's bare default error page.
        errorCallbackURL: "/login",
      });
      if (result.error) {
        // Immediate (pre-redirect) failure. Allowlist-mapped code with a
        // generic fallback — never result.error.message directly.
        setError(mapClientAuthError(result.error.code, "Google sign-in failed. Please try again."));
        setBusy(false);
        return;
      }
      // Success = the browser is navigating to Google; keep busy=true so the
      // button can't be double-clicked while the redirect is in flight.
    } catch {
      setError("Google sign-in failed. Please try again.");
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      {urlErrorMessage ? (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm">
          {urlErrorMessage}
        </p>
      ) : null}
      {successBanner ? (
        <p className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm">
          {successBanner}
        </p>
      ) : null}
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">Email</span>
          <input
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="rounded-lg border border-line bg-transparent px-3 py-2 outline-none transition-colors focus:border-line-strong"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">Password</span>
          <input
            type="password"
            required
            minLength={8}
            autoComplete={isSignup ? "new-password" : "current-password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="rounded-lg border border-line bg-transparent px-3 py-2 outline-none transition-colors focus:border-line-strong"
          />
          {isSignup ? (
            <span className="text-xs text-faint">At least 8 characters.</span>
          ) : null}
        </label>

        {error ? (
          <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-danger">
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={busy}
          className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
        >
          {busy ? "Please wait…" : isSignup ? "Create account" : "Log in"}
        </button>

        {!isSignup ? (
          <Link
            href="/forgot-password"
            className="self-center text-sm text-accent hover:opacity-80"
          >
            Forgot password?
          </Link>
        ) : null}
      </form>

      <div className="flex items-center gap-3 text-xs text-faint">
        <span className="h-px flex-1 bg-subtle" />
        or
        <span className="h-px flex-1 bg-subtle" />
      </div>

      <button
        type="button"
        onClick={onGoogle}
        disabled={!googleEnabled || busy}
        title={googleEnabled ? undefined : "Google sign-in is not configured"}
        className="rounded-lg border border-line-strong px-4 py-2 text-sm transition-colors enabled:hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? "Please wait…" : "Continue with Google"}
        {!googleEnabled ? (
          <span className="ml-1 text-xs text-faint">(not configured)</span>
        ) : null}
      </button>

      <p className="text-center text-sm text-neutral-500">
        {isSignup ? (
          <>
            Already have an account?{" "}
            <Link href="/login" className="text-accent hover:opacity-80">
              Log in
            </Link>
          </>
        ) : (
          <>
            No account?{" "}
            <Link href="/signup" className="text-accent hover:opacity-80">
              Sign up
            </Link>
          </>
        )}
      </p>
    </div>
  );
}

"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { authClient } from "@/lib/auth-client";

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
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
          })
        : await authClient.signIn.email({ email, password });

      if (result.error) {
        setError(result.error.message ?? "Authentication failed.");
        return;
      }
      router.push(destination);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unexpected error.");
    } finally {
      setBusy(false);
    }
  }

  async function onGoogle() {
    if (!googleEnabled) return;
    setError(null);
    await authClient.signIn.social({ provider: "google", callbackURL: destination });
  }

  return (
    <div className="flex flex-col gap-5">
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-400">Email</span>
          <input
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="rounded-lg border border-white/10 bg-transparent px-3 py-2 outline-none transition-colors focus:border-white/30"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-400">Password</span>
          <input
            type="password"
            required
            minLength={8}
            autoComplete={isSignup ? "new-password" : "current-password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="rounded-lg border border-white/10 bg-transparent px-3 py-2 outline-none transition-colors focus:border-white/30"
          />
          {isSignup ? (
            <span className="text-xs text-neutral-600">At least 8 characters.</span>
          ) : null}
        </label>

        {error ? (
          <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
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
      </form>

      <div className="flex items-center gap-3 text-xs text-neutral-600">
        <span className="h-px flex-1 bg-white/10" />
        or
        <span className="h-px flex-1 bg-white/10" />
      </div>

      <button
        type="button"
        onClick={onGoogle}
        disabled={!googleEnabled}
        title={googleEnabled ? undefined : "Google sign-in is not configured"}
        className="rounded-lg border border-white/15 px-4 py-2 text-sm transition-colors enabled:hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-50"
      >
        Continue with Google
        {!googleEnabled ? (
          <span className="ml-1 text-xs text-neutral-600">(not configured)</span>
        ) : null}
      </button>

      <p className="text-center text-sm text-neutral-500">
        {isSignup ? (
          <>
            Already have an account?{" "}
            <Link href="/login" className="text-emerald-400 hover:text-emerald-300">
              Log in
            </Link>
          </>
        ) : (
          <>
            No account?{" "}
            <Link href="/signup" className="text-emerald-400 hover:text-emerald-300">
              Sign up
            </Link>
          </>
        )}
      </p>
    </div>
  );
}

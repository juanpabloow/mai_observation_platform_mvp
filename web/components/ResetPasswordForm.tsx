"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { authClient } from "@/lib/auth-client";
import { mapAuthErrorParam, mapClientAuthError } from "@/lib/auth-errors";

/**
 * Consumes the password-reset token minted by Better Auth. The user arrives
 * here via GET /api/auth/reset-password/:token, which validates the token and
 * redirects to this page with ?token=… (or ?error=INVALID_TOKEN). Submitting
 * calls the official resetPassword endpoint: the token is single-use, the old
 * password is replaced, and every existing session is revoked
 * (revokeSessionsOnPasswordReset) — then we send the user to /login to sign
 * in with the new password.
 */
export function ResetPasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token");
  const urlErrorMessage = mapAuthErrorParam(searchParams.get("error"));
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (token === null || urlErrorMessage) {
    return (
      <div className="flex flex-col gap-4">
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm">
          {urlErrorMessage ?? "This reset link is invalid or incomplete."}
        </p>
        <Link href="/forgot-password" className="text-center text-sm text-accent hover:opacity-80">
          Request a new reset link
        </Link>
      </div>
    );
  }

  const resetToken: string = token;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setBusy(true);
    try {
      const result = await authClient.resetPassword({ newPassword: password, token: resetToken });
      if (result.error) {
        setError(mapClientAuthError(result.error.code, "Could not reset the password. Please try again."));
        return;
      }
      router.push("/login?reset=1");
    } catch {
      setError("Could not reset the password. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted">New password</span>
        <input
          type="password"
          required
          minLength={8}
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="rounded-lg border border-line bg-transparent px-3 py-2 outline-none transition-colors focus:border-line-strong"
        />
        <span className="text-xs text-faint">At least 8 characters.</span>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted">Confirm new password</span>
        <input
          type="password"
          required
          minLength={8}
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className="rounded-lg border border-line bg-transparent px-3 py-2 outline-none transition-colors focus:border-line-strong"
        />
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
        {busy ? "Please wait…" : "Set new password"}
      </button>
    </form>
  );
}

"use client";

import { useState } from "react";
import Link from "next/link";
import { authClient } from "@/lib/auth-client";
import { GENERIC_RESET_NOTICE, RATE_LIMITED_NOTICE } from "@/lib/auth-errors";
import { RESET_PASSWORD_PATH } from "@/lib/auth-verification";

/**
 * Public "recover access" form. Better Auth's /request-password-reset answers
 * generically whether or not the account exists, and this component mirrors
 * that: every outcome except an explicit rate limit shows the same notice, so
 * the UI can't be used to enumerate accounts either.
 */
export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await authClient.requestPasswordReset({
        email,
        redirectTo: RESET_PASSWORD_PATH,
      });
      setNotice(result.error?.status === 429 ? RATE_LIMITED_NOTICE : GENERIC_RESET_NOTICE);
    } catch {
      setNotice(GENERIC_RESET_NOTICE);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
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
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
        >
          {busy ? "Sending…" : "Send reset link"}
        </button>
        {notice ? (
          <p className="rounded-lg border border-line bg-subtle px-3 py-2 text-sm text-muted">
            {notice}
          </p>
        ) : null}
      </form>
      <p className="text-center text-sm text-neutral-500">
        Remembered it?{" "}
        <Link href="/login" className="text-accent hover:opacity-80">
          Back to log in
        </Link>
      </p>
    </div>
  );
}

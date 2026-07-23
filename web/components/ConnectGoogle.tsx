"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { mapAuthErrorParam, mapClientAuthError } from "@/lib/auth-errors";

/**
 * Explicit Google linking from an AUTHENTICATED session — the only sanctioned
 * way to connect Google to an account that can't link implicitly. Calls the
 * official linkSocial endpoint; Better Auth carries the session's userId in
 * the OAuth state and enforces same-email linking server-side
 * (allowDifferentEmails: false), so this can never attach a different
 * address or create a second user.
 */
export function ConnectGoogle({
  googleEnabled,
  googleLinked,
  email,
}: {
  googleEnabled: boolean;
  googleLinked: boolean;
  email: string;
}) {
  const searchParams = useSearchParams();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const urlErrorMessage = mapAuthErrorParam(searchParams.get("error"));
  // Success banner only when the link is CONFIRMED server-side (googleLinked
  // comes from listUserAccounts on the server) — ?linked=1 alone is just a
  // client-forgeable query param.
  const justLinked = googleLinked && searchParams.get("linked") === "1";

  async function onConnect() {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const result = await authClient.linkSocial({
        provider: "google",
        callbackURL: "/settings/security?linked=1",
        errorCallbackURL: "/settings/security",
      });
      if (result.error) {
        setError(mapClientAuthError(result.error.code, "Could not start Google linking. Please try again."));
        setBusy(false);
        return;
      }
      // Success = redirecting to Google; keep busy=true against double clicks.
    } catch {
      setError("Could not start Google linking. Please try again.");
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-line p-4">
      <div className="space-y-1">
        <h2 className="text-sm font-medium">Google sign-in</h2>
        <p className="text-sm text-muted">
          {googleLinked
            ? "Google is connected. You can sign in with Google or your password."
            : `Connect the Google account for ${email} to also sign in with Google. Only a Google account with this exact email can be connected.`}
        </p>
      </div>

      {urlErrorMessage ? (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm">
          {urlErrorMessage}
        </p>
      ) : null}
      {justLinked ? (
        <p className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm">
          Google connected. You can now use it to sign in.
        </p>
      ) : null}
      {error ? (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      ) : null}

      {!googleLinked ? (
        <button
          type="button"
          onClick={onConnect}
          disabled={!googleEnabled || busy}
          title={googleEnabled ? undefined : "Google sign-in is not configured"}
          className="self-start rounded-lg border border-line-strong px-4 py-2 text-sm transition-colors enabled:hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "Please wait…" : "Connect Google"}
        </button>
      ) : null}
    </section>
  );
}

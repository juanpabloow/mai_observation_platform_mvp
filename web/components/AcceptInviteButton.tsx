"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { acceptInvitationAction } from "@/lib/inviteActions";

/**
 * Confirms acceptance of an invite. The READ (token validation + display) happens
 * on the server page; this button triggers the MUTATION (acceptInvitationAction),
 * which re-validates everything server-side and returns where to land. Splitting
 * read (GET) from write (action) keeps the accept URL itself side-effect-free.
 */
export function AcceptInviteButton({ token }: { token: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onAccept() {
    setBusy(true);
    setError(null);
    try {
      const res = await acceptInvitationAction(token);
      if (res.ok && res.redirectTo) {
        router.push(res.redirectTo);
        router.refresh(); // pick up the brand-new membership in the scope resolvers
        return;
      }
      setError(res.error ?? "Could not accept the invitation.");
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        onClick={onAccept}
        disabled={busy}
        className="rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
      >
        {busy ? "Joining…" : "Accept invitation"}
      </button>
      {error ? (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

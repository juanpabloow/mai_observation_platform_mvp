"use client";

import { useState } from "react";
import { acceptInvitationAction } from "@/lib/inviteActions";
import { ACC, Notice } from "@/components/access/AccessShell";

/**
 * Confirms acceptance of an invite. The READ (token validation + display) happens
 * on the server page; this button triggers the MUTATION (acceptInvitationAction),
 * which re-validates everything server-side and returns where to land. Splitting
 * read (GET) from write (action) keeps the accept URL itself side-effect-free.
 */
export function AcceptInviteButton({ token }: { token: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onAccept() {
    setBusy(true);
    setError(null);
    try {
      const res = await acceptInvitationAction(token);
      if (res.ok && res.redirectTo) {
        // Hard navigation: the new membership changes the whole shell (rail, scope).
        window.location.assign(res.redirectTo);
        return;
      }
      setError(res.error ?? "No pudimos aceptar la invitación.");
    } catch {
      setError("Algo salió mal. Inténtalo otra vez.");
    }
    setBusy(false);
  }

  return (
    <div className="flex flex-col gap-3">
      {error ? <Notice tone="error">{error}</Notice> : null}
      <button type="button" onClick={onAccept} aria-busy={busy || undefined} className={ACC.primary}>
        {busy ? "Uniéndote…" : "Aceptar invitación"}
      </button>
    </div>
  );
}

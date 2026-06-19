"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { revokeInvitationAction } from "@/lib/inviteActions";

export interface TeamInviteView {
  id: string;
  email: string;
  role: "admin" | "member";
  clientName: string | null;
  status: "pending" | "accepted" | "revoked" | "expired";
  sentLabel: string;
  expiryLabel: string;
  invitedByEmail: string | null;
  /** A pending invite past its expiry — shown as expired (no revoke needed). */
  isExpired: boolean;
}

const STATUS_BADGE: Record<string, string> = {
  pending: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  accepted: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  revoked: "bg-subtle text-muted",
  expired: "bg-subtle text-muted",
};

function roleLabel(inv: TeamInviteView): string {
  return inv.role === "member" ? `member · ${inv.clientName ?? "—"}` : "admin";
}

export function TeamInvitations({ invites }: { invites: TeamInviteView[] }) {
  const pending = invites.filter((i) => i.status === "pending" && !i.isExpired);
  const past = invites.filter((i) => !(i.status === "pending" && !i.isExpired));

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <h2 className="text-sm font-medium uppercase tracking-wider text-muted">Pending invitations</h2>
        {pending.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-line px-4 py-8 text-center text-sm text-faint">
            No pending invitations.
          </p>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line">
            {pending.map((inv) => (
              <PendingRow key={inv.id} invite={inv} />
            ))}
          </ul>
        )}
      </div>

      {past.length > 0 ? (
        <details className="group">
          <summary className="cursor-pointer list-none text-xs font-medium uppercase tracking-wider text-faint hover:text-muted">
            History ({past.length})
          </summary>
          <ul className="mt-2 divide-y divide-line overflow-hidden rounded-2xl border border-line">
            {past.map((inv) => (
              <li key={inv.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                <div className="min-w-0">
                  <span className="truncate text-muted">{inv.email}</span>
                  <span className="ml-2 text-xs text-faint">{roleLabel(inv)}</span>
                </div>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${STATUS_BADGE[inv.isExpired ? "expired" : inv.status]}`}>
                  {inv.isExpired && inv.status === "pending" ? "expired" : inv.status}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function PendingRow({ invite }: { invite: TeamInviteView }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);

  async function revoke() {
    setBusy(true);
    setError(null);
    try {
      const res = await revokeInvitationAction(invite.id);
      if (res.ok) router.refresh();
      else setError("Could not revoke.");
    } catch {
      setError("Could not revoke.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="flex flex-col gap-1 px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <span className="truncate font-medium">{invite.email}</span>
          <span className="ml-2 text-xs text-faint">{roleLabel(invite)}</span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-xs text-faint">expires {invite.expiryLabel}</span>
          {confirm ? (
            <span className="flex items-center gap-1.5">
              <button
                type="button"
                disabled={busy}
                onClick={revoke}
                className="rounded-md bg-red-600 px-2 py-1 text-xs font-medium text-white hover:bg-red-500 disabled:opacity-50"
              >
                Revoke
              </button>
              <button
                type="button"
                onClick={() => setConfirm(false)}
                className="rounded-md px-2 py-1 text-xs text-muted hover:text-foreground"
              >
                Cancel
              </button>
            </span>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirm(true)}
              className="rounded-md px-2 py-1 text-xs text-danger transition-colors hover:bg-red-500/10 disabled:opacity-50"
            >
              Revoke
            </button>
          )}
        </div>
      </div>
      <p className="text-xs text-faint">
        {invite.invitedByEmail ? `invited by ${invite.invitedByEmail} · ` : ""}sent {invite.sentLabel}
      </p>
      {error ? <p className="text-xs text-danger">{error}</p> : null}
    </li>
  );
}

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  changeMemberRoleAction,
  reassignMemberClientAction,
  removeMemberAction,
} from "@/lib/memberActions";

export type MemberRole = "owner" | "admin" | "member";

export interface TeamMemberView {
  userId: string;
  email: string;
  role: MemberRole;
  clientId: string | null;
  clientName: string | null;
  isYou: boolean;
}
export interface TeamClientOption {
  id: string;
  name: string;
}

const ROLE_BADGE: Record<MemberRole, string> = {
  owner: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  admin: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  member: "bg-subtle text-muted",
};

/**
 * Tenant members list with inline management controls, scoped to the viewer's
 * capability (the server actions are the real gate; this only hides what the
 * viewer can't do): the owner row is never editable; admin rows are editable only
 * by the owner; member rows are editable by owner or admin.
 */
export function TeamMembers({
  members,
  clients,
  viewerRole,
}: {
  members: TeamMemberView[];
  clients: TeamClientOption[];
  viewerRole: "owner" | "admin";
}) {
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line">
      {members.map((m) => (
        <MemberRow key={m.userId} member={m} clients={clients} viewerRole={viewerRole} />
      ))}
    </ul>
  );
}

function MemberRow({
  member,
  clients,
  viewerRole,
}: {
  member: TeamMemberView;
  clients: TeamClientOption[];
  viewerRole: "owner" | "admin";
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [demoting, setDemoting] = useState(false);
  const [demoteClient, setDemoteClient] = useState(clients[0]?.id ?? "");

  const isOwnerViewer = viewerRole === "owner";
  // Capability (mirrors the server boundary): owner row immutable; admin rows
  // owner-only; member rows owner-or-admin.
  const manageable =
    member.role !== "owner" && (member.role === "member" || isOwnerViewer);

  async function run(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setBusy(true);
    setError(null);
    try {
      const res = await fn();
      if (res.ok) {
        setConfirmRemove(false);
        setDemoting(false);
        router.refresh();
      } else {
        setError(res.error ?? "Something went wrong.");
      }
    } catch {
      setError("Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="flex flex-col gap-2 px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium">{member.email}</span>
          {member.isYou ? <span className="text-xs text-faint">(you)</span> : null}
          <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs capitalize ${ROLE_BADGE[member.role]}`}>
            {member.role}
          </span>
          {member.role === "member" ? (
            <span className="truncate text-xs text-muted">· {member.clientName ?? "—"}</span>
          ) : null}
        </div>

        {manageable ? (
          <div className="flex shrink-0 items-center gap-2">
            {/* MEMBER: reassign client */}
            {member.role === "member" ? (
              <label className="flex items-center gap-1.5 text-xs text-muted">
                <span className="sr-only">Client</span>
                <select
                  value={member.clientId ?? ""}
                  disabled={busy}
                  onChange={(e) =>
                    run(() =>
                      reassignMemberClientAction({ targetUserId: member.userId, clientId: e.target.value }),
                    )
                  }
                  className="rounded-md border border-line bg-transparent px-2 py-1 text-xs outline-none transition-colors focus:border-line-strong disabled:opacity-50"
                >
                  {clients.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            {/* MEMBER → admin (owner only) */}
            {member.role === "member" && isOwnerViewer ? (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  run(() => changeMemberRoleAction({ targetUserId: member.userId, newRole: "admin" }))
                }
                className="rounded-md border border-line px-2 py-1 text-xs transition-colors hover:bg-subtle disabled:opacity-50"
              >
                Make admin
              </button>
            ) : null}

            {/* ADMIN → member (owner only) — needs a client */}
            {member.role === "admin" && isOwnerViewer ? (
              demoting ? (
                <span className="flex items-center gap-1.5">
                  <select
                    value={demoteClient}
                    onChange={(e) => setDemoteClient(e.target.value)}
                    className="rounded-md border border-line bg-transparent px-2 py-1 text-xs outline-none focus:border-line-strong"
                  >
                    {clients.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    disabled={busy || !demoteClient}
                    onClick={() =>
                      run(() =>
                        changeMemberRoleAction({
                          targetUserId: member.userId,
                          newRole: "member",
                          memberClientId: demoteClient,
                        }),
                      )
                    }
                    className="rounded-md bg-emerald-600 px-2 py-1 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
                  >
                    Confirm
                  </button>
                  <button
                    type="button"
                    onClick={() => setDemoting(false)}
                    className="rounded-md px-2 py-1 text-xs text-muted hover:text-foreground"
                  >
                    Cancel
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setDemoting(true)}
                  className="rounded-md border border-line px-2 py-1 text-xs transition-colors hover:bg-subtle disabled:opacity-50"
                >
                  Make member
                </button>
              )
            ) : null}

            {/* Remove (inline confirm) */}
            {confirmRemove ? (
              <span className="flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => run(() => removeMemberAction({ targetUserId: member.userId }))}
                  className="rounded-md bg-red-600 px-2 py-1 text-xs font-medium text-white hover:bg-red-500 disabled:opacity-50"
                >
                  Remove
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmRemove(false)}
                  className="rounded-md px-2 py-1 text-xs text-muted hover:text-foreground"
                >
                  Cancel
                </button>
              </span>
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirmRemove(true)}
                className="rounded-md px-2 py-1 text-xs text-danger transition-colors hover:bg-red-500/10 disabled:opacity-50"
              >
                Remove
              </button>
            )}
          </div>
        ) : null}
      </div>

      {error ? <p className="text-xs text-danger">{error}</p> : null}
    </li>
  );
}

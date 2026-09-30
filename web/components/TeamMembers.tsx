"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  changeClientRoleAction,
  changeMemberRoleAction,
  reassignMemberClientAction,
  removeMemberAction,
} from "@/lib/memberActions";

export type MemberRole = "owner" | "admin" | "member";
export type ClientRole = "owner" | "editor" | "staff";

export interface TeamMemberView {
  userId: string;
  email: string;
  role: MemberRole;
  clientId: string | null;
  clientName: string | null;
  clientRole: ClientRole | null;
  schedulingSiteId: string | null;
  schedulingSiteName: string | null;
  schedulingStaffId: string | null;
  schedulingStaffName: string | null;
  isYou: boolean;
}
export interface TeamClientOption {
  id: string;
  name: string;
}
export interface TeamSiteOption {
  id: string;
  name: string;
  staff: Array<{ id: string; name: string }>;
}

/**
 * What the viewer may DO, mirroring the server boundary (the actions are the real gate;
 * this only hides what the viewer can't do so no broken control appears):
 *   agency           — tenant owner/admin: reassign client, promote/demote admins;
 *   isOwner          — tenant owner: manage the admin tier;
 *   canManageMembers — may manage the member rows shown (client role + remove) — true for
 *                      the agency and for a Client Owner on their own client's page;
 *   canAssignOwner   — may grant the client role 'owner' (agency only).
 */
export interface TeamViewer {
  agency: boolean;
  isOwner: boolean;
  canManageMembers: boolean;
  canAssignOwner: boolean;
}

const ROLE_BADGE: Record<MemberRole, string> = {
  owner: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  admin: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  member: "bg-subtle text-muted",
};

const CLIENT_ROLE_LABEL: Record<ClientRole, string> = {
  owner: "Owner",
  editor: "Editor",
  staff: "Staff",
};

export function TeamMembers({
  members,
  clients = [],
  sites = [],
  viewer,
}: {
  members: TeamMemberView[];
  clients?: TeamClientOption[];
  sites?: TeamSiteOption[];
  viewer: TeamViewer;
}) {
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line">
      {members.map((m) => (
        <MemberRow key={m.userId} member={m} clients={clients} sites={sites} viewer={viewer} />
      ))}
    </ul>
  );
}

function MemberRow({
  member,
  clients,
  sites,
  viewer,
}: {
  member: TeamMemberView;
  clients: TeamClientOption[];
  sites: TeamSiteOption[];
  viewer: TeamViewer;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [demoting, setDemoting] = useState(false);
  const [demoteClient, setDemoteClient] = useState(clients[0]?.id ?? "");
  const [clientRole, setClientRole] = useState<ClientRole>(member.clientRole ?? "editor");
  const [siteId, setSiteId] = useState(member.schedulingSiteId ?? sites[0]?.id ?? "");
  const initialSite = sites.find((s) => s.id === (member.schedulingSiteId ?? sites[0]?.id));
  const [staffId, setStaffId] = useState(member.schedulingStaffId ?? initialSite?.staff[0]?.id ?? "");
  const selectedSite = sites.find((s) => s.id === siteId);

  function changeSite(nextSiteId: string) {
    setSiteId(nextSiteId);
    setStaffId(sites.find((s) => s.id === nextSiteId)?.staff[0]?.id ?? "");
  }

  // Which rows this viewer may act on (mirrors the server): the tenant owner is
  // immutable; admins are owner-only; members are managed by the agency or the client's
  // Owner. A Client Owner cannot act on another Owner (so canManageMembers still hides
  // owner-row controls for a non-agency viewer).
  const manageable =
    member.role === "owner"
      ? false
      : member.role === "admin"
        ? viewer.agency && viewer.isOwner
        : viewer.canManageMembers && !(member.clientRole === "owner" && !viewer.agency);

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
            <span className="truncate text-xs text-muted">
              · {member.clientRole ? CLIENT_ROLE_LABEL[member.clientRole] : "—"}
              {member.clientRole === "staff" && member.schedulingStaffName
                ? ` · ${member.schedulingStaffName}`
                : member.clientName
                  ? ` · ${member.clientName}`
                  : ""}
            </span>
          ) : null}
        </div>

        {manageable ? (
          <div className="flex shrink-0 items-center gap-2">
            {/* MEMBER: reassign client (agency only) */}
            {member.role === "member" && viewer.agency && clients.length > 0 ? (
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

            {/* MEMBER → admin (tenant owner only) */}
            {member.role === "member" && viewer.agency && viewer.isOwner ? (
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

            {/* ADMIN → member (tenant owner only) — needs a client */}
            {member.role === "admin" && viewer.agency && viewer.isOwner ? (
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

      {/* CLIENT ROLE editor — owner/editor/staff for a member of this client. The "Owner"
          option only appears for the agency (a Client Owner can't mint Owners); staff
          needs a site + staff binding. */}
      {manageable && member.role === "member" && member.clientId && viewer.canManageMembers ? (
        <div className="flex flex-wrap items-end gap-2 rounded-lg bg-subtle px-3 py-2">
          <label className="flex flex-col gap-1 text-xs text-muted">
            Role
            <select
              value={clientRole}
              disabled={busy}
              onChange={(event) => setClientRole(event.target.value as ClientRole)}
              className="rounded-md border border-line bg-card px-2 py-1.5 text-foreground"
            >
              {viewer.canAssignOwner ? <option value="owner">Owner</option> : null}
              <option value="editor">Editor</option>
              <option value="staff">Staff</option>
            </select>
          </label>
          {clientRole === "staff" ? (
            <>
              <label className="flex flex-col gap-1 text-xs text-muted">
                Site
                <select
                  value={siteId}
                  disabled={busy}
                  onChange={(event) => changeSite(event.target.value)}
                  className="rounded-md border border-line bg-card px-2 py-1.5 text-foreground"
                >
                  {sites.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs text-muted">
                Staff profile
                <select
                  value={staffId}
                  disabled={busy}
                  onChange={(event) => setStaffId(event.target.value)}
                  className="rounded-md border border-line bg-card px-2 py-1.5 text-foreground"
                >
                  {(selectedSite?.staff ?? []).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
            </>
          ) : null}
          <button
            type="button"
            disabled={busy || (clientRole === "staff" && (!siteId || !staffId))}
            onClick={() =>
              run(() =>
                changeClientRoleAction({
                  targetUserId: member.userId,
                  clientId: member.clientId as string,
                  clientRole,
                  siteId: clientRole === "staff" ? siteId : null,
                  staffId: clientRole === "staff" ? staffId : null,
                }),
              )
            }
            className="rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background disabled:opacity-50"
          >
            Save role
          </button>
        </div>
      ) : null}

      {error ? <p className="text-xs text-danger">{error}</p> : null}
    </li>
  );
}

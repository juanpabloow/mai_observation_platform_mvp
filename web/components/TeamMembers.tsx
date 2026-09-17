"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  changeMemberRoleAction,
  reassignMemberClientAction,
  removeMemberAction,
  setMemberSchedulingAccessAction,
} from "@/lib/memberActions";

export type MemberRole = "owner" | "admin" | "member";

export interface TeamMemberView {
  userId: string;
  email: string;
  role: MemberRole;
  clientId: string | null;
  clientName: string | null;
  schedulingAccess: "staff" | "reception" | null;
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
  sites = [],
  viewerRole,
}: {
  members: TeamMemberView[];
  clients: TeamClientOption[];
  sites?: TeamSiteOption[];
  viewerRole: "owner" | "admin";
}) {
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line">
      {members.map((m) => (
        <MemberRow key={m.userId} member={m} clients={clients} sites={sites} viewerRole={viewerRole} />
      ))}
    </ul>
  );
}

function MemberRow({
  member,
  clients,
  sites,
  viewerRole,
}: {
  member: TeamMemberView;
  clients: TeamClientOption[];
  sites: TeamSiteOption[];
  viewerRole: "owner" | "admin";
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [demoting, setDemoting] = useState(false);
  const [demoteClient, setDemoteClient] = useState(clients[0]?.id ?? "");
  const [scheduleAccess, setScheduleAccess] = useState<"standard" | "staff" | "reception">(
    member.schedulingAccess ?? "standard",
  );
  const [scheduleSiteId, setScheduleSiteId] = useState(member.schedulingSiteId ?? sites[0]?.id ?? "");
  const initialSite = sites.find((site) => site.id === (member.schedulingSiteId ?? sites[0]?.id));
  const [scheduleStaffId, setScheduleStaffId] = useState(
    member.schedulingStaffId ?? initialSite?.staff[0]?.id ?? "",
  );
  const selectedScheduleSite = sites.find((site) => site.id === scheduleSiteId);

  function changeScheduleSite(nextSiteId: string) {
    setScheduleSiteId(nextSiteId);
    setScheduleStaffId(sites.find((site) => site.id === nextSiteId)?.staff[0]?.id ?? "");
  }

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
            <span className="truncate text-xs text-muted">
              · {member.schedulingAccess === "staff"
                ? `Staff · ${member.schedulingStaffName ?? "unassigned"}`
                : member.schedulingAccess === "reception"
                  ? `Reception · ${member.schedulingSiteName ?? "unassigned"}`
                  : member.clientName ?? "—"}
            </span>
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

      {manageable && member.role === "member" && member.clientId && sites.length > 0 ? (
        <div className="flex flex-wrap items-end gap-2 rounded-lg bg-subtle px-3 py-2">
          <label className="flex flex-col gap-1 text-xs text-muted">
            Schedule access
            <select
              value={scheduleAccess}
              disabled={busy}
              onChange={(event) => setScheduleAccess(event.target.value as typeof scheduleAccess)}
              className="rounded-md border border-line bg-card px-2 py-1.5 text-foreground"
            >
              <option value="standard">Standard member</option>
              <option value="staff">Staff · own schedule</option>
              <option value="reception">Reception · site agenda</option>
            </select>
          </label>
          {scheduleAccess !== "standard" ? (
            <label className="flex flex-col gap-1 text-xs text-muted">
              Site
              <select
                value={scheduleSiteId}
                disabled={busy}
                onChange={(event) => changeScheduleSite(event.target.value)}
                className="rounded-md border border-line bg-card px-2 py-1.5 text-foreground"
              >
                {sites.map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}
              </select>
            </label>
          ) : null}
          {scheduleAccess === "staff" ? (
            <label className="flex flex-col gap-1 text-xs text-muted">
              Staff profile
              <select
                value={scheduleStaffId}
                disabled={busy}
                onChange={(event) => setScheduleStaffId(event.target.value)}
                className="rounded-md border border-line bg-card px-2 py-1.5 text-foreground"
              >
                {(selectedScheduleSite?.staff ?? []).map((staff) => (
                  <option key={staff.id} value={staff.id}>{staff.name}</option>
                ))}
              </select>
            </label>
          ) : null}
          <button
            type="button"
            disabled={busy || (scheduleAccess !== "standard" && !scheduleSiteId) || (scheduleAccess === "staff" && !scheduleStaffId)}
            onClick={() => run(() => setMemberSchedulingAccessAction({
              targetUserId: member.userId,
              clientId: member.clientId as string,
              access: scheduleAccess === "standard" ? null : scheduleAccess,
              siteId: scheduleAccess === "standard" ? null : scheduleSiteId,
              staffId: scheduleAccess === "staff" ? scheduleStaffId : null,
            }))}
            className="rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background disabled:opacity-50"
          >
            Save access
          </button>
        </div>
      ) : null}

      {error ? <p className="text-xs text-danger">{error}</p> : null}
    </li>
  );
}

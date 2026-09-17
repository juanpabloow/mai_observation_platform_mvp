"use client";

import { useState } from "react";
import { createInvitationAction } from "@/lib/inviteActions";

type Result = { ok: boolean; error?: string; emailSent?: boolean; acceptUrl?: string };

type InviteFormProps =
  | { mode: "admin" }
  | {
      mode: "member";
      clientId: string;
      clientName: string;
      sites: Array<{
        id: string;
        name: string;
        staff: Array<{ id: string; name: string }>;
      }>;
    };

/**
 * Invite form, scoped by SURFACE (RBAC split):
 *  - mode="admin"  (Hub Team) → invites a tenant-wide ADMIN; no client.
 *  - mode="member" (per-client Team) → invites a MEMBER of the CONTEXT client; the
 *    client is implied by the route (no picker), passed in by the page.
 * Both call the proven createInvitationAction. The server re-validates role↔client
 * and that the client is the tenant's, so the implied client can't be spoofed.
 */
export function InviteForm(props: InviteFormProps) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [access, setAccess] = useState<"standard" | "staff" | "reception">("staff");
  const [siteId, setSiteId] = useState(props.mode === "member" ? (props.sites[0]?.id ?? "") : "");
  const selectedSite = props.mode === "member" ? props.sites.find((site) => site.id === siteId) : null;
  const [staffId, setStaffId] = useState(
    props.mode === "member" ? (props.sites[0]?.staff[0]?.id ?? "") : "",
  );

  function changeSite(nextSiteId: string) {
    setSiteId(nextSiteId);
    if (props.mode === "member") {
      setStaffId(props.sites.find((site) => site.id === nextSiteId)?.staff[0]?.id ?? "");
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    try {
      const res = await createInvitationAction(
        props.mode === "admin"
          ? { email, role: "admin" }
          : {
              email,
              role: "member",
              memberClientId: props.clientId,
              schedulingAccess: access === "standard" ? null : access,
              schedulingSiteId: access === "standard" ? null : siteId,
              schedulingStaffId: access === "staff" ? staffId : null,
            },
      );
      setResult(res);
      if (res.ok) setEmail("");
    } catch {
      setResult({ ok: false, error: "Something went wrong creating the invitation." });
    } finally {
      setBusy(false);
    }
  }

  const hint =
    props.mode === "admin"
      ? "They'll have full access to the workspace."
      : `They'll be added as a member of ${props.clientName}.`;

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3 rounded-2xl border border-line bg-card p-5">
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted">Email</span>
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="teammate@example.com"
          className="rounded-lg border border-line bg-transparent px-3 py-2 outline-none transition-colors focus:border-line-strong"
        />
      </label>
      {props.mode === "member" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted">Access</span>
            <select
              value={access}
              onChange={(event) => setAccess(event.target.value as typeof access)}
              className="rounded-lg border border-line bg-card px-3 py-2 outline-none focus:border-line-strong"
            >
              <option value="staff">Staff · own schedule</option>
              <option value="reception">Reception · site agenda</option>
              <option value="standard">Standard client member</option>
            </select>
          </label>
          {access !== "standard" ? (
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted">Site</span>
              <select
                required
                value={siteId}
                onChange={(event) => changeSite(event.target.value)}
                className="rounded-lg border border-line bg-card px-3 py-2 outline-none focus:border-line-strong"
              >
                {props.sites.map((site) => (
                  <option key={site.id} value={site.id}>{site.name}</option>
                ))}
              </select>
            </label>
          ) : null}
          {access === "staff" ? (
            <label className="flex flex-col gap-1 text-sm sm:col-span-2">
              <span className="text-muted">Staff profile</span>
              <select
                required
                value={staffId}
                onChange={(event) => setStaffId(event.target.value)}
                className="rounded-lg border border-line bg-card px-3 py-2 outline-none focus:border-line-strong"
              >
                {(selectedSite?.staff ?? []).map((staff) => (
                  <option key={staff.id} value={staff.id}>{staff.name}</option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
      ) : null}
      <p className="text-xs text-faint">{hint}</p>

      <button
        type="submit"
        disabled={
          busy ||
          (props.mode === "member" && access !== "standard" && !siteId) ||
          (props.mode === "member" && access === "staff" && !staffId)
        }
        className="self-start rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
      >
        {busy ? "Sending…" : props.mode === "admin" ? "Send admin invitation" : "Send member invitation"}
      </button>

      {result ? (
        <div
          className={`rounded-lg border px-3 py-2 text-sm ${
            result.ok && result.emailSent
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
              : result.ok
                ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                : "border-red-500/30 bg-red-500/10 text-danger"
          }`}
        >
          {result.ok ? (
            <div className="space-y-1">
              <p>{result.emailSent ? "Invitation sent." : result.error}</p>
              {result.acceptUrl ? (
                <p className="break-all font-mono text-xs text-muted">{result.acceptUrl}</p>
              ) : null}
            </div>
          ) : (
            <p>{result.error}</p>
          )}
        </div>
      ) : null}
    </form>
  );
}

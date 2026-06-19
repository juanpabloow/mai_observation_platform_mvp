"use client";

import { useState } from "react";
import { createInvitationAction } from "@/lib/inviteActions";

type Result = { ok: boolean; error?: string; emailSent?: boolean; acceptUrl?: string };

type InviteFormProps =
  | { mode: "admin" }
  | { mode: "member"; clientId: string; clientName: string };

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

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    try {
      const res = await createInvitationAction(
        props.mode === "admin"
          ? { email, role: "admin" }
          : { email, role: "member", memberClientId: props.clientId },
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
      <p className="text-xs text-faint">{hint}</p>

      <button
        type="submit"
        disabled={busy}
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

"use client";

import { useState } from "react";
import { createInvitationAction } from "@/lib/inviteActions";

export interface InviteClientOption {
  id: string;
  name: string;
}

type Result = { ok: boolean; error?: string; emailSent?: boolean; acceptUrl?: string };

/**
 * INTERIM invite form (RBAC-2). RBAC-3 replaces this with the real team-management
 * UI; it exists now so an owner/admin can trigger createInvitationAction end-to-end.
 */
export function InviteForm({ clients }: { clients: InviteClientOption[] }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "member">("member");
  const [clientId, setClientId] = useState(clients[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    try {
      const res = await createInvitationAction({
        email,
        role,
        memberClientId: role === "member" ? clientId : null,
      });
      setResult(res);
      if (res.ok) setEmail("");
    } catch {
      setResult({ ok: false, error: "Something went wrong creating the invitation." });
    } finally {
      setBusy(false);
    }
  }

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

      <div className="flex gap-3">
        <label className="flex flex-1 flex-col gap-1 text-sm">
          <span className="text-muted">Role</span>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as "admin" | "member")}
            className="rounded-lg border border-line bg-transparent px-3 py-2 outline-none transition-colors focus:border-line-strong"
          >
            <option value="member">Member (one client)</option>
            <option value="admin">Admin (full access)</option>
          </select>
        </label>

        {role === "member" ? (
          <label className="flex flex-1 flex-col gap-1 text-sm">
            <span className="text-muted">Client</span>
            <select
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              className="rounded-lg border border-line bg-transparent px-3 py-2 outline-none transition-colors focus:border-line-strong"
            >
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      <button
        type="submit"
        disabled={busy || (role === "member" && !clientId)}
        className="self-start rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
      >
        {busy ? "Sending…" : "Send invitation"}
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

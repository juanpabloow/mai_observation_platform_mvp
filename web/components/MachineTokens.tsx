"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { issueTokenAction, revokeTokenAction, updateTokenCapabilitiesAction } from "@/lib/handoffTokenActions";

export interface MachineTokenView {
  id: string;
  prefix: string; // token_prefix, e.g. "hk_ab12"
  capabilities: string[];
  createdAt: string; // ISO-8601 (UTC)
  lastUsedAt: string | null; // ISO-8601 (UTC)
  revoked: boolean;
}

export interface ConnectionTokens {
  connectionId: string;
  connectionName: string;
  tokens: MachineTokenView[];
}

/** The capability vocabulary in plain language (C-5). The server action re-validates
 *  against the canonical vocabulary; this list is presentation only (hardcoded so the
 *  client bundle never imports the server-only token repo). */
const CAPABILITIES: { key: string; label: string; hint: string }[] = [
  { key: "handoff", label: "Handoff", hint: "Conversation messages, mode & human escalation" },
  { key: "scheduling.read", label: "Read the schedule", hint: "Services, staff, availability, appointment reads" },
  { key: "scheduling.write", label: "Book and change appointments", hint: "Create, cancel, reschedule, confirm, complete" },
  { key: "crm.read", label: "Read contacts", hint: "Look up and read contact records" },
  { key: "crm.write", label: "Create and update contacts", hint: "Upsert, notes, tags, fields, consent" },
];
const DEFAULT_CAPS = ["handoff", "scheduling.read", "scheduling.write"];
const LABEL = new Map(CAPABILITIES.map((c) => [c.key, c.label]));

function fmtDate(iso: string): string {
  return iso.slice(0, 10);
}
function fmtDateTime(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** Reusable capability checklist (issue + edit). */
function CapabilityPicker({ selected, onToggle }: { selected: Set<string>; onToggle: (key: string) => void }) {
  return (
    <fieldset className="flex flex-col gap-1.5">
      {CAPABILITIES.map((c) => (
        <label key={c.key} className="flex items-start gap-2 text-sm">
          <input type="checkbox" checked={selected.has(c.key)} onChange={() => onToggle(c.key)} className="mt-0.5" />
          <span className="flex flex-col">
            <span className="text-foreground">{c.label}</span>
            <span className="text-xs text-faint">{c.hint}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

/**
 * Machine-token management (C-5), on the connections settings surface. Owner/admin only
 * (page + server actions gate at the data layer; a member never reaches here). Issue with
 * a capability checklist (default: handoff + read/write the schedule) → show the raw
 * token ONCE; list each token's capabilities as chips; edit a token's capabilities
 * without re-issuing the secret; revoke behind an inline confirm.
 *
 * "Machine tokens", not "Handoff tokens": these credentials now cover three API families
 * (handoff, scheduling, CRM).
 */
export function MachineTokens({ connections }: { connections: ConnectionTokens[] }) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const [issuingConn, setIssuingConn] = useState<string | null>(null);
  const [issueCaps, setIssueCaps] = useState<Set<string>>(new Set(DEFAULT_CAPS));
  const [editingToken, setEditingToken] = useState<string | null>(null);
  const [editCaps, setEditCaps] = useState<Set<string>>(new Set());

  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, key: string) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setter(next);
  };

  async function issue(connectionId: string) {
    setBusyId(`issue:${connectionId}`);
    setError(null);
    try {
      const res = await issueTokenAction(connectionId, [...issueCaps]);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setNewToken(res.rawToken);
      setCopied(false);
      setIssuingConn(null);
      setIssueCaps(new Set(DEFAULT_CAPS));
      router.refresh();
    } catch {
      setError("Something went wrong issuing the token.");
    } finally {
      setBusyId(null);
    }
  }

  async function saveEdit(tokenId: string) {
    setBusyId(`edit:${tokenId}`);
    setError(null);
    try {
      const res = await updateTokenCapabilitiesAction(tokenId, [...editCaps]);
      if (!res.ok) {
        setError(res.error ?? "Could not update the token.");
        return;
      }
      setEditingToken(null);
      router.refresh();
    } catch {
      setError("Something went wrong updating the token.");
    } finally {
      setBusyId(null);
    }
  }

  async function revoke(tokenId: string) {
    setBusyId(`revoke:${tokenId}`);
    setError(null);
    try {
      const res = await revokeTokenAction(tokenId);
      if (!res.ok) {
        setError("Could not revoke the token — it may already be revoked.");
        return;
      }
      router.refresh();
    } catch {
      setError("Something went wrong revoking the token.");
    } finally {
      setBusyId(null);
      setConfirmRevoke(null);
    }
  }

  async function copyToken() {
    if (!newToken) return;
    try {
      await navigator.clipboard.writeText(newToken);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  if (connections.length === 0) return null;

  return (
    <section className="flex flex-col gap-4">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold tracking-tight">Machine tokens</h2>
        <p className="text-sm text-neutral-500">
          Machine tokens let your n8n workflows call the handoff, scheduling and CRM APIs.
          Each token is scoped to one connection and only its workflows, and grants only
          the capabilities you pick. The full token is shown once, at creation.
        </p>
      </div>

      {error ? (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-danger">{error}</p>
      ) : null}

      {connections.map((conn) => (
        <div key={conn.connectionId} className="flex flex-col gap-3 rounded-xl border border-black/10 p-4 dark:border-line">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold">{conn.connectionName}</h3>
            {issuingConn === conn.connectionId ? null : (
              <button
                type="button"
                onClick={() => {
                  setIssuingConn(conn.connectionId);
                  setIssueCaps(new Set(DEFAULT_CAPS));
                  setError(null);
                }}
                className="shrink-0 rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white transition-colors hover:opacity-90"
              >
                Issue token
              </button>
            )}
          </div>

          {issuingConn === conn.connectionId ? (
            <div className="flex flex-col gap-3 rounded-lg border border-line bg-subtle/40 p-3">
              <p className="text-xs font-medium uppercase tracking-wider text-faint">Capabilities</p>
              <CapabilityPicker selected={issueCaps} onToggle={(k) => toggle(issueCaps, setIssueCaps, k)} />
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={busyId === `issue:${conn.connectionId}` || issueCaps.size === 0}
                  onClick={() => issue(conn.connectionId)}
                  className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                >
                  {busyId === `issue:${conn.connectionId}` ? "Issuing…" : "Create token"}
                </button>
                <button type="button" onClick={() => setIssuingConn(null)} className="text-xs text-faint hover:text-foreground">
                  Cancel
                </button>
              </div>
            </div>
          ) : null}

          {conn.tokens.length > 0 ? (
            <ul className="divide-y divide-black/5 overflow-hidden rounded-lg border border-black/10 dark:divide-white/5 dark:border-line">
              {conn.tokens.map((t) => (
                <li key={t.id} className="flex flex-col gap-2 px-3 py-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm">{t.prefix}…</span>
                        {t.revoked ? (
                          <span className="rounded-full bg-red-500/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-danger">revoked</span>
                        ) : (
                          <span className="rounded-full bg-green-500/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-success">active</span>
                        )}
                      </div>
                      <div className="mt-0.5 text-xs text-neutral-500">
                        Created {fmtDate(t.createdAt)} · {t.lastUsedAt ? `last used ${fmtDateTime(t.lastUsedAt)}` : "never used"}
                      </div>
                    </div>
                    {!t.revoked ? (
                      confirmRevoke === t.id ? (
                        <div className="flex shrink-0 items-center gap-2">
                          <span className="text-xs text-muted">Revoke this token?</span>
                          <button type="button" disabled={busyId === `revoke:${t.id}`} onClick={() => revoke(t.id)} className="rounded-lg border border-red-500/40 px-2.5 py-1 text-xs text-danger transition-colors hover:bg-red-500/10 disabled:opacity-50">
                            {busyId === `revoke:${t.id}` ? "Revoking…" : "Confirm"}
                          </button>
                          <button type="button" onClick={() => setConfirmRevoke(null)} className="rounded-lg border border-black/10 px-2.5 py-1 text-xs transition-colors hover:bg-black/[0.04] dark:border-line-strong dark:hover:bg-subtle">
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <div className="flex shrink-0 items-center gap-1.5">
                          <button type="button" onClick={() => { setEditingToken(t.id); setEditCaps(new Set(t.capabilities)); setError(null); }} className="rounded-lg border border-black/10 px-3 py-1.5 text-sm transition-colors hover:bg-black/[0.04] dark:border-line-strong dark:hover:bg-subtle">
                            Edit
                          </button>
                          <button type="button" onClick={() => setConfirmRevoke(t.id)} className="rounded-lg border border-black/10 px-3 py-1.5 text-sm transition-colors hover:bg-black/[0.04] dark:border-line-strong dark:hover:bg-subtle">
                            Revoke
                          </button>
                        </div>
                      )
                    ) : null}
                  </div>

                  {/* Capability chips */}
                  <div className="flex flex-wrap gap-1">
                    {t.capabilities.length === 0 ? (
                      <span className="rounded-full bg-subtle px-2 py-0.5 text-[11px] text-faint">no capabilities</span>
                    ) : (
                      t.capabilities.map((c) => (
                        <span key={c} className="rounded-full bg-subtle px-2 py-0.5 text-[11px] font-medium text-muted" title={LABEL.get(c) ?? c}>
                          {c}
                        </span>
                      ))
                    )}
                  </div>

                  {/* Inline capability editor */}
                  {editingToken === t.id ? (
                    <div className="flex flex-col gap-3 rounded-lg border border-line bg-subtle/40 p-3">
                      <p className="text-xs font-medium uppercase tracking-wider text-faint">Edit capabilities</p>
                      <CapabilityPicker selected={editCaps} onToggle={(k) => toggle(editCaps, setEditCaps, k)} />
                      <div className="flex items-center gap-2">
                        <button type="button" disabled={busyId === `edit:${t.id}` || editCaps.size === 0} onClick={() => saveEdit(t.id)} className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">
                          {busyId === `edit:${t.id}` ? "Saving…" : "Save"}
                        </button>
                        <button type="button" onClick={() => setEditingToken(null)} className="text-xs text-faint hover:text-foreground">
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-faint">No tokens yet for this connection.</p>
          )}
        </div>
      ))}

      {newToken ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true">
          <div className="w-full max-w-lg rounded-2xl border border-black/10 bg-white p-5 shadow-xl dark:border-line-strong dark:bg-neutral-900">
            <h3 className="text-base font-semibold">Copy your token now</h3>
            <p className="mt-1 text-sm text-neutral-500">
              This is the only time the full token is shown. Store it somewhere safe — you won&rsquo;t be able to see it
              again. If you lose it, revoke it and issue a new one.
            </p>
            <div className="mt-4 break-all rounded-lg border border-line bg-subtle px-3 py-2 font-mono text-sm">{newToken}</div>
            <div className="mt-4 flex items-center justify-end gap-2">
              <button type="button" onClick={copyToken} className="rounded-lg border border-black/10 px-3 py-1.5 text-sm transition-colors hover:bg-black/[0.04] dark:border-line-strong dark:hover:bg-subtle">
                {copied ? "Copied ✓" : "Copy"}
              </button>
              <button type="button" onClick={() => { setNewToken(null); setCopied(false); }} className="rounded-lg bg-accent px-4 py-1.5 text-sm font-medium text-white transition-colors hover:opacity-90">
                Done
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

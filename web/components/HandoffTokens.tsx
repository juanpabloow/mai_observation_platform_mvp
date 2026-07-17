"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { issueTokenAction, revokeTokenAction } from "@/lib/handoffTokenActions";

export interface HandoffTokenView {
  id: string;
  prefix: string; // token_prefix, e.g. "hk_ab12"
  createdAt: string; // ISO-8601 (UTC)
  lastUsedAt: string | null; // ISO-8601 (UTC)
  revoked: boolean;
}

export interface ConnectionTokens {
  connectionId: string;
  connectionName: string;
  tokens: HandoffTokenView[];
}

// Stable UTC formatting from the ISO string — deterministic between server render
// and client hydration (no locale/timezone drift).
function fmtDate(iso: string): string {
  return iso.slice(0, 10);
}
function fmtDateTime(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/**
 * Handoff-token management, on the connections settings surface. Owner/admin only
 * (the page + server actions gate at the data layer; a member never reaches here).
 * Issue → show the raw token ONCE in a copy-me modal; list prefix/created/last-used
 * with a revoked badge; revoke behind an inline confirm.
 */
export function HandoffTokens({ connections }: { connections: ConnectionTokens[] }) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newToken, setNewToken] = useState<string | null>(null); // raw token, shown once
  const [copied, setCopied] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null); // token id

  async function issue(connectionId: string) {
    setBusyId(`issue:${connectionId}`);
    setError(null);
    try {
      const res = await issueTokenAction(connectionId);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setNewToken(res.rawToken);
      setCopied(false);
      router.refresh();
    } catch {
      setError("Something went wrong issuing the token.");
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

  // No connections → nothing to scope a token to.
  if (connections.length === 0) return null;

  return (
    <section className="flex flex-col gap-4">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold tracking-tight">Handoff API tokens</h2>
        <p className="text-sm text-neutral-500">
          Machine tokens let your n8n workflows call the handoff API — post messages,
          check conversation mode, and request human escalation. Each token is scoped
          to one connection and only its workflows. The full token is shown once, at
          creation.
        </p>
      </div>

      {error ? (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      ) : null}

      {connections.map((conn) => (
        <div
          key={conn.connectionId}
          className="flex flex-col gap-3 rounded-xl border border-black/10 p-4 dark:border-line"
        >
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold">{conn.connectionName}</h3>
            <button
              type="button"
              disabled={busyId === `issue:${conn.connectionId}`}
              onClick={() => issue(conn.connectionId)}
              className="shrink-0 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
            >
              {busyId === `issue:${conn.connectionId}` ? "Issuing…" : "Issue token"}
            </button>
          </div>

          {conn.tokens.length > 0 ? (
            <ul className="divide-y divide-black/5 overflow-hidden rounded-lg border border-black/10 dark:divide-white/5 dark:border-line">
              {conn.tokens.map((t) => (
                <li
                  key={t.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm">{t.prefix}…</span>
                      {t.revoked ? (
                        <span className="rounded-full bg-red-500/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-danger">
                          revoked
                        </span>
                      ) : (
                        <span className="rounded-full bg-green-500/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-success">
                          active
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 text-xs text-neutral-500">
                      Created {fmtDate(t.createdAt)} ·{" "}
                      {t.lastUsedAt ? `last used ${fmtDateTime(t.lastUsedAt)}` : "never used"}
                    </div>
                  </div>

                  {!t.revoked ? (
                    confirmRevoke === t.id ? (
                      <div className="flex shrink-0 items-center gap-2">
                        <span className="text-xs text-muted">Revoke this token?</span>
                        <button
                          type="button"
                          disabled={busyId === `revoke:${t.id}`}
                          onClick={() => revoke(t.id)}
                          className="rounded-lg border border-red-500/40 px-2.5 py-1 text-xs text-danger transition-colors hover:bg-red-500/10 disabled:opacity-50"
                        >
                          {busyId === `revoke:${t.id}` ? "Revoking…" : "Confirm"}
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmRevoke(null)}
                          className="rounded-lg border border-black/10 px-2.5 py-1 text-xs transition-colors hover:bg-black/[0.04] dark:border-line-strong dark:hover:bg-subtle"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmRevoke(t.id)}
                        className="shrink-0 rounded-lg border border-black/10 px-3 py-1.5 text-sm transition-colors hover:bg-black/[0.04] dark:border-line-strong dark:hover:bg-subtle"
                      >
                        Revoke
                      </button>
                    )
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-faint">No tokens yet for this connection.</p>
          )}
        </div>
      ))}

      {/* Show-once modal: the only time the raw token is visible. */}
      {newToken ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-lg rounded-2xl border border-black/10 bg-white p-5 shadow-xl dark:border-line-strong dark:bg-neutral-900">
            <h3 className="text-base font-semibold">Copy your token now</h3>
            <p className="mt-1 text-sm text-neutral-500">
              This is the only time the full token is shown. Store it somewhere safe —
              you won&rsquo;t be able to see it again. If you lose it, revoke it and
              issue a new one.
            </p>
            <div className="mt-4 break-all rounded-lg border border-line bg-subtle px-3 py-2 font-mono text-sm">
              {newToken}
            </div>
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={copyToken}
                className="rounded-lg border border-black/10 px-3 py-1.5 text-sm transition-colors hover:bg-black/[0.04] dark:border-line-strong dark:hover:bg-subtle"
              >
                {copied ? "Copied ✓" : "Copy"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setNewToken(null);
                  setCopied(false);
                }}
                className="rounded-lg bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-emerald-500"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

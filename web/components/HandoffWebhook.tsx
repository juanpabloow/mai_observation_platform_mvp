"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  configureWebhookAction,
  deleteWebhookAction,
  regenerateWebhookSecretAction,
  revealWebhookSecretAction,
  setWebhookEnabledAction,
} from "@/lib/webhookActions";
import { validateWebhookUrl } from "@/lib/webhookUrl";

export interface WebhookView {
  url: string;
  enabled: boolean;
  lastDeliveryAt: string | null; // ISO
  lastDeliveryStatus: "sent" | "rejected" | "failed" | null;
}

function fmtDelivery(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/**
 * The "Human Handoff" registration section on the workflow settings surface. Owner/
 * admin only (the settings page renders it only for full-access users; every action
 * re-checks server-side). Configure the send URL, generate/reveal/regenerate the
 * signing secret, toggle enabled, and delete. The secret is shown ONLY right after
 * generate/regenerate or on an explicit reveal.
 */
export function HandoffWebhook({
  workflowId,
  initial,
}: {
  workflowId: string;
  initial: WebhookView | null;
}) {
  const router = useRouter();
  const [url, setUrl] = useState(initial?.url ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null); // shown once
  const [copied, setCopied] = useState(false);
  const [confirmRegen, setConfirmRegen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const configured = initial !== null;

  async function save() {
    setError(null);
    const v = validateWebhookUrl(url);
    if (!v.ok) {
      setError(v.error);
      return;
    }
    setBusy("save");
    try {
      const res = await configureWebhookAction(workflowId, url);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      if (res.createdSecret) {
        setSecret(res.createdSecret);
        setCopied(false);
      }
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function reveal() {
    setError(null);
    setBusy("reveal");
    try {
      const res = await revealWebhookSecretAction(workflowId);
      if (!res.ok || !res.secret) {
        setError(res.error ?? "Could not reveal the secret.");
        return;
      }
      setSecret(res.secret);
      setCopied(false);
    } finally {
      setBusy(null);
    }
  }

  async function regenerate() {
    setError(null);
    setConfirmRegen(false);
    setBusy("regen");
    try {
      const res = await regenerateWebhookSecretAction(workflowId);
      if (!res.ok || !res.secret) {
        setError(res.error ?? "Could not regenerate the secret.");
        return;
      }
      setSecret(res.secret);
      setCopied(false);
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function toggle() {
    if (!initial) return;
    setBusy("toggle");
    try {
      await setWebhookEnabledAction(workflowId, !initial.enabled);
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    setConfirmDelete(false);
    setBusy("delete");
    try {
      await deleteWebhookAction(workflowId);
      setSecret(null);
      setUrl("");
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function copySecret() {
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section className="flex flex-col gap-4 border-t border-line pt-6">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold tracking-tight">Human Handoff</h2>
        <p className="text-sm text-neutral-500">
          Where the platform delivers agent replies for this workflow. The platform
          POSTs each message to your URL, signed with a shared secret (header{" "}
          <code className="font-mono text-xs">X-Handoff-Signature: sha256=…</code>).
          Verify that signature on your side.
        </p>
      </div>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted">Send webhook URL</span>
        <div className="flex gap-2">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://your-n8n.example.com/webhook/handoff-send"
            className="flex-1 rounded-lg border border-line bg-transparent px-3 py-2 font-mono text-sm outline-none focus:border-line-strong"
          />
          <button
            type="button"
            disabled={busy !== null || url.trim() === ""}
            onClick={save}
            className="shrink-0 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
          >
            {busy === "save" ? "Saving…" : configured ? "Update URL" : "Save"}
          </button>
        </div>
        <span className="text-xs text-faint">
          Must be https:// (http:// only for localhost during development).
        </span>
      </label>

      {error ? (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      ) : null}

      {secret ? (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-amber-700 dark:text-amber-400">
              Signing secret
            </span>
            <button
              type="button"
              onClick={copySecret}
              className="rounded-lg border border-black/10 px-2.5 py-1 text-xs transition-colors hover:bg-black/[0.04] dark:border-line-strong dark:hover:bg-subtle"
            >
              {copied ? "Copied ✓" : "Copy"}
            </button>
          </div>
          <div className="mt-1 break-all font-mono text-xs">{secret}</div>
          <p className="mt-1 text-[11px] text-faint">
            Store this in your workflow&rsquo;s signature check. Both sides hold the same
            secret; you can reveal it again anytime as an owner/admin.
          </p>
        </div>
      ) : null}

      {configured ? (
        <div className="flex flex-col gap-3 rounded-xl border border-black/10 p-4 dark:border-line">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm">
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wider ${
                  initial.enabled
                    ? "bg-green-500/15 text-success"
                    : "bg-subtle text-neutral-500"
                }`}
              >
                {initial.enabled ? "enabled" : "disabled"}
              </span>
              {initial.lastDeliveryStatus ? (
                <span className="text-xs text-faint">
                  last delivery: {initial.lastDeliveryStatus}
                  {initial.lastDeliveryAt ? ` · ${fmtDelivery(initial.lastDeliveryAt)}` : ""}
                </span>
              ) : (
                <span className="text-xs text-faint">no deliveries yet</span>
              )}
            </div>
            <button
              type="button"
              disabled={busy !== null}
              onClick={toggle}
              className="rounded-lg border border-black/10 px-3 py-1.5 text-sm transition-colors hover:bg-black/[0.04] disabled:opacity-50 dark:border-line-strong dark:hover:bg-subtle"
            >
              {busy === "toggle" ? "…" : initial.enabled ? "Disable" : "Enable"}
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={busy !== null}
              onClick={reveal}
              className="rounded-lg border border-black/10 px-3 py-1.5 text-sm transition-colors hover:bg-black/[0.04] disabled:opacity-50 dark:border-line-strong dark:hover:bg-subtle"
            >
              {busy === "reveal" ? "…" : "Reveal secret"}
            </button>

            {confirmRegen ? (
              <span className="flex items-center gap-2">
                <span className="text-xs text-muted">Existing webhook config will stop validating.</span>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={regenerate}
                  className="rounded-lg border border-amber-500/40 px-2.5 py-1 text-xs text-amber-700 transition-colors hover:bg-amber-500/10 disabled:opacity-50 dark:text-amber-400"
                >
                  {busy === "regen" ? "…" : "Regenerate"}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmRegen(false)}
                  className="rounded-lg border border-black/10 px-2.5 py-1 text-xs transition-colors hover:bg-black/[0.04] dark:border-line-strong dark:hover:bg-subtle"
                >
                  Cancel
                </button>
              </span>
            ) : (
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => setConfirmRegen(true)}
                className="rounded-lg border border-black/10 px-3 py-1.5 text-sm transition-colors hover:bg-black/[0.04] disabled:opacity-50 dark:border-line-strong dark:hover:bg-subtle"
              >
                Regenerate secret
              </button>
            )}

            {confirmDelete ? (
              <span className="flex items-center gap-2">
                <span className="text-xs text-muted">Delete this webhook?</span>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={remove}
                  className="rounded-lg border border-red-500/40 px-2.5 py-1 text-xs text-danger transition-colors hover:bg-red-500/10 disabled:opacity-50"
                >
                  {busy === "delete" ? "…" : "Delete"}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(false)}
                  className="rounded-lg border border-black/10 px-2.5 py-1 text-xs transition-colors hover:bg-black/[0.04] dark:border-line-strong dark:hover:bg-subtle"
                >
                  Cancel
                </button>
              </span>
            ) : (
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => setConfirmDelete(true)}
                className="rounded-lg px-3 py-1.5 text-sm text-neutral-500 transition-colors hover:text-danger disabled:opacity-50"
              >
                Delete
              </button>
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}

"use client";

import { useState, useTransition } from "react";
import {
  dismissConversationAction,
  returnConversationToBotAction,
  takeConversationAction,
  type InboxActionResult,
} from "@/lib/inboxActions";
import type { InboxHeaderView } from "@/lib/inboxView";

const primaryBtn =
  "rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50";
const secondaryBtn =
  "rounded-lg border border-black/10 px-3 py-1.5 text-sm transition-colors hover:bg-black/[0.04] disabled:opacity-50 dark:border-line-strong dark:hover:bg-subtle";

/**
 * Thread action buttons, gated by mode + viewer (the SERVER actions re-check
 * everything; this only decides what to show):
 *   - Take        — bot | pending, any user with access.
 *   - Dismiss     — pending, any user with access (confirm).
 *   - Return to bot — human, only the assigned agent OR owner/admin (confirm).
 */
export function ThreadActions({
  clientId,
  header,
  viewerUserId,
  viewerIsFullAccess,
  onResult,
}: {
  clientId: string;
  header: InboxHeaderView;
  viewerUserId: string;
  viewerIsFullAccess: boolean;
  onResult: (r: InboxActionResult) => void;
}) {
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState<null | "dismiss" | "return">(null);

  const run = (fn: () => Promise<InboxActionResult>) => {
    setConfirming(null);
    startTransition(async () => {
      onResult(await fn());
    });
  };

  const canReturn =
    header.mode === "human" &&
    (viewerIsFullAccess || header.assignedAgentUserId === viewerUserId);

  return (
    <div className="flex flex-wrap items-center gap-2">
      {header.mode === "bot" || header.mode === "pending" ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => run(() => takeConversationAction(clientId, header.id))}
          className={primaryBtn}
        >
          {pending ? "Working…" : "Take"}
        </button>
      ) : null}

      {header.mode === "pending" ? (
        confirming === "dismiss" ? (
          <ConfirmInline
            label="Return to bot without taking?"
            busy={pending}
            onConfirm={() => run(() => dismissConversationAction(clientId, header.id))}
            onCancel={() => setConfirming(null)}
          />
        ) : (
          <button type="button" disabled={pending} onClick={() => setConfirming("dismiss")} className={secondaryBtn}>
            Dismiss
          </button>
        )
      ) : null}

      {canReturn ? (
        confirming === "return" ? (
          <ConfirmInline
            label="Return this conversation to the bot?"
            busy={pending}
            onConfirm={() => run(() => returnConversationToBotAction(clientId, header.id))}
            onCancel={() => setConfirming(null)}
          />
        ) : (
          <button type="button" disabled={pending} onClick={() => setConfirming("return")} className={secondaryBtn}>
            Return to bot
          </button>
        )
      ) : null}
    </div>
  );
}

function ConfirmInline({
  label,
  busy,
  onConfirm,
  onCancel,
}: {
  label: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted">{label}</span>
      <button
        type="button"
        disabled={busy}
        onClick={onConfirm}
        className="rounded-lg border border-amber-500/40 px-2.5 py-1 text-xs text-amber-700 transition-colors hover:bg-amber-500/10 disabled:opacity-50 dark:text-amber-400"
      >
        {busy ? "Working…" : "Confirm"}
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="rounded-lg border border-black/10 px-2.5 py-1 text-xs transition-colors hover:bg-black/[0.04] dark:border-line-strong dark:hover:bg-subtle"
      >
        Cancel
      </button>
    </div>
  );
}

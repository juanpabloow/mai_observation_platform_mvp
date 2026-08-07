"use client";

import { useState, useTransition } from "react";
import {
  dismissConversationAction,
  returnConversationToBotAction,
  takeConversationAction,
  type InboxActionResult,
} from "@/lib/inboxActions";
import type { InboxHeaderView } from "@/lib/inboxView";

// The header's action pair, on tokens rather than raw palette colours: the primary
// is the solid near-black button from the design ("Return to bot" reads as the one
// committing action in the strip), the secondary a hairline shell.
const primaryBtn =
  "inline-flex h-8 items-center rounded-md bg-foreground px-3 text-xs font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50";
const secondaryBtn =
  "inline-flex h-8 items-center rounded-md border border-line-strong px-3 text-xs transition-colors hover:bg-hover disabled:opacity-50";

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
          <button type="button" disabled={pending} onClick={() => setConfirming("return")} className={primaryBtn}>
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
        className="inline-flex h-8 items-center rounded-md border border-warn-rule/50 px-2.5 text-xs text-warn transition-colors hover:bg-warn-soft disabled:opacity-50"
      >
        {busy ? "Working…" : "Confirm"}
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="inline-flex h-8 items-center rounded-md border border-line-strong px-2.5 text-xs transition-colors hover:bg-hover"
      >
        Cancel
      </button>
    </div>
  );
}

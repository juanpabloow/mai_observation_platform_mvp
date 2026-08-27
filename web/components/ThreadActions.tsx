"use client";

import { useState, useTransition } from "react";
import {
  dismissConversationAction,
  returnConversationToBotAction,
  takeConversationAction,
  type InboxActionResult,
} from "@/lib/inboxActions";
import type { InboxHeaderView } from "@/lib/inboxView";

// The header's action pair. The primary is the design's INK button — `--ink` rather than
// `--foreground`, because a filled button carrying white text and body text are two
// different jobs and tying them together means a text-colour tweak restyles every button
// (see the note on --ink in globals.css). The secondary is a hairline shell.
const primaryBtn =
  "inline-flex h-8 items-center rounded-lg bg-ink px-3.5 text-xs font-semibold text-ink-fg transition-colors hover:bg-ink-hover disabled:opacity-50";
const secondaryBtn =
  "inline-flex h-8 items-center rounded-lg border border-line-strong px-3 text-xs text-muted transition-colors hover:border-faint hover:text-foreground disabled:opacity-50";

/**
 * Thread action buttons, gated by mode + viewer (the SERVER actions re-check
 * everything; this only decides what to show):
 *   - Atender       — bot | pending, any user with access.
 *   - Descartar     — pending, any user with access (confirm).
 *   - Devolver al bot — human, only the assigned agent OR owner/admin (confirm).
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
          {pending ? "Un momento…" : "Atender"}
        </button>
      ) : null}

      {header.mode === "pending" ? (
        confirming === "dismiss" ? (
          <ConfirmInline
            label="¿Devolver al bot sin atenderla?"
            busy={pending}
            onConfirm={() => run(() => dismissConversationAction(clientId, header.id))}
            onCancel={() => setConfirming(null)}
          />
        ) : (
          <button type="button" disabled={pending} onClick={() => setConfirming("dismiss")} className={secondaryBtn}>
            Descartar
          </button>
        )
      ) : null}

      {canReturn ? (
        confirming === "return" ? (
          <ConfirmInline
            label="¿Devolver esta conversación al bot?"
            busy={pending}
            onConfirm={() => run(() => returnConversationToBotAction(clientId, header.id))}
            onCancel={() => setConfirming(null)}
          />
        ) : (
          <button type="button" disabled={pending} onClick={() => setConfirming("return")} className={primaryBtn}>
            Devolver al bot
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
        {busy ? "Un momento…" : "Confirmar"}
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="inline-flex h-8 items-center rounded-md border border-line-strong px-2.5 text-xs transition-colors hover:bg-hover"
      >
        Cancelar
      </button>
    </div>
  );
}

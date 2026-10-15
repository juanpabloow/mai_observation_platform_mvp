"use client";

import type { ThreadActionKind, ThreadActionPlan } from "@/lib/inboxPresent";
import { BTN_PRIMARY, BTN_SECONDARY } from "./inbox/InboxUi";

/**
 * The conversation's ONE possible action (frames 1c–1f): "Tomar conversación" or
 * "Devolver al bot", replacing the old Humano|Bot toggle. It never acts directly — it asks
 * the thread to open the confirmation that explains the consequence. Without permission
 * the button stays visible but disabled, with the reason beside it (frame 2j).
 * The rules are threadActionPlan's; the server actions re-check every one.
 */
export function ThreadActions({
  plan,
  busy,
  onRequest,
  compact = false,
}: {
  plan: ThreadActionPlan;
  busy: boolean;
  onRequest: (kind: ThreadActionKind) => void;
  /** Phone second row: smaller secondary. */
  compact?: boolean;
}) {
  const p = plan.primary;
  if (!p) return null;
  const isTake = p.kind === "take";
  return (
    <div className="flex shrink-0 items-center gap-2">
      {plan.secondary ? (
        <button type="button" onClick={() => onRequest("dismiss")} disabled={busy} className={`${BTN_SECONDARY} ${compact ? "max-sm:hidden" : ""}`}>
          {plan.secondary.label}
        </button>
      ) : null}
      <button
        type="button"
        onClick={() => onRequest(p.kind)}
        disabled={busy || Boolean(p.disabledReason)}
        title={p.disabledReason ?? undefined}
        aria-describedby={p.disabledReason ? "thread-action-reason" : undefined}
        className={isTake ? BTN_PRIMARY : BTN_SECONDARY}
      >
        {p.label}
      </button>
      {p.disabledReason ? (
        <span id="thread-action-reason" className="sr-only">
          {p.disabledReason}
        </span>
      ) : null}
    </div>
  );
}

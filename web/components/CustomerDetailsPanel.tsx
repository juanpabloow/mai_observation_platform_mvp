"use client";

import { ModeBadge } from "./ModeBadge";
import { formatDateTime, formatAgeShort } from "@/lib/format";
import type { InboxConversationView } from "@/lib/inboxView";

/**
 * The right-column "Customer details" panel. It shows ONLY data that is really in the
 * conversation payload — the conversation identifier (conversation_ref, usually the
 * channel id), origin workflow, owning client, operative status, and first/last
 * interaction times. No extra contact profile (name, contact channels, org, location,
 * counts, tags) is shown: those would need a contacts join (a worker change we
 * deliberately don't make this phase), so nothing is fabricated. Presentational +
 * client-safe; `onClose` (client→client, never a Server→Client prop) closes the
 * desktop column or the mobile drawer.
 */
export function CustomerDetailsPanel({
  view,
  clientName,
  activityWindowHours,
  now,
  onClose,
}: {
  view: InboxConversationView;
  clientName: string;
  activityWindowHours: number;
  now: Date;
  onClose?: () => void;
}) {
  const ref = view.conversationRef;
  const initial = (ref.match(/[a-z0-9]/i)?.[0] ?? "?").toUpperCase();
  const reason = view.escalationDetail ?? view.escalationReasonCode ?? null;

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-line px-4 py-3">
        <h2 className="text-sm font-semibold">Customer details</h2>
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close customer details"
            className="rounded-lg border border-black/10 px-2 py-1 text-xs text-muted transition-colors hover:bg-black/[0.04] hover:text-foreground dark:border-line-strong dark:hover:bg-subtle"
          >
            ✕
          </button>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {/* Identity — avatar initial + the conversation identifier (real). */}
        <div className="flex flex-col items-center gap-2 text-center">
          <span
            aria-hidden
            className="flex size-14 items-center justify-center rounded-full border border-line-strong bg-subtle text-lg font-semibold text-foreground"
          >
            {initial}
          </span>
          <p className="break-all text-sm font-semibold text-foreground">{ref}</p>
          <ModeBadge mode={view.mode} />
        </div>

        <dl className="mt-5 flex flex-col gap-3 text-sm">
          <Field label="Status">
            <span>
              {view.mode === "pending" ? "Needs human attention" : view.mode === "human" ? "Human is handling" : "Bot is handling"}
              {" · "}
              <span className={view.active ? "text-emerald-700 dark:text-emerald-400" : "text-faint"}>
                {view.active ? `Active (≤${activityWindowHours}h)` : "Inactive"}
              </span>
            </span>
          </Field>
          {view.mode === "human" && view.assignedAgentName ? (
            <Field label="Handled by">{view.assignedAgentName}</Field>
          ) : null}
          {view.mode === "pending" ? (
            <Field label="Waiting since">
              {view.pendingSince ? `${formatAgeShort(new Date(view.pendingSince), now)} ago` : "—"}
              {reason ? <span className="mt-0.5 block text-xs text-faint">Reason: {reason}</span> : null}
            </Field>
          ) : null}
          <Field label="Workflow">{view.workflowName ?? "Unknown workflow"}</Field>
          <Field label="Client">{clientName}</Field>
          <Field label="First seen">{formatDateTime(new Date(view.createdAt))}</Field>
          <Field label="Last activity">
            {view.lastMessageAt ? formatDateTime(new Date(view.lastMessageAt)) : "No messages yet"}
          </Field>
        </dl>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-[11px] font-medium uppercase tracking-wider text-faint">{label}</dt>
      <dd className="text-foreground">{children}</dd>
    </div>
  );
}

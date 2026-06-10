"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  deleteConversationRoleAction,
  upsertConversationRoleAction,
} from "@/lib/conversationActions";
import { FieldPicker, type PickedField } from "@/components/FieldPicker";
import type { ConversationRole } from "@worker/db/types.js";

export interface RoleAssignmentView {
  role: ConversationRole;
  label: string;
  required: boolean;
  set: boolean;
  nodeLabel: string | null;
  fieldLabel: string | null;
  jsonPath: string | null;
  example: string | null;
}

export function ConversationSettings({
  workflowId,
  roles,
}: {
  workflowId: string;
  roles: RoleAssignmentView[];
}) {
  const router = useRouter();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [currentRole, setCurrentRole] = useState<ConversationRole | null>(null);
  const [busy, setBusy] = useState(false);

  const requiredRoles = roles.filter((r) => r.required);
  const missingRequired = requiredRoles.filter((r) => !r.set);
  const complete = missingRequired.length === 0;

  const pick = (role: ConversationRole) => {
    setCurrentRole(role);
    setPickerOpen(true);
  };

  const onSelect = async (picked: PickedField) => {
    if (!currentRole) return;
    setPickerOpen(false);
    setBusy(true);
    try {
      await upsertConversationRoleAction({
        workflowId,
        role: currentRole,
        nodeName: picked.nodeName,
        jsonPath: picked.field.jsonPath,
        label: picked.field.label,
        dataType: picked.field.dataType,
      });
      router.refresh();
    } finally {
      setBusy(false);
      setCurrentRole(null);
    }
  };

  const clear = async (role: ConversationRole) => {
    setBusy(true);
    try {
      await deleteConversationRoleAction({ workflowId, role });
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex flex-col gap-4">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold tracking-tight">Conversation mapping</h2>
        <p className="text-sm text-neutral-500">
          Tell the platform how to reconstruct chats from this workflow&rsquo;s
          executions. Requires <strong>conversation id</strong>,{" "}
          <strong>user message</strong>, and <strong>AI response</strong>.
        </p>
      </div>

      <div
        className={`rounded-xl border px-4 py-3 text-sm ${
          complete
            ? "border-green-500/30 bg-green-500/10 text-green-400"
            : "border-amber-500/30 bg-amber-500/10 text-amber-300"
        }`}
      >
        {complete
          ? "✓ Conversation mapping complete — the conversation view can be built from these."
          : `Set the remaining required role${missingRequired.length === 1 ? "" : "s"}: ${missingRequired
              .map((r) => r.label)
              .join(", ")}.`}
      </div>

      <ul className="flex flex-col gap-2">
        {roles.map((r) => (
          <li
            key={r.role}
            className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-black/10 px-4 py-3 dark:border-white/10"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-medium">{r.label}</span>
                <span
                  className={`rounded-full px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${
                    r.required
                      ? "bg-white/10 text-neutral-400"
                      : "bg-white/5 text-neutral-500"
                  }`}
                >
                  {r.required ? "required" : "optional"}
                </span>
              </div>
              {r.set ? (
                <div className="mt-0.5 truncate font-mono text-xs text-neutral-500">
                  {r.nodeLabel} · {r.jsonPath}
                  {r.example ? (
                    <span className="text-neutral-400"> · e.g. {r.example}</span>
                  ) : null}
                </div>
              ) : (
                <div className="mt-0.5 text-xs text-neutral-600">Not set</div>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => pick(r.role)}
                className="rounded-lg border border-black/10 px-3 py-1.5 text-sm transition-colors hover:bg-black/[0.04] disabled:opacity-50 dark:border-white/15 dark:hover:bg-white/[0.06]"
              >
                {r.set ? "Re-pick" : "Pick field"}
              </button>
              {r.set ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => clear(r.role)}
                  className="rounded-lg px-2 py-1.5 text-sm text-neutral-500 transition-colors hover:text-red-400 disabled:opacity-50"
                >
                  Clear
                </button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>

      <FieldPicker
        workflowId={workflowId}
        open={pickerOpen}
        title={`Pick field for ${currentRole ? roles.find((r) => r.role === currentRole)?.label : ""}`}
        onSelect={onSelect}
        onClose={() => setPickerOpen(false)}
      />
    </section>
  );
}

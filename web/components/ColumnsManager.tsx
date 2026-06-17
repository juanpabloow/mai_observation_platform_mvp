"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { addColumnAction, deleteColumnAction } from "@/lib/columnActions";
import { FieldPicker, type PickedField } from "@/components/FieldPicker";

export interface DefinedColumn {
  id: string;
  nodeName: string | null;
  columnLabel: string | null;
  jsonPath: string;
  dataType: string | null;
}

const inputClasses =
  "w-full rounded-lg border border-black/10 bg-white/60 px-3 py-2 text-sm outline-none focus:border-black/30 dark:border-line-strong dark:bg-subtle dark:text-foreground dark:focus:border-line-strong";

export function ColumnsManager({
  workflowId,
  columns,
}: {
  workflowId: string;
  columns: DefinedColumn[];
}) {
  const router = useRouter();

  const [pickerOpen, setPickerOpen] = useState(false);
  // After a field is picked, confirm/edit the column label before saving.
  const [pending, setPending] = useState<PickedField | null>(null);
  const [labelDraft, setLabelDraft] = useState("");
  const [saving, setSaving] = useState(false);

  const onSelect = (picked: PickedField) => {
    setPickerOpen(false);
    setPending(picked);
    setLabelDraft(picked.field.label);
  };

  const save = async () => {
    if (!pending) return;
    setSaving(true);
    try {
      await addColumnAction({
        workflowId,
        nodeName: pending.nodeName,
        jsonPath: pending.field.jsonPath,
        columnLabel: labelDraft.trim() || pending.field.label,
        dataType: pending.field.dataType,
      });
      setPending(null);
      router.refresh();
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    await deleteColumnAction({ workflowId, id });
    router.refresh();
  };

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-black/10 bg-black/[0.02] p-4 dark:border-line dark:bg-card">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
          Custom columns
        </span>
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          className="rounded-lg border border-black/10 px-3 py-1.5 text-sm font-medium transition-colors hover:bg-black/[0.04] dark:border-line-strong dark:hover:bg-subtle"
        >
          + Add column
        </button>
      </div>

      {columns.length === 0 ? (
        <p className="text-sm text-neutral-500">
          No custom columns yet. Add one to surface a field from a node.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {columns.map((col) => (
            <li
              key={col.id}
              className="flex items-center justify-between gap-3 rounded-lg border border-black/5 px-3 py-2 text-sm dark:border-line"
            >
              <span className="min-w-0">
                <span className="font-medium">{col.columnLabel ?? col.jsonPath}</span>
                <span className="ml-2 truncate font-mono text-xs text-neutral-500">
                  {col.nodeName ? `${col.nodeName} · ` : ""}
                  {col.jsonPath}
                </span>
              </span>
              <button
                type="button"
                onClick={() => remove(col.id)}
                className="shrink-0 rounded-md px-2 py-1 text-xs text-neutral-500 transition-colors hover:bg-red-500/10 hover:text-danger"
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}

      <FieldPicker
        workflowId={workflowId}
        open={pickerOpen}
        title="Add column · pick a node"
        onSelect={onSelect}
        onClose={() => setPickerOpen(false)}
      />

      {pending ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setPending(null)}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-black/10 bg-white p-4 shadow-xl dark:border-line-strong dark:bg-neutral-900"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-3 text-sm font-medium">Name this column</h3>
            <dl className="mb-3 flex flex-col gap-1 text-sm">
              <div className="font-mono text-xs text-neutral-500">
                {pending.nodeLabel} · {pending.field.jsonPath}
              </div>
              <div className="font-mono text-xs text-muted">
                e.g. {pending.field.exampleValue}
              </div>
            </dl>
            <input
              type="text"
              autoFocus
              value={labelDraft}
              onChange={(e) => setLabelDraft(e.target.value)}
              className={inputClasses}
            />
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPending(null)}
                className="rounded-lg px-3 py-1.5 text-sm text-neutral-500 hover:text-foreground"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={save}
                disabled={saving}
                className="rounded-lg bg-neutral-200 px-4 py-1.5 text-sm font-medium text-neutral-900 transition-colors hover:bg-white disabled:opacity-50 dark:bg-subtle dark:text-white dark:hover:bg-subtle"
              >
                {saving ? "Saving…" : "Save column"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

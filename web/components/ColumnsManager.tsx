"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  addColumnAction,
  deleteColumnAction,
  getFieldCatalogAction,
} from "@/lib/columnActions";
import type { CatalogField, CatalogNode, FieldCatalog } from "@/lib/fieldCatalog";

export interface DefinedColumn {
  id: string;
  nodeName: string | null;
  columnLabel: string | null;
  jsonPath: string;
  dataType: string | null;
}

type Step = "nodes" | "fields" | "confirm";

const inputClasses =
  "w-full rounded-lg border border-black/10 bg-white/60 px-3 py-2 text-sm outline-none focus:border-black/30 dark:border-white/15 dark:bg-white/[0.04] dark:text-neutral-200 dark:focus:border-white/30";

export function ColumnsManager({
  workflowId,
  columns,
}: {
  workflowId: string;
  columns: DefinedColumn[];
}) {
  const router = useRouter();

  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<FieldCatalog>([]);

  const [step, setStep] = useState<Step>("nodes");
  const [search, setSearch] = useState("");
  const [selectedNode, setSelectedNode] = useState<CatalogNode | null>(null);
  const [selectedField, setSelectedField] = useState<CatalogField | null>(null);
  const [labelDraft, setLabelDraft] = useState("");
  const [saving, setSaving] = useState(false);

  const openDialog = async () => {
    setOpen(true);
    setStep("nodes");
    setSearch("");
    setSelectedNode(null);
    setSelectedField(null);
    setError(null);
    setLoading(true);
    try {
      setCatalog(await getFieldCatalogAction(workflowId));
    } catch {
      setError("Could not load fields for this workflow.");
    } finally {
      setLoading(false);
    }
  };

  const close = () => setOpen(false);

  const chooseNode = (node: CatalogNode) => {
    setSelectedNode(node);
    setStep("fields");
    setSearch("");
  };

  const chooseField = (field: CatalogField) => {
    setSelectedField(field);
    setLabelDraft(field.label);
    setStep("confirm");
  };

  const save = async () => {
    if (!selectedNode || !selectedField) return;
    setSaving(true);
    try {
      await addColumnAction({
        workflowId,
        nodeName: selectedNode.nodeName,
        jsonPath: selectedField.jsonPath,
        columnLabel: labelDraft.trim() || selectedField.label,
        dataType: selectedField.dataType,
      });
      setOpen(false);
      router.refresh();
    } catch {
      setError("Could not save the column.");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    await deleteColumnAction({ workflowId, id });
    router.refresh();
  };

  const q = search.trim().toLowerCase();
  const visibleNodes = q
    ? catalog.filter((n) => n.nodeName.toLowerCase().includes(q))
    : catalog;
  const visibleFields =
    selectedNode &&
    (q
      ? selectedNode.fields.filter(
          (f) =>
            f.label.toLowerCase().includes(q) ||
            f.exampleValue.toLowerCase().includes(q),
        )
      : selectedNode.fields);

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-black/10 bg-black/[0.02] p-4 dark:border-white/10 dark:bg-white/[0.03]">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
          Custom columns
        </span>
        <button
          type="button"
          onClick={openDialog}
          className="rounded-lg border border-black/10 px-3 py-1.5 text-sm font-medium transition-colors hover:bg-black/[0.04] dark:border-white/15 dark:hover:bg-white/[0.06]"
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
              className="flex items-center justify-between gap-3 rounded-lg border border-black/5 px-3 py-2 text-sm dark:border-white/10"
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
                className="shrink-0 rounded-md px-2 py-1 text-xs text-neutral-500 transition-colors hover:bg-red-500/10 hover:text-red-400"
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}

      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={close}
        >
          <div
            className="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-black/10 bg-white shadow-xl dark:border-white/15 dark:bg-neutral-900"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between border-b border-black/10 px-4 py-3 dark:border-white/10">
              <div className="flex items-center gap-2 text-sm">
                {step !== "nodes" ? (
                  <button
                    type="button"
                    onClick={() => {
                      setSearch("");
                      setStep(step === "confirm" ? "fields" : "nodes");
                    }}
                    className="text-neutral-500 hover:text-neutral-300"
                  >
                    &larr; Back
                  </button>
                ) : null}
                <span className="font-medium">
                  {step === "nodes"
                    ? "Add column · pick a node"
                    : step === "fields"
                      ? `Pick a field · ${selectedNode?.nodeName ?? ""}`
                      : "Confirm column"}
                </span>
              </div>
              <button
                type="button"
                onClick={close}
                className="text-neutral-500 hover:text-neutral-300"
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            {/* Body */}
            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
              {error ? <p className="text-sm text-red-400">{error}</p> : null}
              {loading ? (
                <p className="text-sm text-neutral-500">Loading fields…</p>
              ) : step === "nodes" ? (
                <>
                  <input
                    type="search"
                    autoFocus
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search nodes…"
                    className={inputClasses}
                  />
                  {visibleNodes.length === 0 ? (
                    <p className="text-sm text-neutral-500">No nodes found.</p>
                  ) : (
                    <ul className="flex flex-col">
                      {visibleNodes.map((node) => (
                        <li key={node.nodeName}>
                          <button
                            type="button"
                            onClick={() => chooseNode(node)}
                            className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
                          >
                            <span className="truncate font-medium">{node.nodeName}</span>
                            <span className="shrink-0 text-xs text-neutral-500">
                              {node.fields.length} field{node.fields.length === 1 ? "" : "s"}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              ) : step === "fields" ? (
                <>
                  <input
                    type="search"
                    autoFocus
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search fields…"
                    className={inputClasses}
                  />
                  {!visibleFields || visibleFields.length === 0 ? (
                    <p className="text-sm text-neutral-500">
                      No simple fields available for this node.
                    </p>
                  ) : (
                    <ul className="flex flex-col">
                      {visibleFields.map((field) => (
                        <li key={field.jsonPath}>
                          <button
                            type="button"
                            onClick={() => chooseField(field)}
                            className="flex w-full flex-col gap-0.5 rounded-lg px-3 py-2 text-left transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
                          >
                            <span className="truncate text-sm font-medium">{field.label}</span>
                            <span className="truncate font-mono text-xs text-neutral-500">
                              {field.exampleValue}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              ) : selectedField ? (
                <>
                  <dl className="flex flex-col gap-2 text-sm">
                    <div>
                      <dt className="text-xs uppercase tracking-wider text-neutral-500">Node</dt>
                      <dd>{selectedNode?.nodeName}</dd>
                    </div>
                    <div>
                      <dt className="text-xs uppercase tracking-wider text-neutral-500">Path</dt>
                      <dd className="font-mono text-xs">{selectedField.jsonPath}</dd>
                    </div>
                    <div>
                      <dt className="text-xs uppercase tracking-wider text-neutral-500">
                        Example
                      </dt>
                      <dd className="font-mono text-xs text-neutral-400">
                        {selectedField.exampleValue}
                      </dd>
                    </div>
                  </dl>
                  <label className="flex flex-col gap-1">
                    <span className="text-xs uppercase tracking-wider text-neutral-500">
                      Column label
                    </span>
                    <input
                      type="text"
                      autoFocus
                      value={labelDraft}
                      onChange={(e) => setLabelDraft(e.target.value)}
                      className={inputClasses}
                    />
                  </label>
                </>
              ) : null}
            </div>

            {/* Footer */}
            {step === "confirm" ? (
              <div className="flex justify-end gap-2 border-t border-black/10 px-4 py-3 dark:border-white/10">
                <button
                  type="button"
                  onClick={close}
                  className="rounded-lg px-3 py-1.5 text-sm text-neutral-500 hover:text-neutral-300"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={save}
                  disabled={saving}
                  className="rounded-lg bg-neutral-200 px-4 py-1.5 text-sm font-medium text-neutral-900 transition-colors hover:bg-white disabled:opacity-50 dark:bg-white/15 dark:text-white dark:hover:bg-white/25"
                >
                  {saving ? "Saving…" : "Save column"}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

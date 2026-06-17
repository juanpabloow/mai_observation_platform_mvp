"use client";

import { useEffect, useState } from "react";
import { getFieldCatalogAction } from "@/lib/columnActions";
import type { CatalogField, CatalogNode, FieldCatalog } from "@/lib/fieldCatalog";

export interface PickedField {
  /** Stored node_name (real node, or the metadata sentinel). */
  nodeName: string;
  /** Display label for the node (e.g. "Execution metadata"). */
  nodeLabel: string;
  field: CatalogField;
}

const inputClasses =
  "w-full rounded-lg border border-black/10 bg-white/60 px-3 py-2 text-sm outline-none focus:border-black/30 dark:border-line-strong dark:bg-subtle dark:text-foreground dark:focus:border-line-strong";

/**
 * Reusable node → field picker modal. Loads the workflow's field catalog
 * (including the "Execution metadata" pseudo-node) and reports the chosen field
 * via onSelect; the parent decides what to do with it (save a column, set a
 * conversation role, etc.) and controls `open`.
 */
export function FieldPicker({
  workflowId,
  open,
  title,
  onSelect,
  onClose,
}: {
  workflowId: string;
  open: boolean;
  title: string;
  onSelect: (picked: PickedField) => void;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<FieldCatalog>([]);
  const [step, setStep] = useState<"nodes" | "fields">("nodes");
  const [search, setSearch] = useState("");
  const [node, setNode] = useState<CatalogNode | null>(null);

  useEffect(() => {
    if (!open) return;
    setStep("nodes");
    setSearch("");
    setNode(null);
    setError(null);
    setLoading(true);
    let cancelled = false;
    getFieldCatalogAction(workflowId)
      .then((c) => {
        if (!cancelled) setCatalog(c);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load fields for this workflow.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, workflowId]);

  if (!open) return null;

  const q = search.trim().toLowerCase();
  const visibleNodes = q
    ? catalog.filter((n) => n.displayName.toLowerCase().includes(q))
    : catalog;
  const visibleFields = node
    ? q
      ? node.fields.filter(
          (f) =>
            f.label.toLowerCase().includes(q) ||
            f.exampleValue.toLowerCase().includes(q),
        )
      : node.fields
    : [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-black/10 bg-white shadow-xl dark:border-line-strong dark:bg-neutral-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-black/10 px-4 py-3 dark:border-line">
          <div className="flex items-center gap-2 text-sm">
            {step === "fields" ? (
              <button
                type="button"
                onClick={() => {
                  setSearch("");
                  setStep("nodes");
                }}
                className="text-neutral-500 hover:text-foreground"
              >
                &larr; Back
              </button>
            ) : null}
            <span className="font-medium">
              {step === "nodes" ? title : `Pick a field · ${node?.displayName ?? ""}`}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-neutral-500 hover:text-foreground"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
          {error ? <p className="text-sm text-danger">{error}</p> : null}
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
                  {visibleNodes.map((n) => (
                    <li key={n.nodeName}>
                      <button
                        type="button"
                        onClick={() => {
                          setNode(n);
                          setStep("fields");
                          setSearch("");
                        }}
                        className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-black/[0.04] dark:hover:bg-subtle"
                      >
                        <span className="truncate font-medium">{n.displayName}</span>
                        <span className="shrink-0 text-xs text-neutral-500">
                          {n.fields.length} field{n.fields.length === 1 ? "" : "s"}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <>
              <input
                type="search"
                autoFocus
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search fields…"
                className={inputClasses}
              />
              {visibleFields.length === 0 ? (
                <p className="text-sm text-neutral-500">No simple fields available.</p>
              ) : (
                <ul className="flex flex-col">
                  {visibleFields.map((f) => (
                    <li key={f.jsonPath}>
                      <button
                        type="button"
                        onClick={() =>
                          node &&
                          onSelect({
                            nodeName: node.nodeName,
                            nodeLabel: node.displayName,
                            field: f,
                          })
                        }
                        className="flex w-full flex-col gap-0.5 rounded-lg px-3 py-2 text-left transition-colors hover:bg-black/[0.04] dark:hover:bg-subtle"
                      >
                        <span className="truncate text-sm font-medium">{f.label}</span>
                        <span className="truncate font-mono text-xs text-neutral-500">
                          {f.exampleValue}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { addColumnAction, deleteColumnAction, getFieldCatalogAction } from "@/lib/columnActions";
import type { CatalogField, CatalogNode, FieldCatalog } from "@/lib/fieldCatalog";

export interface DefinedColumn {
  id: string;
  nodeName: string | null;
  columnLabel: string | null;
  jsonPath: string;
  dataType: string | null;
}

const MENU_WIDTH = 300;

/**
 * "+ Add column" — a button styled IDENTICALLY to "+ Filter", opening a portal
 * dropdown (same portal pattern) that both ADDS and REMOVES custom columns, so the
 * old always-on management box is gone (the columns live in the table itself).
 *
 * Views (inline, like the Filter menu's multi-step navigation):
 *  - root   → current columns (each with a remove ✕) + the workflow's nodes to add
 *             a column from.
 *  - fields → the picked node's fields.
 *  - name   → confirm/edit the column label, then save.
 *
 * REMOVAL lives in this same menu (recommended over per-header ✕): it keeps the
 * table headers clean and centralizes column management where you add from. Reuses
 * the proven column actions (add/delete are tenant+workflow-scoped server-side).
 */
export function ColumnsMenu({
  workflowId,
  columns,
}: {
  workflowId: string;
  columns: DefinedColumn[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"root" | "fields" | "name">("root");
  const [catalog, setCatalog] = useState<FieldCatalog>([]);
  const [loading, setLoading] = useState(false);
  const [node, setNode] = useState<CatalogNode | null>(null);
  const [field, setField] = useState<CatalogField | null>(null);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  function reset() {
    setOpen(false);
    setView("root");
    setNode(null);
    setField(null);
    setLabel("");
  }

  // Load the field catalog when the menu opens.
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    let cancelled = false;
    getFieldCatalogAction(workflowId)
      .then((c) => !cancelled && setCatalog(c))
      .catch(() => !cancelled && setCatalog([]))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [open, workflowId]);

  // Portal position — fixed / viewport coords + reposition on scroll(capture) +
  // resize, so it isn't clipped by the scrolling table column and tracks the
  // trigger (mirrors FilterMenu under the fixed shell).
  useLayoutEffect(() => {
    if (!open) return;
    const compute = () => {
      const anchor = triggerRef.current;
      if (!anchor) return;
      const r = anchor.getBoundingClientRect();
      const left = Math.min(Math.max(8, r.left), window.innerWidth - MENU_WIDTH - 8);
      setPos({ top: r.bottom + 8, left });
    };
    compute();
    window.addEventListener("resize", compute);
    window.addEventListener("scroll", compute, true);
    return () => {
      window.removeEventListener("resize", compute);
      window.removeEventListener("scroll", compute, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest("[data-columns-trigger]") && !t.closest("[data-columns-portal]")) reset();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") reset();
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function save() {
    if (!node || !field) return;
    setBusy(true);
    try {
      await addColumnAction({
        workflowId,
        nodeName: node.nodeName,
        jsonPath: field.jsonPath,
        columnLabel: label.trim() || field.label,
        dataType: field.dataType,
      });
      reset();
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    try {
      await deleteColumnAction({ workflowId, id });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        data-columns-trigger
        type="button"
        onClick={() => (open ? reset() : setOpen(true))}
        className="inline-flex items-center gap-1.5 rounded-lg border border-black/10 px-3 py-1.5 text-sm font-medium transition-colors hover:bg-black/[0.04] dark:border-line-strong dark:hover:bg-subtle"
        aria-expanded={open}
      >
        <span aria-hidden>＋</span> Add column
      </button>

      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              data-columns-portal
              style={{
                position: "fixed",
                top: pos?.top ?? 0,
                left: pos?.left ?? 0,
                width: MENU_WIDTH,
                visibility: pos ? "visible" : "hidden",
              }}
              className="z-[60] overflow-hidden rounded-xl border border-black/10 bg-white shadow-xl dark:border-line-strong dark:bg-neutral-900"
            >
              {view === "root" ? (
                <div className="flex max-h-80 flex-col overflow-y-auto py-1">
                  {columns.length > 0 ? (
                    <>
                      <GroupLabel>Your columns</GroupLabel>
                      {columns.map((c) => (
                        <div
                          key={c.id}
                          className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm"
                        >
                          <span className="min-w-0 truncate">{c.columnLabel ?? c.jsonPath}</span>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => remove(c.id)}
                            aria-label={`Remove ${c.columnLabel ?? c.jsonPath}`}
                            className="shrink-0 rounded-md px-1.5 py-0.5 text-xs text-neutral-500 transition-colors hover:bg-red-500/10 hover:text-danger disabled:opacity-50"
                          >
                            ✕
                          </button>
                        </div>
                      ))}
                    </>
                  ) : null}

                  <GroupLabel>Add from a node</GroupLabel>
                  {loading ? (
                    <p className="px-3 py-2 text-xs text-neutral-500">Loading fields…</p>
                  ) : catalog.length === 0 ? (
                    <p className="px-3 py-2 text-xs text-neutral-500">No fields available yet.</p>
                  ) : (
                    catalog.map((n) => (
                      <FieldButton
                        key={n.nodeName}
                        onClick={() => {
                          setNode(n);
                          setView("fields");
                        }}
                      >
                        <span className="truncate">{n.displayName}</span>
                        <span className="shrink-0 text-xs text-neutral-500">
                          {n.fields.length}
                        </span>
                      </FieldButton>
                    ))
                  )}
                </div>
              ) : view === "fields" ? (
                <div className="flex max-h-80 flex-col overflow-y-auto py-1">
                  <BackButton onClick={() => setView("root")} />
                  <GroupLabel>{node?.displayName ?? "Fields"}</GroupLabel>
                  {node && node.fields.length > 0 ? (
                    node.fields.map((f) => (
                      <button
                        key={f.jsonPath}
                        type="button"
                        onClick={() => {
                          setField(f);
                          setLabel(f.label);
                          setView("name");
                        }}
                        className="flex flex-col gap-0.5 px-3 py-1.5 text-left transition-colors hover:bg-black/[0.04] dark:hover:bg-subtle"
                      >
                        <span className="truncate text-sm font-medium">{f.label}</span>
                        <span className="truncate font-mono text-xs text-neutral-500">
                          {f.exampleValue}
                        </span>
                      </button>
                    ))
                  ) : (
                    <p className="px-3 py-2 text-xs text-neutral-500">No simple fields.</p>
                  )}
                </div>
              ) : (
                <div className="flex flex-col gap-3 p-3">
                  <BackButton onClick={() => setView("fields")} />
                  <div className="font-mono text-xs text-neutral-500">
                    {node?.displayName} · {field?.jsonPath}
                  </div>
                  <label className="flex flex-col gap-1 text-xs text-neutral-500">
                    Column name
                    <input
                      autoFocus
                      value={label}
                      onChange={(e) => setLabel(e.target.value)}
                      className="w-full rounded-lg border border-black/10 bg-transparent px-2.5 py-1.5 text-sm outline-none focus:border-black/30 dark:border-line-strong dark:focus:border-line-strong"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={save}
                    disabled={busy}
                    className="self-start rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
                  >
                    {busy ? "Saving…" : "Add column"}
                  </button>
                </div>
              )}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-3 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-neutral-500">
      {children}
    </p>
  );
}

function FieldButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center justify-between gap-3 px-3 py-1.5 text-left text-sm transition-colors hover:bg-black/[0.04] dark:hover:bg-subtle"
    >
      {children}
    </button>
  );
}

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mx-3 mb-1 mt-1 flex items-center gap-1 self-start text-xs text-neutral-500 transition-colors hover:text-foreground"
    >
      <span aria-hidden>‹</span> Back
    </button>
  );
}

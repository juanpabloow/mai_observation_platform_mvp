"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  assignWorkflowAction,
  createClientAction,
  deleteClientAction,
  renameClientAction,
} from "@/lib/clientActions";

export interface WorkflowItem {
  /** workflows.id (row uuid) — what assignment operates on. */
  id: string;
  n8nWorkflowId: string;
  name: string | null;
  active: boolean | null;
  /** the workflow's ACTUAL client (default client id for loose items). */
  clientId: string;
}

export interface ClientFolderView {
  id: string;
  name: string;
  workflowCount: number;
  workflows: WorkflowItem[];
}

export interface ClientOption {
  id: string;
  name: string;
  isDefault: boolean;
}

const inputClass =
  "w-full rounded-lg border border-black/10 bg-white/60 px-3 py-2 text-sm outline-none focus:border-black/30 dark:border-white/15 dark:bg-white/[0.04] dark:text-neutral-200 dark:focus:border-white/30";

function workflowHref(w: WorkflowItem): string {
  return `/clients/${w.clientId}/workflows/${encodeURIComponent(w.n8nWorkflowId)}/executions`;
}

/** Monogram placeholder for a client logo (CL-3 swaps in the uploaded image). */
function ClientLogo({ name }: { name: string }) {
  const letter = name.trim()[0]?.toUpperCase() ?? "?";
  return (
    <span
      aria-hidden
      className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.06] text-sm font-semibold text-neutral-300"
      title="Logo (coming soon)"
    >
      {letter}
    </span>
  );
}

function FolderIcon({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className="size-4 shrink-0 text-neutral-400" aria-hidden>
      <path
        d={
          open
            ? "M2.5 6.5A1.5 1.5 0 0 1 4 5h3.2l1.3 1.5H16A1.5 1.5 0 0 1 17.5 8H6.2a1.5 1.5 0 0 0-1.4 1L3 14.5V6.5Z"
            : "M2.5 5.5A1.5 1.5 0 0 1 4 4h3.2l1.5 1.6H16A1.5 1.5 0 0 1 17.5 7v7A1.5 1.5 0 0 1 16 15.5H4A1.5 1.5 0 0 1 2.5 14V5.5Z"
        }
        fill="currentColor"
        opacity={open ? 0.9 : 0.7}
      />
    </svg>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={`size-3.5 shrink-0 text-neutral-500 transition-transform ${open ? "rotate-90" : ""}`}
      aria-hidden
    >
      <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ClientsWorkflowsView({
  looseWorkflows,
  folders,
  clientOptions,
}: {
  looseWorkflows: WorkflowItem[];
  folders: ClientFolderView[];
  clientOptions: ClientOption[];
}) {
  const router = useRouter();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Modals
  const [createOpen, setCreateOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<ClientFolderView | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ClientFolderView | null>(null);

  // Close any open ⋯ menu on an outside click.
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest("[data-menu-root]")) setOpenMenu(null);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const assign = async (workflowId: string, clientId: string) => {
    setBusy(true);
    try {
      await assignWorkflowAction({ workflowId, clientId });
      setOpenMenu(null);
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  const move = (
    w: WorkflowItem,
    menuKey: string,
    align: "left" | "right" = "right",
  ) => (
    <div data-menu-root className="relative">
      <button
        type="button"
        onClick={() => setOpenMenu(openMenu === menuKey ? null : menuKey)}
        aria-label="Workflow actions"
        aria-expanded={openMenu === menuKey}
        className="flex size-7 items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-black/[0.05] hover:text-neutral-200 dark:hover:bg-white/[0.08]"
      >
        <span aria-hidden className="text-lg leading-none">⋯</span>
      </button>
      {openMenu === menuKey ? (
        <div
          className={`absolute z-30 mt-1 w-56 overflow-hidden rounded-xl border border-black/10 bg-white shadow-xl dark:border-white/15 dark:bg-neutral-900 ${
            align === "right" ? "right-0" : "left-0"
          }`}
        >
          <p className="px-3 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-neutral-500">
            Move to
          </p>
          <div className="max-h-64 overflow-y-auto pb-1">
            {clientOptions.map((c) => {
              const current = c.id === w.clientId;
              const label = c.isDefault ? "Unassigned" : c.name;
              return (
                <button
                  key={c.id}
                  type="button"
                  disabled={current || busy}
                  onClick={() => assign(w.id, c.id)}
                  className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm transition-colors hover:bg-black/[0.04] disabled:cursor-default disabled:opacity-100 dark:hover:bg-white/[0.06]"
                >
                  <span className="truncate">{label}</span>
                  {current ? <span aria-hidden className="text-xs text-emerald-400">✓ here</span> : null}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );

  const workflowRow = (w: WorkflowItem, menuKey: string) => (
    <div className="flex items-center justify-between gap-3 px-3 py-2.5 transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.03]">
      <Link href={workflowHref(w)} className="flex min-w-0 flex-1 items-center gap-3">
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${w.active ? "bg-green-400" : "bg-neutral-600"}`}
          title={w.active ? "Active" : "Inactive"}
        />
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium text-neutral-100">
            {w.name ?? w.n8nWorkflowId}
          </span>
          <span className="block truncate font-mono text-xs text-neutral-500">{w.n8nWorkflowId}</span>
        </span>
      </Link>
      {move(w, menuKey)}
    </div>
  );

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-6 py-12">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-2">
          <Link href="/" className="text-sm text-neutral-500 transition-colors hover:text-neutral-300">
            &larr; Overview
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Clients &amp; Workflows</h1>
          <p className="text-sm text-neutral-500">
            Group workflows into clients. Ungrouped workflows are{" "}
            <span className="text-neutral-400">Unassigned</span>.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-500"
        >
          <span aria-hidden>＋</span> New client
        </button>
      </header>

      {/* Unassigned (default client's workflows shown as loose files) */}
      <section className="flex flex-col gap-2">
        <h2 className="px-1 text-[11px] font-medium uppercase tracking-wider text-neutral-500">
          Unassigned · {looseWorkflows.length}
        </h2>
        {looseWorkflows.length === 0 ? (
          <p className="rounded-xl border border-dashed border-black/10 px-4 py-6 text-center text-sm text-neutral-600 dark:border-white/10">
            Nothing unassigned.
          </p>
        ) : (
          <ul className="divide-y divide-black/5 overflow-hidden rounded-2xl border border-black/10 dark:divide-white/5 dark:border-white/10">
            {looseWorkflows.map((w) => (
              <li key={w.id}>{workflowRow(w, `wf:loose:${w.id}`)}</li>
            ))}
          </ul>
        )}
      </section>

      {/* Client folders */}
      <section className="flex flex-col gap-3">
        <h2 className="px-1 text-[11px] font-medium uppercase tracking-wider text-neutral-500">
          Clients · {folders.length}
        </h2>
        {folders.length === 0 ? (
          <p className="rounded-xl border border-dashed border-black/10 px-4 py-6 text-center text-sm text-neutral-600 dark:border-white/10">
            No clients yet. Create one with <span className="text-neutral-400">＋ New client</span>, then
            move workflows into it.
          </p>
        ) : (
          folders.map((folder) => {
            const isOpen = expanded.has(folder.id);
            const menuKey = `client:${folder.id}`;
            return (
              <div
                key={folder.id}
                className="overflow-hidden rounded-2xl border border-black/10 bg-black/[0.02] dark:border-white/10 dark:bg-white/[0.03]"
              >
                <div className="flex items-center gap-2 px-3 py-2.5">
                  <button
                    type="button"
                    onClick={() => toggle(folder.id)}
                    aria-expanded={isOpen}
                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
                  >
                    <Chevron open={isOpen} />
                    <ClientLogo name={folder.name} />
                    <FolderIcon open={isOpen} />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-semibold">{folder.name}</span>
                      <span className="block text-xs text-neutral-500">
                        {folder.workflowCount} workflow{folder.workflowCount === 1 ? "" : "s"}
                      </span>
                    </span>
                  </button>

                  {/* Client ⋯ menu: rename / delete (never on the default client) */}
                  <div data-menu-root className="relative">
                    <button
                      type="button"
                      onClick={() => setOpenMenu(openMenu === menuKey ? null : menuKey)}
                      aria-label="Client actions"
                      aria-expanded={openMenu === menuKey}
                      className="flex size-7 items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-black/[0.05] hover:text-neutral-200 dark:hover:bg-white/[0.08]"
                    >
                      <span aria-hidden className="text-lg leading-none">⋯</span>
                    </button>
                    {openMenu === menuKey ? (
                      <div className="absolute right-0 z-30 mt-1 w-44 overflow-hidden rounded-xl border border-black/10 bg-white py-1 shadow-xl dark:border-white/15 dark:bg-neutral-900">
                        <button
                          type="button"
                          onClick={() => {
                            setOpenMenu(null);
                            setRenameTarget(folder);
                          }}
                          className="flex w-full items-center px-3 py-1.5 text-left text-sm transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
                        >
                          Rename
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setOpenMenu(null);
                            setDeleteTarget(folder);
                          }}
                          className="flex w-full items-center px-3 py-1.5 text-left text-sm text-red-400 transition-colors hover:bg-red-500/10"
                        >
                          Delete
                        </button>
                      </div>
                    ) : null}
                  </div>
                </div>

                {isOpen ? (
                  folder.workflows.length === 0 ? (
                    <p className="border-t border-black/5 px-4 py-5 text-center text-sm text-neutral-600 dark:border-white/5">
                      No workflows — assign one via a workflow&rsquo;s ⋯ menu.
                    </p>
                  ) : (
                    <ul className="divide-y divide-black/5 border-t border-black/5 dark:divide-white/5 dark:border-white/5">
                      {folder.workflows.map((w) => (
                        <li key={w.id} className="pl-3">
                          {workflowRow(w, `wf:${folder.id}:${w.id}`)}
                        </li>
                      ))}
                    </ul>
                  )
                ) : null}
              </div>
            );
          })
        )}
      </section>

      {createOpen ? (
        <NameModal
          title="New client"
          confirmLabel="Create client"
          placeholder="e.g. Coca Cola"
          busy={busy}
          onCancel={() => setCreateOpen(false)}
          onSubmit={async (name) => {
            setBusy(true);
            try {
              const res = await createClientAction(name);
              if (res.ok) {
                setCreateOpen(false);
                router.refresh();
              }
              return res;
            } finally {
              setBusy(false);
            }
          }}
        />
      ) : null}

      {renameTarget ? (
        <NameModal
          title="Rename client"
          confirmLabel="Save"
          initialValue={renameTarget.name}
          busy={busy}
          onCancel={() => setRenameTarget(null)}
          onSubmit={async (name) => {
            setBusy(true);
            try {
              const res = await renameClientAction({ clientId: renameTarget.id, name });
              if (res.ok) {
                setRenameTarget(null);
                router.refresh();
              }
              return res;
            } finally {
              setBusy(false);
            }
          }}
        />
      ) : null}

      {deleteTarget ? (
        <ConfirmModal
          title={`Delete "${deleteTarget.name}"?`}
          body={
            deleteTarget.workflowCount > 0
              ? `Its ${deleteTarget.workflowCount} workflow${
                  deleteTarget.workflowCount === 1 ? "" : "s"
                } will move to Unassigned. This can't be undone.`
              : "This client has no workflows. This can't be undone."
          }
          confirmLabel="Delete client"
          busy={busy}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={async () => {
            setBusy(true);
            try {
              await deleteClientAction({ clientId: deleteTarget.id });
              setExpanded((prev) => {
                const next = new Set(prev);
                next.delete(deleteTarget.id);
                return next;
              });
              setDeleteTarget(null);
              router.refresh();
            } finally {
              setBusy(false);
            }
          }}
        />
      ) : null}
    </main>
  );
}

/** Single-field name modal (create / rename), with inline validation error. */
function NameModal({
  title,
  confirmLabel,
  initialValue = "",
  placeholder,
  busy,
  onCancel,
  onSubmit,
}: {
  title: string;
  confirmLabel: string;
  initialValue?: string;
  placeholder?: string;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (name: string) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    const res = await onSubmit(value);
    if (!res.ok) setError(res.error ?? "Something went wrong.");
  };

  return (
    <Backdrop onClose={onCancel}>
      <h3 className="mb-3 text-sm font-medium">{title}</h3>
      <input
        type="text"
        autoFocus
        value={value}
        placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && value.trim() && !busy) submit();
        }}
        className={inputClass}
      />
      {/* CL-3 will add a logo upload field here. */}
      <p className="mt-2 text-xs text-neutral-600">Logo upload coming soon.</p>
      {error ? <p className="mt-2 text-xs text-red-400">{error}</p> : null}
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg px-3 py-1.5 text-sm text-neutral-500 hover:text-neutral-300"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={busy || value.trim() === ""}
          className="rounded-lg bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
        >
          {busy ? "Saving…" : confirmLabel}
        </button>
      </div>
    </Backdrop>
  );
}

function ConfirmModal({
  title,
  body,
  confirmLabel,
  busy,
  onCancel,
  onConfirm,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Backdrop onClose={onCancel}>
      <h3 className="mb-2 text-sm font-medium">{title}</h3>
      <p className="text-sm text-neutral-400">{body}</p>
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg px-3 py-1.5 text-sm text-neutral-500 hover:text-neutral-300"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          className="rounded-lg bg-red-600 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-red-500 disabled:opacity-50"
        >
          {busy ? "Deleting…" : confirmLabel}
        </button>
      </div>
    </Backdrop>
  );
}

function Backdrop({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-black/10 bg-white p-4 shadow-xl dark:border-white/15 dark:bg-neutral-900"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

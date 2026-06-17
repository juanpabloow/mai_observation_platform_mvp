"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  assignWorkflowAction,
  createClientAction,
  deleteClientAction,
  renameClientAction,
  uploadClientLogoAction,
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
  logoUrl: string | null;
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

/**
 * Client logo: the uploaded image (from R2's public URL) when set, else a
 * monogram placeholder. Same square slot either way so the layout is stable.
 */
function ClientLogo({ name, logoUrl }: { name: string; logoUrl: string | null }) {
  if (logoUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- tiny external logo from R2; Next image optimizer not needed
      <img
        src={logoUrl}
        alt=""
        aria-hidden
        className="size-9 shrink-0 rounded-lg border border-white/10 object-cover"
      />
    );
  }
  const letter = name.trim()[0]?.toUpperCase() ?? "?";
  return (
    <span
      aria-hidden
      className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.06] text-sm font-semibold text-neutral-300"
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

/**
 * Dropdown body rendered in a PORTAL to document.body so it escapes the
 * `overflow-hidden` rounded containers (the loose list + folder cards) that
 * would otherwise clip it. Positioned `absolute` in page coordinates anchored to
 * the ⋯ trigger (so it tracks page scroll), flips above the trigger when there's
 * no room below, and sits at z-[60] above every row/card. Marked
 * `data-menu-portal` so the view's outside-click handler treats clicks inside it
 * as "inside the menu".
 */
function PortalMenu({
  anchorRef,
  align = "right",
  width = 224,
  children,
}: {
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  align?: "left" | "right";
  width?: number;
  children: React.ReactNode;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const compute = () => {
      const r = anchor.getBoundingClientRect();
      const menuH = menuRef.current?.offsetHeight ?? 0;
      const gap = 4;
      // Open downward; flip above the trigger if it would overflow the viewport
      // bottom and there's room above.
      let top = r.bottom + gap;
      if (menuH && top + menuH > window.innerHeight - 8 && r.top - gap - menuH > 8) {
        top = r.top - gap - menuH;
      }
      // Right-align the menu to the trigger by default; clamp within the viewport.
      let left = align === "right" ? r.right - width : r.left;
      left = Math.min(Math.max(8, left), window.innerWidth - width - 8);
      setPos({ top: top + window.scrollY, left: left + window.scrollX });
    };
    compute();
    window.addEventListener("resize", compute);
    return () => window.removeEventListener("resize", compute);
  }, [anchorRef, align, width]);

  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={menuRef}
      data-menu-portal
      style={{
        position: "absolute",
        top: pos?.top ?? 0,
        left: pos?.left ?? 0,
        width,
        // Hidden for the first layout pass (before we've measured), so it never
        // flashes at the wrong spot.
        visibility: pos ? "visible" : "hidden",
      }}
      className="z-[60] overflow-hidden rounded-xl border border-black/10 bg-white shadow-xl dark:border-white/15 dark:bg-neutral-900"
    >
      {children}
    </div>,
    document.body,
  );
}

/**
 * A ⋯ trigger button plus its portaled dropdown. Open state is controlled by the
 * parent (so only one menu is open at a time); the button is marked
 * `data-menu-root` so clicking it doesn't count as an outside click.
 */
function RowMenu({
  open,
  onToggle,
  ariaLabel,
  align = "right",
  width = 224,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  ariaLabel: string;
  align?: "left" | "right";
  width?: number;
  children: React.ReactNode;
}) {
  const btnRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        data-menu-root
        onClick={onToggle}
        aria-label={ariaLabel}
        aria-expanded={open}
        className="flex size-7 items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-black/[0.05] hover:text-neutral-200 dark:hover:bg-white/[0.08]"
      >
        <span aria-hidden className="text-lg leading-none">⋯</span>
      </button>
      {open ? (
        <PortalMenu anchorRef={btnRef} align={align} width={width}>
          {children}
        </PortalMenu>
      ) : null}
    </>
  );
}

export function ClientsWorkflowsView({
  looseWorkflows,
  folders,
  clientOptions,
  r2Enabled,
}: {
  looseWorkflows: WorkflowItem[];
  folders: ClientFolderView[];
  clientOptions: ClientOption[];
  /** Whether R2 is configured — gates the logo upload UI (graceful optional). */
  r2Enabled: boolean;
}) {
  const router = useRouter();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Modals
  const [createOpen, setCreateOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<ClientFolderView | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ClientFolderView | null>(null);
  const [logoTarget, setLogoTarget] = useState<ClientFolderView | null>(null);

  // Close any open ⋯ menu on an outside click or Escape. The menu body is
  // portaled to <body> (to escape overflow clipping), so a click inside it lands
  // on [data-menu-portal] rather than the trigger's [data-menu-root] — spare both.
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest("[data-menu-root]") && !t.closest("[data-menu-portal]")) {
        setOpenMenu(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenMenu(null);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
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

  const move = (w: WorkflowItem, menuKey: string) => (
    <RowMenu
      open={openMenu === menuKey}
      onToggle={() => setOpenMenu(openMenu === menuKey ? null : menuKey)}
      ariaLabel="Workflow actions"
      align="right"
      width={224}
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
    </RowMenu>
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
                    <ClientLogo name={folder.name} logoUrl={folder.logoUrl} />
                    <FolderIcon open={isOpen} />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-semibold">{folder.name}</span>
                      <span className="block text-xs text-neutral-500">
                        {folder.workflowCount} workflow{folder.workflowCount === 1 ? "" : "s"}
                      </span>
                    </span>
                  </button>

                  {/* Client ⋯ menu: rename / delete (never on the default client) */}
                  <RowMenu
                    open={openMenu === menuKey}
                    onToggle={() => setOpenMenu(openMenu === menuKey ? null : menuKey)}
                    ariaLabel="Client actions"
                    align="right"
                    width={176}
                  >
                    <div className="py-1">
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
                      {r2Enabled ? (
                        <button
                          type="button"
                          onClick={() => {
                            setOpenMenu(null);
                            setLogoTarget(folder);
                          }}
                          className="flex w-full items-center px-3 py-1.5 text-left text-sm transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
                        >
                          {folder.logoUrl ? "Change logo" : "Add logo"}
                        </button>
                      ) : null}
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
                  </RowMenu>
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
        <CreateClientModal
          r2Enabled={r2Enabled}
          busy={busy}
          onCancel={() => setCreateOpen(false)}
          onDone={() => {
            setCreateOpen(false);
            router.refresh();
          }}
          onCreate={async (name) => {
            setBusy(true);
            try {
              return await createClientAction(name);
            } finally {
              setBusy(false);
            }
          }}
          onUploadLogo={async (clientId, file) => {
            setBusy(true);
            try {
              const fd = new FormData();
              fd.set("clientId", clientId);
              fd.set("logo", file);
              return await uploadClientLogoAction(fd);
            } finally {
              setBusy(false);
            }
          }}
        />
      ) : null}

      {logoTarget ? (
        <LogoModal
          client={logoTarget}
          busy={busy}
          onCancel={() => setLogoTarget(null)}
          onSubmit={async (file) => {
            setBusy(true);
            try {
              const fd = new FormData();
              fd.set("clientId", logoTarget.id);
              fd.set("logo", file);
              const res = await uploadClientLogoAction(fd);
              if (res.ok) {
                setLogoTarget(null);
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

/** Single-field name modal (used for Rename), with inline validation error. */
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

/** MIME types accepted client-side (UX gate). The server re-validates by magic
 * bytes — this is only to give fast feedback and set the file picker's filter. */
const ALLOWED_LOGO_MIME = ["image/png", "image/jpeg", "image/webp"];
const MAX_LOGO_MB = 2;

/**
 * File picker for a logo: a square preview (object URL) + a "Choose image"
 * button. Pre-checks the picked file's type/size for fast feedback (the server
 * is the authoritative validator). Calls onPick(file, error).
 */
function LogoPicker({
  file,
  onPick,
}: {
  file: File | null;
  onPick: (file: File | null, error: string | null) => void;
}) {
  const [preview, setPreview] = useState<string | null>(null);

  useEffect(() => {
    if (!file) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    e.target.value = ""; // allow re-picking the same file later
    if (!f) {
      onPick(null, null);
      return;
    }
    if (!ALLOWED_LOGO_MIME.includes(f.type)) {
      onPick(null, "Use a PNG, JPEG, or WebP image.");
      return;
    }
    if (f.size > MAX_LOGO_MB * 1024 * 1024) {
      onPick(null, `Image too large (max ${MAX_LOGO_MB} MB).`);
      return;
    }
    onPick(f, null);
  };

  return (
    <div className="flex items-center gap-3">
      <span className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-white/10 bg-white/[0.04]">
        {preview ? (
          // eslint-disable-next-line @next/next/no-img-element -- local object-URL preview
          <img src={preview} alt="" className="size-full object-cover" />
        ) : (
          <span aria-hidden className="text-lg text-neutral-600">
            🖼
          </span>
        )}
      </span>
      <label className="cursor-pointer rounded-lg border border-black/10 px-3 py-1.5 text-sm transition-colors hover:bg-black/[0.04] dark:border-white/15 dark:hover:bg-white/[0.06]">
        {file ? "Choose a different image" : "Choose image"}
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={onChange}
        />
      </label>
      {file ? (
        <button
          type="button"
          onClick={() => onPick(null, null)}
          className="text-xs text-neutral-500 transition-colors hover:text-neutral-300"
        >
          Remove
        </button>
      ) : null}
    </div>
  );
}

/**
 * Create-client modal: name (required) + optional logo. Creates the client, then
 * (if a logo was picked and R2 is configured) uploads it in a second step. If the
 * client is created but the logo upload fails, the client still exists — the modal
 * shows that and offers a logo retry (no duplicate client is ever created).
 */
function CreateClientModal({
  r2Enabled,
  busy,
  onCancel,
  onDone,
  onCreate,
  onUploadLogo,
}: {
  r2Enabled: boolean;
  busy: boolean;
  onCancel: () => void;
  onDone: () => void;
  onCreate: (name: string) => Promise<{ ok: boolean; error?: string; clientId?: string }>;
  onUploadLogo: (clientId: string, file: File) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    // Retry path: client already created, only the logo upload failed.
    if (createdId) {
      if (!file) return onDone();
      const up = await onUploadLogo(createdId, file);
      if (!up.ok) return setError(`Logo upload failed: ${up.error}`);
      return onDone();
    }
    if (!name.trim()) return setError("Client name is required.");
    const res = await onCreate(name);
    if (!res.ok || !res.clientId) return setError(res.error ?? "Could not create client.");
    if (!file) return onDone();
    setCreatedId(res.clientId);
    const up = await onUploadLogo(res.clientId, file);
    if (!up.ok) {
      return setError(
        `Client created, but the logo upload failed: ${up.error}. Add one later via the ⋯ menu.`,
      );
    }
    onDone();
  };

  return (
    <Backdrop onClose={createdId ? onDone : onCancel}>
      <h3 className="mb-3 text-sm font-medium">New client</h3>
      <input
        type="text"
        autoFocus
        value={name}
        placeholder="e.g. Coca Cola"
        disabled={!!createdId}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && name.trim() && !busy) submit();
        }}
        className={inputClass}
      />
      <div className="mt-3">
        <p className="mb-1.5 text-xs font-medium text-neutral-400">Logo (optional)</p>
        {r2Enabled ? (
          <>
            <LogoPicker
              file={file}
              onPick={(f, err) => {
                setFile(f);
                setFileError(err);
              }}
            />
            <p className="mt-1.5 text-[11px] text-neutral-600">PNG, JPEG, or WebP · max {MAX_LOGO_MB} MB.</p>
            {fileError ? <p className="mt-1 text-xs text-red-400">{fileError}</p> : null}
          </>
        ) : (
          <p className="text-xs text-neutral-600">
            Logo upload is unavailable (storage not configured).
          </p>
        )}
      </div>
      {error ? <p className="mt-2 text-xs text-red-400">{error}</p> : null}
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onClick={createdId ? onDone : onCancel}
          className="rounded-lg px-3 py-1.5 text-sm text-neutral-500 hover:text-neutral-300"
        >
          {createdId ? "Done" : "Cancel"}
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={busy || (!createdId && name.trim() === "") || !!fileError}
          className="rounded-lg bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
        >
          {busy ? "Saving…" : createdId ? "Retry logo" : "Create client"}
        </button>
      </div>
    </Backdrop>
  );
}

/** Add/replace a client's logo. */
function LogoModal({
  client,
  busy,
  onCancel,
  onSubmit,
}: {
  client: ClientFolderView;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (file: File) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!file) return;
    setError(null);
    const res = await onSubmit(file);
    if (!res.ok) setError(res.error ?? "Upload failed.");
  };

  return (
    <Backdrop onClose={onCancel}>
      <h3 className="mb-1 text-sm font-medium">{client.logoUrl ? "Change logo" : "Add logo"}</h3>
      <p className="mb-3 text-xs text-neutral-500">{client.name}</p>
      <LogoPicker
        file={file}
        onPick={(f, err) => {
          setFile(f);
          setFileError(err);
        }}
      />
      <p className="mt-1.5 text-[11px] text-neutral-600">PNG, JPEG, or WebP · max {MAX_LOGO_MB} MB.</p>
      {fileError ? <p className="mt-1 text-xs text-red-400">{fileError}</p> : null}
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
          disabled={busy || !file || !!fileError}
          className="rounded-lg bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
        >
          {busy ? "Uploading…" : "Save logo"}
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

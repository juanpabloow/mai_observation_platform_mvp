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
  setClientChartColorAction,
  uploadClientLogoAction,
} from "@/lib/clientActions";
import { CHART_COLORS } from "@worker/analytics/chartColors.js";
import cc from "./chartColor.module.css";

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
  /** Chart palette slot chosen for this business, or null (automatic). */
  chartColor: string | null;
  workflowCount: number;
  workflows: WorkflowItem[];
}

export interface ClientOption {
  id: string;
  name: string;
  isDefault: boolean;
}

const inputClass =
  "w-full rounded-lg border border-black/10 bg-white/60 px-3 py-2 text-sm outline-none focus:border-black/30 dark:border-line-strong dark:bg-subtle dark:text-foreground dark:focus:border-line-strong";

function workflowHref(w: WorkflowItem): string {
  return `/clients/${w.clientId}/workflows/${encodeURIComponent(w.n8nWorkflowId)}/executions`;
}

/** A small pill for an ENABLED client module (real state only — never fabricated). */
function ModuleChip({ label }: { label: string }) {
  return (
    <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-400">
      {label}
    </span>
  );
}

/**
 * Client logo: the uploaded image (from R2's public URL) when set, else a
 * monogram placeholder. Same square slot either way so the layout is stable.
 */
function ClientLogo({ name, logoUrl, color = null }: { name: string; logoUrl: string | null; color?: { light: string; dark: string } | null }) {
  if (logoUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- tiny external logo from R2; Next image optimizer not needed
      <img
        src={logoUrl}
        alt=""
        aria-hidden
        className="size-9 shrink-0 rounded-lg border border-line object-cover"
      />
    );
  }
  const letter = name.trim()[0]?.toUpperCase() ?? "?";
  if (color) {
    return (
      <span
        aria-hidden
        className={`${cc.avatar} flex size-9 shrink-0 items-center justify-center rounded-lg text-sm font-semibold text-white`}
        style={{ ["--l" as string]: color.light, ["--d" as string]: color.dark }}
      >
        {letter}
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-line bg-subtle text-sm font-semibold text-foreground"
    >
      {letter}
    </span>
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
      // position:fixed → VIEWPORT coordinates (no scrollY/X). Under the fixed shell
      // the body doesn't scroll; fixed avoids body overflow-hidden clipping, and
      // recomputing on scroll (capture) keeps the menu glued to a trigger in a
      // scrolling region (the folder list scrolls in the content region).
      setPos({ top, left });
    };
    compute();
    window.addEventListener("resize", compute);
    window.addEventListener("scroll", compute, true);
    return () => {
      window.removeEventListener("resize", compute);
      window.removeEventListener("scroll", compute, true);
    };
  }, [anchorRef, align, width]);

  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={menuRef}
      data-menu-portal
      style={{
        position: "fixed",
        top: pos?.top ?? 0,
        left: pos?.left ?? 0,
        width,
        // Hidden for the first layout pass (before we've measured), so it never
        // flashes at the wrong spot.
        visibility: pos ? "visible" : "hidden",
      }}
      className="z-[60] overflow-hidden rounded-xl border border-black/10 bg-white shadow-xl dark:border-line-strong dark:bg-neutral-900"
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
        className="flex size-7 items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-black/[0.05] hover:text-foreground dark:hover:bg-subtle"
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
  enabledModules,
  renderDoors,
  renderMeta,
  colorOf,
}: {
  looseWorkflows: WorkflowItem[];
  folders: ClientFolderView[];
  clientOptions: ClientOption[];
  /** Whether R2 is configured — gates the logo upload UI (graceful optional). */
  r2Enabled: boolean;
  /** clientId → ENABLED module keys (crm/scheduling/inbox), for the per-client chips. */
  enabledModules: Record<string, string[]>;
  /** The business's doors (Inbox, dashboard, agenda), right of its name. */
  renderDoors?: (folder: ClientFolderView) => React.ReactNode;
  /** One line under the name (e.g. its executions); defaults to the workflow count. */
  renderMeta?: (folder: ClientFolderView) => React.ReactNode;
  /** The business's chart color (light/dark hex) for its initial when it has no logo. */
  colorOf?: (clientId: string) => { light: string; dark: string } | null;
}) {
  const router = useRouter();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Client-side search over business names + their workflow names/ids.
  const [query, setQuery] = useState("");

  // Modals
  const [createOpen, setCreateOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<ClientFolderView | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ClientFolderView | null>(null);
  const [deleteError, setDeleteError] = useState<React.ReactNode | null>(null);
  const [logoTarget, setLogoTarget] = useState<ClientFolderView | null>(null);
  const [colorTarget, setColorTarget] = useState<ClientFolderView | null>(null);

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
      ariaLabel="Acciones del flujo"
      align="right"
      width={224}
    >
      <p className="px-3 pb-1 pt-2 text-[11px] font-medium text-neutral-500">Mover a</p>
      <div className="max-h-64 overflow-y-auto pb-1">
        {clientOptions.map((c) => {
          const current = c.id === w.clientId;
          const label = c.isDefault ? "Sin negocio" : c.name;
          return (
            <button
              key={c.id}
              type="button"
              disabled={current || busy}
              onClick={() => assign(w.id, c.id)}
              className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm transition-colors hover:bg-black/[0.04] disabled:cursor-default disabled:opacity-100 dark:hover:bg-subtle"
            >
              <span className="truncate">{label}</span>
              {current ? <span aria-hidden className="text-xs text-accent">✓ aquí</span> : null}
            </button>
          );
        })}
      </div>
    </RowMenu>
  );

  const workflowRow = (w: WorkflowItem, menuKey: string) => (
    <div className="flex items-center justify-between gap-3 px-3 py-2.5 transition-colors hover:bg-black/[0.03] dark:hover:bg-card">
      <Link href={workflowHref(w)} className="flex min-w-0 flex-1 items-center gap-3">
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${w.active ? "bg-green-400" : "bg-neutral-600"}`}
          title={w.active ? "Activo" : "Inactivo"}
        />
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium text-foreground">{w.name ?? w.n8nWorkflowId}</span>
          <span className="block truncate font-mono text-xs text-neutral-500">{w.n8nWorkflowId}</span>
        </span>
      </Link>
      {move(w, menuKey)}
    </div>
  );

  const menuItem = "flex w-full items-center px-3 py-1.5 text-left text-sm transition-colors hover:bg-black/[0.04] dark:hover:bg-subtle";

  // ── Client-side search over business names + their workflow names/ids ──
  const q = query.trim().toLowerCase();
  const matchWf = (w: WorkflowItem): boolean =>
    !q || (w.name ?? w.n8nWorkflowId).toLowerCase().includes(q) || w.n8nWorkflowId.toLowerCase().includes(q);
  const visibleLoose = q ? looseWorkflows.filter(matchWf) : looseWorkflows;
  const visibleFolders = q ? folders.filter((f) => f.name.toLowerCase().includes(q) || f.workflows.some(matchWf)) : folders;
  const noResults = q !== "" && visibleFolders.length === 0 && visibleLoose.length === 0;

  return (
    <section aria-labelledby="home-businesses" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="home-businesses" className="m-0 text-[12.5px] font-medium text-muted">
          Tus negocios · {folders.length}
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar negocio o flujo"
            aria-label="Buscar negocio o flujo"
            className="h-9 w-64 max-w-full rounded-[10px] border border-line-strong bg-surface px-3 text-sm outline-none focus:border-foreground/40"
          />
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="inline-flex h-9 items-center gap-1.5 rounded-[10px] border border-line-strong bg-surface px-3 text-sm font-medium transition-colors hover:bg-subtle"
          >
            <span aria-hidden>＋</span> Nuevo negocio
          </button>
        </div>
      </div>

      {noResults ? (
        <p className="rounded-[14px] border border-dashed border-line px-4 py-10 text-center text-sm text-faint">
          Ningún negocio ni workflow coincide con &laquo;{query.trim()}&raquo;.
        </p>
      ) : null}

      {/* Businesses — each with its doors, ⋯ management menu and expandable workflows */}
      {!noResults ? (
        folders.length === 0 ? (
          <p className="rounded-[14px] border border-dashed border-line px-4 py-6 text-center text-sm text-faint">
            Aún no hay negocios. Crea uno con <span className="text-muted">＋ Nuevo negocio</span> y mueve allí sus flujos.
          </p>
        ) : (
          <div className="flex flex-col gap-2.5">
            {visibleFolders.map((folder) => {
              const isOpen = expanded.has(folder.id) || (q !== "" && folder.workflows.some(matchWf) && !folder.name.toLowerCase().includes(q));
              const menuKey = `client:${folder.id}`;
              const moduleKeys = enabledModules[folder.id] ?? [];
              const shownWorkflows = q && !folder.name.toLowerCase().includes(q) ? folder.workflows.filter(matchWf) : folder.workflows;
              return (
                <article key={folder.id} className="overflow-hidden rounded-[14px] border border-line bg-surface">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-3">
                    <button
                      type="button"
                      onClick={() => toggle(folder.id)}
                      aria-expanded={isOpen}
                      aria-label={`${isOpen ? "Ocultar" : "Ver"} flujos de ${folder.name}`}
                      className="flex min-w-0 flex-1 basis-64 items-center gap-3 text-left"
                    >
                      <Chevron open={isOpen} />
                      <ClientLogo name={folder.name} logoUrl={folder.logoUrl} color={colorOf?.(folder.id) ?? null} />
                      <span className="min-w-0">
                        <span className="block truncate text-[15px] font-semibold">{folder.name}</span>
                        <span className="flex flex-wrap items-center gap-1.5">
                          <span className="text-xs text-muted">
                            {renderMeta ? renderMeta(folder) : `${folder.workflowCount} flujo${folder.workflowCount === 1 ? "" : "s"}`}
                          </span>
                          {moduleKeys.includes("crm") ? <ModuleChip label="CRM" /> : null}
                          {moduleKeys.includes("scheduling") ? <ModuleChip label="Agenda" /> : null}
                          {moduleKeys.includes("inbox") ? <ModuleChip label="Inbox" /> : null}
                        </span>
                      </span>
                    </button>

                    <div className="flex items-center gap-1.5">
                      {renderDoors ? renderDoors(folder) : null}

                      {/* Business ⋯ menu — never on the default client (shown apart below). */}
                      <RowMenu
                        open={openMenu === menuKey}
                        onToggle={() => setOpenMenu(openMenu === menuKey ? null : menuKey)}
                        ariaLabel={`Acciones de ${folder.name}`}
                        align="right"
                        width={200}
                      >
                        <div className="py-1">
                          <Link href={`/clients/${folder.id}/modules`} onClick={() => setOpenMenu(null)} className={menuItem}>
                            Módulos
                          </Link>
                          <Link href={`/clients/${folder.id}/team`} onClick={() => setOpenMenu(null)} className={menuItem}>
                            Miembros
                          </Link>
                          <Link href={`/clients/${folder.id}/workflows`} onClick={() => setOpenMenu(null)} className={menuItem}>
                            Workflows
                          </Link>
                          <Link href={`/clients/${folder.id}/costos-ia?vista=ejecuciones`} onClick={() => setOpenMenu(null)} className={menuItem}>
                            Ejecuciones y costos
                          </Link>
                          <div className="my-1 border-t border-line" />
                          <button type="button" onClick={() => { setOpenMenu(null); setRenameTarget(folder); }} className={menuItem}>
                            Renombrar
                          </button>
                          <button type="button" onClick={() => { setOpenMenu(null); setColorTarget(folder); }} className={menuItem}>
                            Color en gráficos
                          </button>
                          {r2Enabled ? (
                            <button type="button" onClick={() => { setOpenMenu(null); setLogoTarget(folder); }} className={menuItem}>
                              {folder.logoUrl ? "Cambiar logo" : "Agregar logo"}
                            </button>
                          ) : null}
                          <button
                            type="button"
                            onClick={() => { setOpenMenu(null); setDeleteTarget(folder); }}
                            className="flex w-full items-center px-3 py-1.5 text-left text-sm text-danger transition-colors hover:bg-red-500/10"
                          >
                            Eliminar
                          </button>
                        </div>
                      </RowMenu>
                    </div>
                  </div>

                  {isOpen ? (
                    shownWorkflows.length === 0 ? (
                      <p className="border-t border-line px-4 py-5 text-center text-sm text-faint">
                        Sin workflows: asígnale uno desde el menú ⋯ de un workflow.
                      </p>
                    ) : (
                      <ul className="divide-y divide-line border-t border-line">
                        {shownWorkflows.map((w) => (
                          <li key={w.id} className="pl-8">
                            {workflowRow(w, `wf:${folder.id}:${w.id}`)}
                          </li>
                        ))}
                      </ul>
                    )
                  ) : null}
                </article>
              );
            })}
          </div>
        )
      ) : null}

      {/* Workflows with no business (the default client's), shown as loose files */}
      {!noResults && (visibleLoose.length > 0 || !q) ? (
        <div className="mt-2 flex flex-col gap-2">
          <h3 className="m-0 text-[12.5px] font-medium text-muted">Flujos sin negocio · {visibleLoose.length}</h3>
          {visibleLoose.length === 0 ? (
            <p className="rounded-[14px] border border-dashed border-line px-4 py-4 text-center text-sm text-faint">Todos los flujos tienen negocio.</p>
          ) : (
            <ul className="divide-y divide-line overflow-hidden rounded-[14px] border border-line bg-surface">
              {visibleLoose.map((w) => (
                <li key={w.id}>{workflowRow(w, `wf:loose:${w.id}`)}</li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

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

      {colorTarget ? (
        <ColorModal
          client={colorTarget}
          busy={busy}
          onCancel={() => setColorTarget(null)}
          onPick={async (slot) => {
            setBusy(true);
            try {
              const res = await setClientChartColorAction({ clientId: colorTarget.id, chartColor: slot });
              if (res.ok) {
                setColorTarget(null);
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
          title="Renombrar negocio"
          confirmLabel="Guardar"
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
          title={`¿Eliminar «${deleteTarget.name}»?`}
          body={
            deleteTarget.workflowCount > 0
              ? `Sus ${deleteTarget.workflowCount} flujo${deleteTarget.workflowCount === 1 ? "" : "s"} quedarán sin negocio. No se puede deshacer.`
              : "Este negocio no tiene flujos. No se puede deshacer."
          }
          confirmLabel="Eliminar negocio"
          busy={busy}
          error={deleteError}
          onCancel={() => {
            setDeleteTarget(null);
            setDeleteError(null);
          }}
          onConfirm={async () => {
            setBusy(true);
            setDeleteError(null);
            try {
              const res = await deleteClientAction({ clientId: deleteTarget.id });
              if (!res.ok && res.result === "has_members") {
                // RBAC: members are scoped to this business — block with a clear,
                // actionable message instead of a DB FK error.
                const n = res.memberCount ?? 0;
                setDeleteError(
                  <>
                    {n === 1 ? "Hay 1 miembro asignado" : `Hay ${n} miembros asignados`} a este negocio. Reasígnalos o quítalos
                    primero en{" "}
                    <Link href="/settings/team" className="underline hover:opacity-80">
                      Equipo
                    </Link>
                    .
                  </>,
                );
                return;
              }
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
    </section>
  );
}

/**
 * Pick the business's color in charts (Costos de IA): one of the validated palette slots, or
 * automatic. Saved on click; the palette is fixed so no business becomes unreadable.
 */
function ColorModal({
  client,
  busy,
  onCancel,
  onPick,
}: {
  client: ClientFolderView;
  busy: boolean;
  onCancel: () => void;
  onPick: (slot: string | null) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [error, setError] = useState<string | null>(null);
  const pick = async (slot: string | null) => {
    if (busy) return;
    setError(null);
    const res = await onPick(slot);
    if (!res.ok) setError(res.error ?? "Algo salió mal.");
  };
  return (
    <Backdrop onClose={onCancel}>
      <h3 className="mb-1 text-sm font-medium">Color en gráficos</h3>
      <p className="mb-4 text-xs text-muted">How «{client.name}» is drawn in Costos de IA. Colors are checked for color blindness and dark mode.</p>
      <div role="radiogroup" aria-label="Color en gráficos" className="grid grid-cols-4 gap-2">
        {CHART_COLORS.map((c) => {
          const on = client.chartColor === c.slot;
          return (
            <button
              key={c.slot}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={busy}
              onClick={() => pick(c.slot)}
              className={`flex flex-col items-center gap-1.5 rounded-xl border px-2 py-2.5 text-xs transition-colors ${
                on ? "border-foreground/60 bg-black/[0.04] dark:bg-subtle" : "border-black/10 hover:bg-black/[0.03] dark:border-line-strong dark:hover:bg-subtle"
              }`}
            >
              <span className={`${cc.sw} h-6 w-6 rounded-md`} style={{ ["--l" as string]: c.light, ["--d" as string]: c.dark }} aria-hidden />
              {c.label}
            </button>
          );
        })}
      </div>
      {error ? <p className="mt-2 text-xs text-danger">{error}</p> : null}
      <div className="mt-4 flex items-center justify-between gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => pick(null)}
          aria-pressed={client.chartColor === null}
          className="rounded-lg px-3 py-1.5 text-sm text-neutral-500 hover:text-foreground"
        >
          {client.chartColor === null ? "Automático (actual)" : "Usar automático"}
        </button>
        <button type="button" onClick={onCancel} className="rounded-lg px-3 py-1.5 text-sm text-neutral-500 hover:text-foreground">
          Close
        </button>
      </div>
    </Backdrop>
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
    if (!res.ok) setError(res.error ?? "Algo salió mal.");
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
      {error ? <p className="mt-2 text-xs text-danger">{error}</p> : null}
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg px-3 py-1.5 text-sm text-neutral-500 hover:text-foreground"
        >
          Cancelar
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={busy || value.trim() === ""}
          className="rounded-lg bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
        >
          {busy ? "Guardando…" : confirmLabel}
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
    // Sync a preview object-URL to the picked file (an external resource that must be
    // created + revoked here); the setPreview calls are intentional for that sync.
    /* eslint-disable react-hooks/set-state-in-effect */
    if (!file) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    /* eslint-enable react-hooks/set-state-in-effect */
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
      onPick(null, "Usa una imagen PNG, JPEG o WebP.");
      return;
    }
    if (f.size > MAX_LOGO_MB * 1024 * 1024) {
      onPick(null, `Imagen demasiado grande (máximo ${MAX_LOGO_MB} MB).`);
      return;
    }
    onPick(f, null);
  };

  return (
    <div className="flex items-center gap-3">
      <span className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-line bg-subtle">
        {preview ? (
          // eslint-disable-next-line @next/next/no-img-element -- local object-URL preview
          <img src={preview} alt="" className="size-full object-cover" />
        ) : (
          <span aria-hidden className="text-lg text-faint">
            🖼
          </span>
        )}
      </span>
      <label className="cursor-pointer rounded-lg border border-black/10 px-3 py-1.5 text-sm transition-colors hover:bg-black/[0.04] dark:border-line-strong dark:hover:bg-subtle">
        {file ? "Elegir otra imagen" : "Elegir imagen"}
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
          className="text-xs text-neutral-500 transition-colors hover:text-foreground"
        >
          Quitar
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
      if (!up.ok) return setError(`No se pudo subir el logo: ${up.error}`);
      return onDone();
    }
    if (!name.trim()) return setError("Escribe el nombre del negocio.");
    const res = await onCreate(name);
    if (!res.ok || !res.clientId) return setError(res.error ?? "No se pudo crear el negocio.");
    if (!file) return onDone();
    setCreatedId(res.clientId);
    const up = await onUploadLogo(res.clientId, file);
    if (!up.ok) {
      return setError(
        `Negocio creado, pero no se pudo subir el logo: ${up.error}. Agrégalo luego desde el menú ⋯.`,
      );
    }
    onDone();
  };

  return (
    <Backdrop onClose={createdId ? onDone : onCancel}>
      <h3 className="mb-3 text-sm font-medium">Nuevo negocio</h3>
      <input
        type="text"
        autoFocus
        value={name}
        placeholder="Nombre del negocio"
        disabled={!!createdId}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && name.trim() && !busy) submit();
        }}
        className={inputClass}
      />
      <div className="mt-3">
        <p className="mb-1.5 text-xs font-medium text-muted">Logo (opcional)</p>
        {r2Enabled ? (
          <>
            <LogoPicker
              file={file}
              onPick={(f, err) => {
                setFile(f);
                setFileError(err);
              }}
            />
            <p className="mt-1.5 text-[11px] text-faint">PNG, JPEG, or WebP · max {MAX_LOGO_MB} MB.</p>
            {fileError ? <p className="mt-1 text-xs text-danger">{fileError}</p> : null}
          </>
        ) : (
          <p className="text-xs text-faint">
            Subir logos no está disponible (falta configurar el almacenamiento).
          </p>
        )}
      </div>
      {error ? <p className="mt-2 text-xs text-danger">{error}</p> : null}
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onClick={createdId ? onDone : onCancel}
          className="rounded-lg px-3 py-1.5 text-sm text-neutral-500 hover:text-foreground"
        >
          {createdId ? "Listo" : "Cancelar"}
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={busy || (!createdId && name.trim() === "") || !!fileError}
          className="rounded-lg bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
        >
          {busy ? "Guardando…" : createdId ? "Reintentar logo" : "Crear negocio"}
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
    if (!res.ok) setError(res.error ?? "No se pudo subir.");
  };

  return (
    <Backdrop onClose={onCancel}>
      <h3 className="mb-1 text-sm font-medium">{client.logoUrl ? "Cambiar logo" : "Agregar logo"}</h3>
      <p className="mb-3 text-xs text-neutral-500">{client.name}</p>
      <LogoPicker
        file={file}
        onPick={(f, err) => {
          setFile(f);
          setFileError(err);
        }}
      />
      <p className="mt-1.5 text-[11px] text-faint">PNG, JPEG, or WebP · max {MAX_LOGO_MB} MB.</p>
      {fileError ? <p className="mt-1 text-xs text-danger">{fileError}</p> : null}
      {error ? <p className="mt-2 text-xs text-danger">{error}</p> : null}
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg px-3 py-1.5 text-sm text-neutral-500 hover:text-foreground"
        >
          Cancelar
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={busy || !file || !!fileError}
          className="rounded-lg bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
        >
          {busy ? "Subiendo…" : "Guardar logo"}
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
  error,
  onCancel,
  onConfirm,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  busy: boolean;
  error?: React.ReactNode | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Backdrop onClose={onCancel}>
      <h3 className="mb-2 text-sm font-medium">{title}</h3>
      <p className="text-sm text-muted">{body}</p>
      {error ? (
        <p className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
          {error}
        </p>
      ) : null}
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg px-3 py-1.5 text-sm text-neutral-500 hover:text-foreground"
        >
          Cancelar
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy || Boolean(error)}
          className="rounded-lg bg-red-600 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-red-500 disabled:opacity-50"
        >
          {busy ? "Eliminando…" : confirmLabel}
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
        className="w-full max-w-md rounded-2xl border border-black/10 bg-white p-4 shadow-xl dark:border-line-strong dark:bg-neutral-900"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
